import { decimalsFromStep, formatToDecimals, roundDownToStep, roundUpToStep, type LinearInstrumentMeta } from "../../bybit/instrumentsMeta.js";
import type { BybitDemoRestClient } from "../../bybit/BybitDemoRestClient.js";
import type { EventLogger } from "../../logging/EventLogger.js";
import type { PaperBrokerConfig, PaperSide } from "../../paper/PaperBroker.js";
import { applyGlobalRearmCooldown } from "../../runtime/rearmPolicy.js";
import { calcTpSl, compactOrderLinkId } from "../helpers.js";
import type { SymbolState, TickInput } from "../types.js";

type ExecuteDemoSignalOrderDeps = {
  cfg: PaperBrokerConfig;
  logger: EventLogger;
  rest: BybitDemoRestClient;
  runId: string;
  getMarkPrice: ((symbol: string) => number | null) | undefined;
  missingKeysLogged: boolean;
  setMissingKeysLogged: (value: boolean) => void;
  getMissingApiKeysReason: () => string;
  eventType: (suffix: string) => string;
  getState: (symbol: string) => SymbolState;
  getActiveTradesCount: (symbol: string, side?: PaperSide) => number;
  openOrderSymbolsCache: Set<string>;
  missingMetaLogged: Set<string>;
  reserveEntrySlot: (state: SymbolState, side?: PaperSide) => void;
  releaseEntrySlot: (state: SymbolState, side?: PaperSide) => void;
  getMeta: (symbol: string) => Promise<LinearInstrumentMeta | null>;
  ensureLeverageConfigured: (args: TickInput, state: SymbolState) => Promise<boolean>;
  onTickRestError: (args: TickInput, stage: string, err: any, state?: SymbolState) => void;
  isBenignCancelRaceError: (err: any) => boolean;
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

export async function executeDemoSignalOrder(deps: ExecuteDemoSignalOrderDeps, args: TickInput): Promise<boolean> {
  if (!deps.cfg.enabled) return false;
  if (!deps.rest.hasCredentials()) {
    if (!deps.missingKeysLogged) {
      deps.setMissingKeysLogged(true);
      deps.logger.log({ ts: args.nowMs, type: deps.eventType("DISABLED_NO_KEYS"), symbol: args.symbol, payload: { reason: deps.getMissingApiKeysReason() } });
    }
    return false;
  }

  const cfg: PaperBrokerConfig = {
    ...deps.cfg,
    ...(args.configOverride ?? {}),
  };
  const state = deps.getState(args.symbol);
  const maxTradesPerSymbol = Math.max(1, Math.floor(Number(args.maxTradesPerSymbol) || 1));
  if (args.signal) {
    deps.logger.log({
      ts: args.nowMs,
      type: deps.eventType("AUTO_ORDER_EVALUATE"),
      symbol: args.symbol,
      payload: {
        signal: args.signal,
        signalReason: args.signalReason,
        cooldownActive: args.cooldownActive,
        maxTradesPerSymbol,
        markPrice: args.markPrice,
        fundingRate: args.fundingRate,
        nextFundingTime: args.nextFundingTime,
        pendingEntries: state.pendingEntries.length,
        positionOpen: state.positionOpen,
        cooldownUntil: state.cooldownUntil,
      },
    });
  }

  const expiredEntries = state.pendingEntries.filter((entry) => args.nowMs > entry.expiresAt);
  for (const entry of expiredEntries) {
    try {
      await deps.rest.cancelOrderLinear({ symbol: args.symbol, orderLinkId: entry.orderLinkId });
      deps.logger.log({ ts: args.nowMs, type: deps.eventType("ORDER_CANCEL_TIMEOUT"), symbol: args.symbol, payload: { orderLinkId: entry.orderLinkId, result: "cancel_requested" } });
    } catch (err: any) {
      if (deps.isBenignCancelRaceError(err)) {
        deps.logger.log({
          ts: args.nowMs,
          type: deps.eventType("ORDER_CANCEL_TIMEOUT"),
          symbol: args.symbol,
          payload: {
            orderLinkId: entry.orderLinkId,
            result: "already_final",
            ...(Number.isFinite(Number(err?.retCode)) ? { retCode: Number(err.retCode) } : {}),
            ...(err?.retMsg ? { retMsg: String(err.retMsg) } : {}),
          },
        });
      } else {
        deps.onTickRestError(args, "cancel", err, state);
      }
    }
    deps.clearPendingByOrderLinkId(state, entry.orderLinkId);
  }
  if (expiredEntries.length > 0) {
    state.cooldownUntil = applyGlobalRearmCooldown(state.cooldownUntil, args.nowMs);
  }

  if (!args.signal) return false;
  if (args.cooldownActive) {
    deps.logger.log({
      ts: args.nowMs,
      type: deps.eventType("ENTRY_SKIP_COOLDOWN"),
      symbol: args.symbol,
      payload: { reason: "runtime_cooldown_active" },
    });
    deps.logger.log({ ts: args.nowMs, type: deps.eventType("AUTO_ORDER_REJECTED"), symbol: args.symbol, payload: { reason: "runtime_cooldown_active", signal: args.signal, signalReason: args.signalReason } });
    return false;
  }
  if (args.nowMs < state.cooldownUntil) {
    deps.logger.log({
      ts: args.nowMs,
      type: deps.eventType("ENTRY_SKIP_COOLDOWN"),
      symbol: args.symbol,
      payload: {
        reason: "broker_cooldown_active",
        cooldownUntil: state.cooldownUntil,
        remainingMs: Math.max(0, state.cooldownUntil - args.nowMs),
      },
    });
    deps.logger.log({ ts: args.nowMs, type: deps.eventType("AUTO_ORDER_REJECTED"), symbol: args.symbol, payload: { reason: "broker_cooldown_active", signal: args.signal, signalReason: args.signalReason, cooldownUntil: state.cooldownUntil, remainingMs: Math.max(0, state.cooldownUntil - args.nowMs) } });
    return false;
  }

  const activeTradesCount = deps.getActiveTradesCount(args.symbol, args.signal ?? undefined);
  if (activeTradesCount >= maxTradesPerSymbol) {
    deps.logger.log({
      ts: args.nowMs,
      type: "ORDER_SKIPPED",
      symbol: args.symbol,
      payload: {
        reason: "symbol_trade_limit",
        activeTrades: activeTradesCount,
        maxTradesPerSymbol,
        signal: args.signal,
      },
    });
    deps.logger.log({ ts: args.nowMs, type: deps.eventType("AUTO_ORDER_REJECTED"), symbol: args.symbol, payload: { reason: "symbol_trade_limit", signal: args.signal, signalReason: args.signalReason, activeTrades: activeTradesCount, maxTradesPerSymbol } });
    return false;
  }

  if (!state.positionOpen && state.pendingEntries.length === 0 && deps.openOrderSymbolsCache.has(args.symbol)) {
    deps.logger.log({
      ts: args.nowMs,
      type: deps.eventType("ENTRY_SKIP_OPEN_ORDERS"),
      symbol: args.symbol,
      payload: { reason: "server_has_open_orders" },
    });
    deps.logger.log({ ts: args.nowMs, type: deps.eventType("AUTO_ORDER_REJECTED"), symbol: args.symbol, payload: { reason: "server_has_open_orders", signal: args.signal, signalReason: args.signalReason } });
    state.cooldownUntil = applyGlobalRearmCooldown(state.cooldownUntil, args.nowMs);
    return false;
  }

  deps.reserveEntrySlot(state, args.signal);

  const side = args.signal === "LONG" ? "Buy" : "Sell";
  const positionIdx = args.signal === "LONG" ? 1 : 2;
  const offset = cfg.entryOffsetPct / 100;
  const markPrice = Number.isFinite(args.markPrice) ? args.markPrice : (deps.getMarkPrice?.(args.symbol) ?? 0);
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    deps.releaseEntrySlot(state, args.signal);
    deps.logger.log({ ts: args.nowMs, type: deps.eventType("AUTO_ORDER_REJECTED"), symbol: args.symbol, payload: { reason: "invalid_mark_price", signal: args.signal, signalReason: args.signalReason, markPrice } });
    return false;
  }

  let meta: LinearInstrumentMeta | null;
  try {
    meta = await deps.getMeta(args.symbol);
  } catch (err: any) {
    deps.releaseEntrySlot(state, args.signal);
    deps.onTickRestError(args, "getMeta", err, state);
    return false;
  }
  if (!meta) {
    deps.releaseEntrySlot(state, args.signal);
    deps.logger.log({ ts: args.nowMs, type: deps.eventType("AUTO_ORDER_REJECTED"), symbol: args.symbol, payload: { reason: "instrument_meta_unavailable", signal: args.signal, signalReason: args.signalReason } });
    if (!deps.missingMetaLogged.has(args.symbol)) {
      deps.missingMetaLogged.add(args.symbol);
      deps.logger.log({ ts: args.nowMs, type: deps.eventType("META_MISSING"), symbol: args.symbol, payload: { reason: "instrument_meta_unavailable" } });
    }
    return false;
  }

  const leverageReady = await deps.ensureLeverageConfigured(args, state);
  if (!leverageReady) {
    deps.releaseEntrySlot(state, args.signal);
    deps.logger.log({ ts: args.nowMs, type: deps.eventType("AUTO_ORDER_REJECTED"), symbol: args.symbol, payload: { reason: "leverage_setup_failed", signal: args.signal, signalReason: args.signalReason } });
    return false;
  }

  const effectiveLeverage = resolveEffectiveLeverage(cfg, meta);
  const priceRaw = args.signal === "LONG" ? markPrice * (1 - offset) : markPrice * (1 + offset);
  const priceRounded = args.signal === "LONG"
    ? roundDownToStep(priceRaw, meta.tickSize)
    : roundUpToStep(priceRaw, meta.tickSize);
  const notional = cfg.marginUSDT * effectiveLeverage;
  const qtyRaw = notional / Math.max(priceRounded, meta.tickSize);
  const qtyRounded = roundDownToStep(qtyRaw, meta.qtyStep);
  if (qtyRounded < meta.minOrderQty) {
    deps.releaseEntrySlot(state, args.signal);
    state.cooldownUntil = applyGlobalRearmCooldown(state.cooldownUntil, args.nowMs);
    deps.logger.log({
      ts: args.nowMs,
      type: deps.eventType("QTY_TOO_SMALL"),
      symbol: args.symbol,
      payload: { qtyRaw, qtyRounded, minOrderQty: meta.minOrderQty, leverage: effectiveLeverage },
    });
    deps.logger.log({ ts: args.nowMs, type: deps.eventType("AUTO_ORDER_REJECTED"), symbol: args.symbol, payload: { reason: "qty_too_small", signal: args.signal, signalReason: args.signalReason, qtyRaw, qtyRounded, minOrderQty: meta.minOrderQty, leverage: effectiveLeverage } });
    return false;
  }

  const levelsRaw = calcTpSl(priceRounded, args.signal, effectiveLeverage, cfg.tpRoiPct, cfg.slRoiPct);
  const tpRounded = args.signal === "LONG"
    ? roundUpToStep(levelsRaw.tp, meta.tickSize)
    : roundDownToStep(levelsRaw.tp, meta.tickSize);
  const slRounded = args.signal === "LONG"
    ? roundDownToStep(levelsRaw.sl, meta.tickSize)
    : roundUpToStep(levelsRaw.sl, meta.tickSize);
  const qtyDecimals = decimalsFromStep(meta.qtyStep);
  const priceDecimals = decimalsFromStep(meta.tickSize);
  const nextAttempt = state.entryAttempt + 1;
  const orderLinkId = compactOrderLinkId("da", deps.runId, args.symbol, nextAttempt, args.nowMs);
  state.entryAttempt = nextAttempt;
  state.pendingEntries.push({
    orderLinkId,
    side: args.signal,
    qty: qtyRounded,
    entryPrice: priceRounded,
    tpPrice: tpRounded,
    slPrice: slRounded,
    placedAt: args.nowMs,
    expiresAt: args.nowMs + 300_000,
  });
  deps.releaseEntrySlot(state, args.signal);
  deps.refreshExecutionState(state);
  deps.logger.log({
    ts: args.nowMs,
    type: deps.eventType("AUTO_ORDER_REQUESTED"),
    symbol: args.symbol,
    payload: {
      signal: args.signal,
      signalReason: args.signalReason,
      side,
      qty: qtyRounded,
      price: priceRounded,
      tp: tpRounded,
      sl: slRounded,
      orderLinkId,
      maxTradesPerSymbol,
      leverage: effectiveLeverage,
    },
  });

  try {
    await deps.rest.placeOrderLinear({
      symbol: args.symbol,
      side,
      orderType: "Limit",
      qty: formatToDecimals(qtyRounded, qtyDecimals),
      price: formatToDecimals(priceRounded, priceDecimals),
      timeInForce: "GTC",
      takeProfit: formatToDecimals(tpRounded, priceDecimals),
      stopLoss: formatToDecimals(slRounded, priceDecimals),
      positionIdx,
      orderLinkId,
    });
  } catch (err: any) {
    deps.releaseEntrySlot(state, args.signal);
    deps.clearPendingByOrderLinkId(state, orderLinkId);
    deps.onTickRestError(args, "placeOrder", err, state);
    return false;
  }

  deps.logger.log({
    ts: args.nowMs,
    type: deps.eventType("ORDER_PLACE"),
    symbol: args.symbol,
    payload: { side, qty: qtyRounded, price: priceRounded, tp: tpRounded, sl: slRounded, orderLinkId, reason: args.signalReason, leverage: effectiveLeverage },
  });
  state.cooldownUntil = applyGlobalRearmCooldown(state.cooldownUntil, args.nowMs);
  return true;
}
