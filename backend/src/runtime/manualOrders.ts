import { configStore } from "./configStore.js";
import type { ManualTestOrderResult } from "./types.js";
import type { DemoBroker } from "../demo/DemoBroker.js";
import type { EventLogger } from "../logging/EventLogger.js";
import type { PaperBrokerPool } from "../paper/PaperBrokerPool.js";
import type { PaperBroker, PaperView } from "../paper/PaperBroker.js";
import type { RealBroker } from "../real/RealBroker.js";

type RuntimeManualTestOrderArgs = {
  symbol: string;
  side: "LONG" | "SHORT";
  executionModeOverride?: "demo" | "real";
  nowMs: number;
  markPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  maxTradesPerSymbol?: number;
  configOverride?: Partial<{
    marginUSDT: number;
    leverage: number;
    entryOffsetPct: number;
    entryTimeoutSec: number;
    tpRoiPct: number;
    slRoiPct: number;
    rearmDelayMs: number;
    applyFunding: boolean;
    directionMode: "both" | "long" | "short";
  }>;
};

type SubmitRuntimeManualTestOrderDeps = {
  logger: EventLogger | null;
  ensureManualBroker: (executionMode: "paper" | "demo" | "real" | "empty") => void;
  getPaperBroker: () => PaperBrokerPool | PaperBroker | null;
  getDemoBroker: () => DemoBroker | null;
  getRealBroker: () => RealBroker | null;
  getPaperView: (symbol: string, markPrice: number | null) => PaperView;
  evaluateEntryAllowance: (symbol: string, nowMs: number, maxTradesPerSymbol?: number, side?: "LONG" | "SHORT") => { allowed: boolean; reason?: string };
  setRuntimeMessage: (message: string) => void;
};

