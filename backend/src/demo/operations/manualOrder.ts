import { decimalsFromStep, formatToDecimals, roundDownToStep, roundUpToStep, type LinearInstrumentMeta } from "../../bybit/instrumentsMeta.js";
import type { EventLogger } from "../../logging/EventLogger.js";
import type { PaperBrokerConfig, PaperBrokerTickConfigOverride, PaperSide } from "../../paper/PaperBroker.js";
import { applyGlobalRearmCooldown } from "../../runtime/rearmPolicy.js";
import { compactOrderLinkId } from "../helpers.js";
import type { ManualBrokerSubmitResult, SymbolState, TickInput } from "../types.js";

type ManualBrokerRestClient = {
  hasCredentials: () => boolean;
  placeOrderLinear: (args: {
    symbol: string;
    side: "Buy" | "Sell";
    orderType: "Limit";
    qty: string;
    price: string;
    timeInForce: "GTC";
    takeProfit: string;
    stopLoss: string;
    positionIdx: 1 | 2;
    orderLinkId: string;
  }) => Promise<unknown>;
};

export type PlaceManualDemoOrderArgs = {
  symbol: string;
  side: PaperSide;
  nowMs: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  maxTradesPerSymbol?: number;
  configOverride?: PaperBrokerTickConfigOverride;
  reason?: string;
};

type PlaceManualBrokerOrderDeps = {
  brokerLabel: "Demo" | "Real";
  cfg: PaperBrokerConfig;
  logger: EventLogger;
  rest: ManualBrokerRestClient;
  runId: string;
  missingKeysLogged: boolean;
  setMissingKeysLogged: (value: boolean) => void;
  getMissingApiKeysReason: () => string;
  eventType: (suffix: string) => string;
  getState: (symbol: string) => SymbolState;
  getActiveTradesCount: (symbol: string, side?: PaperSide) => number;
  reserveEntrySlot: (state: SymbolState, side?: PaperSide) => void;
  releaseEntrySlot: (state: SymbolState, side?: PaperSide) => void;
  getMeta: (symbol: string) => Promise<LinearInstrumentMeta | null>;
  ensureLeverageConfigured: (args: TickInput, state: SymbolState) => Promise<boolean>;
  onTickRestError: (args: TickInput, stage: string, err: any, state?: SymbolState) => void;
  clearPendingByOrderLinkId: (state: SymbolState, orderLinkId: string) => void;
  refreshExecutionState: (state: SymbolState) => void;
};

function resolveEffectiveLeverage(cfg: PaperBrokerConfig, meta: LinearInstrumentMeta): number {
  const desiredLeverage = Math.max(1, Math.floor(Number(cfg.leverage) || 1));
  const maxLeverage = Number(meta.maxLeverage);
  if (Number.isFinite(maxLeverage) && maxLeverage > 0) {
    return Math.max(1, Math.floor(Math.min(desiredLeverage, maxLeverage)));
  }
  return desiredLeverage;
}