export async function submitRuntimeManualTestOrder(
  deps: SubmitRuntimeManualTestOrderDeps,
  args: RuntimeManualTestOrderArgs,
): Promise<ManualTestOrderResult> {
  const symbol = String(args.symbol ?? "").trim().toUpperCase();
  const side = args.side === "SHORT" ? "SHORT" : "LONG";
  const nowMs = Number.isFinite(Number(args.nowMs)) ? Number(args.nowMs) : Date.now();
  const executionMode = args.executionModeOverride ?? configStore.get().execution.mode;
  if (executionMode === "empty") {
    const idleView = deps.getPaperView(symbol, Number.isFinite(args.markPrice) ? args.markPrice : null);
    return {
      ok: false,
      accepted: false,
      executionMode,
      symbol,
      side,
      message: "Execution mode is empty. Switch runtime to paper, demo or real first.",
      reason: "execution_mode_empty",
      paperView: idleView,
    };
  }
  deps.ensureManualBroker(executionMode);
  const paperBroker = deps.getPaperBroker();
  const demoBroker = deps.getDemoBroker();
  const realBroker = deps.getRealBroker();
  const idleView = deps.getPaperView(symbol, Number.isFinite(args.markPrice) ? args.markPrice : null);

  const markPrice = Number(args.markPrice);
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    return {
      ok: false,
      accepted: false,
      executionMode,
      symbol,
      side,
      message: "Market price is not ready for this symbol yet.",
      reason: "market_price_not_ready",
      paperView: idleView,
    };
  }

  const directionMode = args.configOverride?.directionMode ?? configStore.get().paper.directionMode;
  if ((directionMode === "long" && side === "SHORT") || (directionMode === "short" && side === "LONG")) {
    deps.logger?.log({
      ts: nowMs,
      type: "MANUAL_TEST_ORDER_REJECTED",
      symbol,
      payload: { side, executionMode, reason: "direction_blocked", directionMode },
    });
    return {
      ok: false,
      accepted: false,
      executionMode,
      symbol,
      side,
      message: `Direction mode ${directionMode} blocks ${side} test orders.`,
      reason: "direction_blocked",
      paperView: idleView,
    };
  }

  deps.logger?.log({
    ts: nowMs,
    type: "MANUAL_TEST_ORDER_REQUEST",
    symbol,
    payload: {
      side,
      executionMode,
      markPrice,
      ...(args.configOverride?.marginUSDT != null ? { marginUSDT: Number(args.configOverride.marginUSDT) } : {}),
      ...(args.configOverride?.leverage != null ? { leverage: Number(args.configOverride.leverage) } : {}),
    },
  });

  const maxTradesPerSymbol = Math.max(1, Math.floor(Number(args.maxTradesPerSymbol) || 1));
  const entryAllowance = deps.evaluateEntryAllowance(symbol, nowMs, maxTradesPerSymbol);
  if (!entryAllowance.allowed) {
    deps.logger?.log({
      ts: nowMs,
      type: "MANUAL_TEST_ORDER_REJECTED",
      symbol,
      payload: { side, executionMode, reason: entryAllowance.reason ?? "risk_limits_blocked", maxTradesPerSymbol },
    });
    return {
      ok: false,
      accepted: false,
      executionMode,
      symbol,
      side,
      message: "Risk limits blocked this manual test order.",
      reason: entryAllowance.reason ?? "risk_limits_blocked",
      paperView: idleView,
    };
  }

  const tickArgs = {
    symbol,
    nowMs,
    markPrice,
    fundingRate: Number.isFinite(Number(args.fundingRate)) ? Number(args.fundingRate) : 0,
    nextFundingTime: Number.isFinite(Number(args.nextFundingTime)) ? Number(args.nextFundingTime) : 0,
    signal: side,
    signalReason: "manual_test_order",
    cooldownActive: false,
    maxTradesPerSymbol,
    ...(args.configOverride ? { configOverride: args.configOverride } : {}),
  } as const;

  const entryPrice = Number(args.entryPrice);
  const tpPrice = Number(args.tpPrice);
  const slPrice = Number(args.slPrice);
  const explicitPricesRequired = executionMode === "demo" || executionMode === "real";
  if (explicitPricesRequired) {
    const explicitPricesValid =
      Number.isFinite(entryPrice)
      && Number.isFinite(tpPrice)
      && Number.isFinite(slPrice)
      && entryPrice > 0
      && tpPrice > 0
      && slPrice > 0;
    if (!explicitPricesValid) {
      return {
        ok: false,
        accepted: false,
        executionMode,
        symbol,
        side,
        message: `${executionMode === "demo" ? "Demo" : "Real"} manual order requires explicit entry, take profit and stop loss prices.`,
        reason: `${executionMode}_manual_prices_required`,
        paperView: idleView,
      };
    }
    const levelsValid = side === "LONG"
      ? tpPrice > entryPrice && slPrice < entryPrice
      : tpPrice < entryPrice && slPrice > entryPrice;
    if (!levelsValid) {
      return {
        ok: false,
        accepted: false,
        executionMode,
        symbol,
        side,
        message: side === "LONG"
          ? "LONG manual order requires TP above entry and SL below entry."
          : "SHORT manual order requires TP below entry and SL above entry.",
        reason: "manual_order_invalid_levels",
        paperView: idleView,
      };
    }
  }

  let brokerAccepted = false;
  let brokerReason: string | undefined;
  let brokerMessage: string | undefined;
  let brokerRetCode: number | undefined;
  let brokerRetMsg: string | undefined;
  if (executionMode === "demo") {
    if (!demoBroker) {
      return {
        ok: false,
        accepted: false,
        executionMode,
        symbol,
        side,
        message: "Demo broker is not initialized.",
        reason: "demo_broker_not_ready",
        paperView: idleView,
      };
    }
    const brokerResult = await demoBroker.placeManualOrder({
      symbol,
      side,
      nowMs,
      entryPrice,
      tpPrice,
      slPrice,
      maxTradesPerSymbol,
      ...(args.configOverride ? { configOverride: args.configOverride as any } : {}),
      reason: "manual_test_order",
    });
    brokerAccepted = brokerResult.accepted;
    brokerReason = brokerResult.reason;
    brokerMessage = brokerResult.message;
    brokerRetCode = brokerResult.retCode;
    brokerRetMsg = brokerResult.retMsg;
  } else if (executionMode === "real") {
    if (!realBroker) {
      return {
        ok: false,
        accepted: false,
        executionMode,
        symbol,
        side,
        message: "Real broker is not initialized.",
        reason: "real_broker_not_ready",
        paperView: idleView,
      };
    }
    const brokerResult = await realBroker.placeManualOrder({
      symbol,
      side,
      nowMs,
      entryPrice,
      tpPrice,
      slPrice,
      maxTradesPerSymbol,
      ...(args.configOverride ? { configOverride: args.configOverride as any } : {}),
      reason: "manual_test_order",
    });
    brokerAccepted = brokerResult.accepted;
    brokerReason = brokerResult.reason;
    brokerMessage = brokerResult.message;
    brokerRetCode = brokerResult.retCode;
    brokerRetMsg = brokerResult.retMsg;
  } else {
    if (!paperBroker) {
      return {
        ok: false,
        accepted: false,
        executionMode,
        symbol,
        side,
        message: "Paper broker is not initialized.",
        reason: "paper_broker_not_ready",
        paperView: idleView,
      };
    }
    paperBroker.tick(tickArgs);
    brokerAccepted = true;
  }

  const nextView = deps.getPaperView(symbol, markPrice);
  const accepted = brokerAccepted && (executionMode === "demo" || executionMode === "real" || nextView.paperStatus !== "IDLE");
  const fallbackMessage = executionMode === "demo"
    ? (accepted
      ? "Demo order request sent. Check live rows and events after reconcile."
      : "Demo broker rejected the request. Check Events Tail for the exact reason.")
    : executionMode === "real"
      ? (accepted
        ? "Real order request sent. Check live rows and events after broker updates."
        : "Real broker rejected the request. Check Events Tail for the exact reason.")
      : accepted
        ? "Paper order created and is now tracked locally."
        : "Request was sent, but no local order state appeared. Check Events Tail for skip reason.";
  const message = brokerMessage ?? fallbackMessage;

  deps.logger?.log({
    ts: nowMs,
    type: accepted ? "MANUAL_TEST_ORDER_ACCEPTED" : "MANUAL_TEST_ORDER_REJECTED",
    symbol,
    payload: {
      side,
      executionMode,
      paperStatus: nextView.paperStatus,
      maxTradesPerSymbol,
      ...(brokerReason ? { reason: brokerReason } : {}),
      ...(Number.isFinite(Number(brokerRetCode)) ? { retCode: Number(brokerRetCode) } : {}),
      ...(brokerRetMsg ? { retMsg: brokerRetMsg } : {}),
    },
  });
  deps.setRuntimeMessage(message);

  return {
    ok: accepted,
    accepted,
    executionMode,
    symbol,
    side,
    message,
    ...(accepted ? {} : { reason: brokerReason ?? "no_local_state_change" }),
    ...(Number.isFinite(Number(brokerRetCode)) ? { retCode: Number(brokerRetCode) } : {}),
    ...(brokerRetMsg ? { retMsg: brokerRetMsg } : {}),
    paperView: nextView,
  };
}