export async function placeManualDemoOrder(
  deps: PlaceManualBrokerOrderDeps,
  args: PlaceManualDemoOrderArgs,
): Promise<ManualBrokerSubmitResult> {
  if (!deps.rest.hasCredentials()) {
    if (!deps.missingKeysLogged) {
      deps.setMissingKeysLogged(true);
      deps.logger.log({ ts: args.nowMs, type: deps.eventType("DISABLED_NO_KEYS"), symbol: args.symbol, payload: { reason: deps.getMissingApiKeysReason() } });
    }
    return {
      accepted: false,
      reason: deps.getMissingApiKeysReason(),
      message: `${deps.brokerLabel} API credentials are missing.`,
    };
  }

  const cfg: PaperBrokerConfig = {
    ...deps.cfg,
    ...(args.configOverride ?? {}),
  };
  const symbol = String(args.symbol ?? "").trim().toUpperCase();
  const state = deps.getState(symbol);
  const maxTradesPerSymbol = Math.max(1, Math.floor(Number(args.maxTradesPerSymbol) || 1));
  const activeTradesCount = deps.getActiveTradesCount(symbol, args.side);
  if (!symbol) {
    return {
      accepted: false,
      reason: "symbol_required",
      message: "Symbol is required.",
    };
  }

  if (activeTradesCount >= maxTradesPerSymbol) {
    deps.logger.log({
      ts: args.nowMs,
      type: "ORDER_SKIPPED",
      symbol,
      payload: {
        reason: "symbol_trade_limit",
        activeTrades: activeTradesCount,
        maxTradesPerSymbol,
        signal: args.side,
      },
    });
    return {
      accepted: false,
      reason: "symbol_trade_limit",
      message: `Active trades for ${symbol} already reached the symbol limit (${activeTradesCount}/${maxTradesPerSymbol}).`,
    };
  }

  deps.reserveEntrySlot(state, args.side);

  let meta: LinearInstrumentMeta | null;
  try {
    meta = await deps.getMeta(symbol);
  } catch (err: any) {
    deps.onTickRestError({
      symbol,
      nowMs: args.nowMs,
      markPrice: args.entryPrice,
      fundingRate: 0,
      nextFundingTime: 0,
      signal: args.side,
      signalReason: args.reason ?? "manual_demo_order",
      cooldownActive: false,
    }, "getMeta", err, state);
    deps.releaseEntrySlot(state, args.side);
    return {
      accepted: false,
      reason: "get_meta_failed",
      message: `Failed to load instrument meta for ${symbol}: ${String(err?.retMsg ?? err?.message ?? "unknown error")}`,
      ...(Number.isFinite(Number(err?.retCode)) ? { retCode: Number(err.retCode) } : {}),
      ...(err?.retMsg ? { retMsg: String(err.retMsg) } : {}),
    };
  }
  if (!meta) {
    deps.releaseEntrySlot(state, args.side);
    return {
      accepted: false,
      reason: "instrument_meta_missing",
      message: `Instrument meta for ${symbol} is not available.`,
    };
  }

  const leverageReady = await deps.ensureLeverageConfigured({
    symbol,
    nowMs: args.nowMs,
    markPrice: args.entryPrice,
    fundingRate: 0,
    nextFundingTime: 0,
    signal: args.side,
    signalReason: args.reason ?? "manual_demo_order",
    cooldownActive: false,
    maxTradesPerSymbol,
    ...(args.configOverride ? { configOverride: args.configOverride } : {}),
  }, state);
  if (!leverageReady) {
    deps.releaseEntrySlot(state, args.side);
    return {
      accepted: false,
      reason: "leverage_setup_failed",
      message: `Failed to configure leverage for ${symbol}. Check Events Tail for the exact broker response.`,
    };
  }

  const effectiveLeverage = resolveEffectiveLeverage(cfg, meta);
  const notional = cfg.marginUSDT * effectiveLeverage;
  const qtyDecimals = decimalsFromStep(meta.qtyStep);
  const priceDecimals = decimalsFromStep(meta.tickSize);
  const sideBuySell = args.side === "LONG" ? "Buy" : "Sell";
  const positionIdx = args.side === "LONG" ? 1 : 2;
  const entryRounded = args.side === "LONG"
    ? roundDownToStep(args.entryPrice, meta.tickSize)
    : roundUpToStep(args.entryPrice, meta.tickSize);
  const qtyRaw = notional / Math.max(entryRounded, meta.tickSize);
  const qtyRounded = roundDownToStep(qtyRaw, meta.qtyStep);
  if (qtyRounded < meta.minOrderQty) {
    deps.releaseEntrySlot(state, args.side);
    state.cooldownUntil = applyGlobalRearmCooldown(state.cooldownUntil, args.nowMs);
    deps.logger.log({
      ts: args.nowMs,
      type: deps.eventType("QTY_TOO_SMALL"),
      symbol,
      payload: { qtyRaw, qtyRounded, minOrderQty: meta.minOrderQty, leverage: effectiveLeverage },
    });
    return {
      accepted: false,
      reason: "qty_too_small",
      message: `Calculated quantity ${qtyRounded} is below the minimum order quantity ${meta.minOrderQty} for ${symbol}.`,
    };
  }

  const tpRounded = args.side === "LONG"
    ? roundUpToStep(args.tpPrice, meta.tickSize)
    : roundDownToStep(args.tpPrice, meta.tickSize);
  const slRounded = args.side === "LONG"
    ? roundDownToStep(args.slPrice, meta.tickSize)
    : roundUpToStep(args.slPrice, meta.tickSize);
  const nextAttempt = state.entryAttempt + 1;
  const orderLinkId = compactOrderLinkId("dm", deps.runId, symbol, nextAttempt, args.nowMs);
  state.entryAttempt = nextAttempt;
  state.pendingEntries.push({
    orderLinkId,
    side: args.side,
    qty: qtyRounded,
    entryPrice: entryRounded,
    tpPrice: tpRounded,
    slPrice: slRounded,
    placedAt: args.nowMs,
    expiresAt: args.nowMs + 300_000,
  });
  deps.releaseEntrySlot(state, args.side);
  deps.refreshExecutionState(state);

  try {
    await deps.rest.placeOrderLinear({
      symbol,
      side: sideBuySell,
      orderType: "Limit",
      qty: formatToDecimals(qtyRounded, qtyDecimals),
      price: formatToDecimals(entryRounded, priceDecimals),
      timeInForce: "GTC",
      takeProfit: formatToDecimals(tpRounded, priceDecimals),
      stopLoss: formatToDecimals(slRounded, priceDecimals),
      positionIdx,
      orderLinkId,
    });
  } catch (err: any) {
    deps.releaseEntrySlot(state, args.side);
    deps.clearPendingByOrderLinkId(state, orderLinkId);
    deps.onTickRestError({
      symbol,
      nowMs: args.nowMs,
      markPrice: args.entryPrice,
      fundingRate: 0,
      nextFundingTime: 0,
      signal: args.side,
      signalReason: args.reason ?? "manual_demo_order",
      cooldownActive: false,
    }, "placeOrder", err, state);
    return {
      accepted: false,
      reason: "place_order_failed",
      message: `${deps.brokerLabel} broker rejected the order: ${String(err?.retMsg ?? err?.message ?? "unknown error")}`,
      ...(Number.isFinite(Number(err?.retCode)) ? { retCode: Number(err.retCode) } : {}),
      ...(err?.retMsg ? { retMsg: String(err.retMsg) } : {}),
    };
  }

  deps.logger.log({
    ts: args.nowMs,
    type: deps.eventType("ORDER_PLACE"),
    symbol,
    payload: {
      side: sideBuySell,
      qty: qtyRounded,
      price: entryRounded,
      tp: tpRounded,
      sl: slRounded,
      orderLinkId,
      reason: args.reason ?? "manual_demo_order",
      leverage: effectiveLeverage,
    },
  });
  state.cooldownUntil = applyGlobalRearmCooldown(state.cooldownUntil, args.nowMs);
  return { accepted: true };
}
