import { randomUUID } from "node:crypto";
import { applyGlobalRearmCooldown } from "../runtime/rearmPolicy.js";
import type { EventLogger } from "../logging/EventLogger.js";
import { evaluateLimitFill, evaluateTpSl } from "../execution/executionRules.js";

export type PaperSide = "LONG" | "SHORT";
export type PaperExecutionModel = "closeOnly" | "conservativeOhlc";

export type PaperTickOhlc = {
    open: number;
    high: number;
    low: number;
    close: number;
};

export type PaperBrokerConfig = {
    enabled: boolean;
    directionMode: "both" | "long" | "short";

    marginUSDT: number;
    leverage: number;

    entryOffsetPct: number;
    entryTimeoutSec: number;

    tpRoiPct: number;
    slRoiPct: number;

    makerFeeRate: number;
    applyFunding: boolean;
    executionModel?: PaperExecutionModel;

    rearmDelayMs: number;
    maxDailyLossUSDT: number;
};

export type PaperBrokerTickConfigOverride = Partial<
    Pick<PaperBrokerConfig, "marginUSDT" | "leverage" | "entryOffsetPct" | "entryTimeoutSec" | "tpRoiPct" | "slRoiPct" | "rearmDelayMs" | "applyFunding" | "directionMode">
>;

type EntryOrder = {
    id: string;
    symbol: string;
    side: PaperSide;
    entryPrice: number;
    qty: number;
    leverage: number;
    placedAt: number;
    expiresAt: number;
};

type Position = {
    id: string;
    symbol: string;
    side: PaperSide;
    entryPrice: number;
    qty: number;
    leverage: number;

    tpPrice: number;
    slPrice: number;

    openedAt: number;

    realizedPnl: number;
    feesPaid: number;
    fundingAccrued: number;

    lastFundingAppliedForNextFundingTime: number | null;
    minRoiPct: number;
    maxRoiPct: number;
};

type SymbolState = {
    order: EntryOrder | null;
    position: Position | null;
    executionState: "FLAT" | "OPENING" | "OPEN" | "CLOSING";
    entryAttempt: number;
    cooldownUntil: number;
    totalRealizedPnl: number;
};

export type PaperView = {
    paperStatus: "IDLE" | "ENTRY_PENDING" | "OPEN";
    paperSide: PaperSide | null;

    paperEntryPrice: number | null;
    paperTpPrice: number | null;
    paperSlPrice: number | null;
    paperQty: number | null;

    paperOrderExpiresAt: number | null;

    paperUnrealizedPnl: number | null;
    paperRealizedPnl: number;
};

export type PaperStats = {
    openPositions: number;
    pendingOrders: number;

    closedTrades: number;
    wins: number;
    losses: number;

    netRealized: number;
    feesPaid: number;
    fundingAccrued: number;
};

function clampPositive(n: number, fallback: number) {
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function calcTpSl(entry: number, side: PaperSide, leverage: number, tpRoiPct: number, slRoiPct: number) {
    const tpMove = (tpRoiPct / 100) / leverage;
    const slMove = (slRoiPct / 100) / leverage;

    if (side === "LONG") {
        return { tp: entry * (1 + tpMove), sl: entry * (1 - slMove) };
    }
    return { tp: entry * (1 - tpMove), sl: entry * (1 + slMove) };
}

function fee(notional: number, rate: number) {
    return notional * rate;
}

function calcRoiPct(side: PaperSide, entryPrice: number, markPrice: number, leverage: number): number {
    if (!Number.isFinite(entryPrice) || !Number.isFinite(markPrice) || entryPrice <= 0 || leverage <= 0) return 0;
    if (side === "LONG") return ((markPrice - entryPrice) / entryPrice) * leverage * 100;
    return ((entryPrice - markPrice) / entryPrice) * leverage * 100;
}

function toMskDayKey(ts: number): string {
    const shifted = ts + 3 * 60 * 60 * 1000;
    return new Date(shifted).toISOString().slice(0, 10);
}

function isFiniteOhlc(ohlc?: PaperTickOhlc): ohlc is PaperTickOhlc {
    return Boolean(
        ohlc
        && Number.isFinite(ohlc.open)
        && Number.isFinite(ohlc.high)
        && Number.isFinite(ohlc.low)
        && Number.isFinite(ohlc.close)
    );
}

export class PaperBroker {
    private cfg: PaperBrokerConfig;
    private readonly logger: EventLogger;
    private readonly map = new Map<string, SymbolState>();

    private closedTrades = 0;
    private wins = 0;
    private losses = 0;

    private netRealized = 0;
    private feesPaid = 0;
    private fundingAccrued = 0;
    private currentMskDayKey: string | null = null;
    private readonly runId: string;

    constructor(cfg: PaperBrokerConfig, logger: EventLogger, runId = "run") {
        this.cfg = cfg;
        this.logger = logger;
        this.runId = runId;
    }

    applyConfigForNextTrades(next: Partial<PaperBrokerConfig>) {
        const patch = next ?? {};
        if (typeof patch.enabled === "boolean") this.cfg.enabled = patch.enabled;
        if (patch.directionMode === "both" || patch.directionMode === "long" || patch.directionMode === "short") {
            this.cfg.directionMode = patch.directionMode;
        }
        if (Number.isFinite(patch.marginUSDT) && Number(patch.marginUSDT) > 0) this.cfg.marginUSDT = Number(patch.marginUSDT);
        if (Number.isFinite(patch.leverage) && Number(patch.leverage) >= 1) this.cfg.leverage = Number(patch.leverage);
        if (Number.isFinite(patch.entryOffsetPct) && Number(patch.entryOffsetPct) >= 0) this.cfg.entryOffsetPct = Number(patch.entryOffsetPct);
        if (Number.isFinite(patch.entryTimeoutSec) && Math.floor(Number(patch.entryTimeoutSec)) >= 1) this.cfg.entryTimeoutSec = Math.floor(Number(patch.entryTimeoutSec));
        if (Number.isFinite(patch.tpRoiPct) && Number(patch.tpRoiPct) >= 0) this.cfg.tpRoiPct = Number(patch.tpRoiPct);
        if (Number.isFinite(patch.slRoiPct) && Number(patch.slRoiPct) >= 0) this.cfg.slRoiPct = Number(patch.slRoiPct);
        if (Number.isFinite(patch.rearmDelayMs) && Math.floor(Number(patch.rearmDelayMs)) >= 0) this.cfg.rearmDelayMs = Math.floor(Number(patch.rearmDelayMs));
        if (Number.isFinite(patch.maxDailyLossUSDT) && Number(patch.maxDailyLossUSDT) >= 0) this.cfg.maxDailyLossUSDT = Number(patch.maxDailyLossUSDT);
    }

    private syncRiskDay(nowMs: number) {
        const dayKey = toMskDayKey(nowMs);
        if (this.currentMskDayKey !== dayKey) {
            this.currentMskDayKey = dayKey;
        }
    }

    private isDailyLossLimitReached(): boolean {
        const limit = Number(this.cfg.maxDailyLossUSDT);
        if (!Number.isFinite(limit) || limit <= 0) return false;
        return this.netRealized <= -limit;
    }

    getStats(): PaperStats {
        let openPositions = 0;
        let pendingOrders = 0;

        for (const st of this.map.values()) {
            if (st.position) openPositions += 1;
            if (st.order) pendingOrders += 1;
        }

        return {
            openPositions,
            pendingOrders,
            closedTrades: this.closedTrades,
            wins: this.wins,
            losses: this.losses,
            netRealized: this.netRealized,
            feesPaid: this.feesPaid,
            fundingAccrued: this.fundingAccrued,
        };
    }

    getView(symbol: string, markPrice: number | null): PaperView {
        const st = this.map.get(symbol) ?? {
            order: null,
            position: null,
            executionState: "FLAT" as const,
            entryAttempt: 0,
            cooldownUntil: 0,
            totalRealizedPnl: 0
        };

        if (!this.cfg.enabled) {
            return {
                paperStatus: "IDLE",
                paperSide: null,
                paperEntryPrice: null,
                paperTpPrice: null,
                paperSlPrice: null,
                paperQty: null,
                paperOrderExpiresAt: null,
                paperUnrealizedPnl: null,
                paperRealizedPnl: st.totalRealizedPnl
            };
        }

        if (st.position) {
            st.executionState = "OPEN";
            const p = st.position;
            const unreal =
                markPrice == null
                    ? null
                    : p.side === "LONG"
                        ? (markPrice - p.entryPrice) * p.qty
                        : (p.entryPrice - markPrice) * p.qty;

            return {
                paperStatus: "OPEN",
                paperSide: p.side,
                paperEntryPrice: p.entryPrice,
                paperTpPrice: p.tpPrice,
                paperSlPrice: p.slPrice,
                paperQty: p.qty,
                paperOrderExpiresAt: null,
                paperUnrealizedPnl: unreal,
                paperRealizedPnl: st.totalRealizedPnl
            };
        }

        if (st.order) {
            const o = st.order;
            return {
                paperStatus: "ENTRY_PENDING",
                paperSide: o.side,
                paperEntryPrice: o.entryPrice,
                paperTpPrice: null,
                paperSlPrice: null,
                paperQty: o.qty,
                paperOrderExpiresAt: o.expiresAt,
                paperUnrealizedPnl: null,
                paperRealizedPnl: st.totalRealizedPnl
            };
        }

        return {
            paperStatus: "IDLE",
            paperSide: null,
            paperEntryPrice: null,
            paperTpPrice: null,
            paperSlPrice: null,
            paperQty: null,
            paperOrderExpiresAt: null,
            paperUnrealizedPnl: null,
            paperRealizedPnl: st.totalRealizedPnl
        };
    }

    getActiveTradesCount(symbol: string, side?: PaperSide): number {
        const st = this.map.get(symbol);
        if (!st) return 0;
        let count = 0;
        if (st.order && (!side || st.order.side === side)) count += 1;
        if (st.position && (!side || st.position.side === side)) count += 1;
        return count;
    }

    stopAll(args: {
        nowMs: number;
        symbols: string[];
        getMarkPrice: (symbol: string) => number | null;
        closeOpenPositions?: boolean;
    }) {
        const { nowMs, symbols, getMarkPrice, closeOpenPositions = true } = args;

        const allSymbols = new Set<string>([...symbols, ...this.map.keys()]);

        for (const symbol of allSymbols) {
            const st = this.map.get(symbol) ?? {
                order: null,
                position: null,
                executionState: "FLAT" as const,
                entryAttempt: 0,
                cooldownUntil: 0,
                totalRealizedPnl: 0
            };

            if (st.order) {
                this.logger.log({
                    ts: nowMs,
                    type: "ORDER_CANCELED",
                    symbol,
                    payload: {
                        orderId: st.order.id,
                        side: st.order.side,
                        entryPrice: st.order.entryPrice,
                        qty: st.order.qty
                    }
                });
                st.order = null;
                st.executionState = st.position ? "OPEN" : "FLAT";
            }

            if (st.position) {
                if (closeOpenPositions) {
                    const p = st.position;
                    const mark = getMarkPrice(symbol);
                    const closePrice = Number.isFinite(mark as number) ? (mark as number) : p.entryPrice;

                    const notionalExit = closePrice * p.qty;
                    const exitFee = fee(notionalExit, this.cfg.makerFeeRate);

                    let pnlFromMove = 0;
                    if (p.side === "LONG") pnlFromMove = (closePrice - p.entryPrice) * p.qty;
                    else pnlFromMove = (p.entryPrice - closePrice) * p.qty;

                    p.feesPaid += exitFee;
                    p.realizedPnl += pnlFromMove;
                    p.realizedPnl -= exitFee;

                    st.totalRealizedPnl += p.realizedPnl;

                    this.logger.log({
                        ts: nowMs,
                        type: "POSITION_FORCE_CLOSE",
                        symbol,
                        payload: {
                            side: p.side,
                            entryPrice: p.entryPrice,
                            closePrice,
                            qty: p.qty,
                            pnlFromMove,
                            fundingAccrued: p.fundingAccrued,
                            feesPaid: p.feesPaid,
                            realizedPnl: p.realizedPnl,
                            minRoiPct: p.minRoiPct,
                            maxRoiPct: p.maxRoiPct,
                            closedAt: nowMs
                        }
                    });

                    this.closedTrades += 1;
                    this.netRealized += p.realizedPnl;
                    this.feesPaid += p.feesPaid;
                    this.fundingAccrued += p.fundingAccrued;
                }

                st.position = null;
                st.executionState = "FLAT";
            }

            st.cooldownUntil = nowMs + this.cfg.rearmDelayMs;
            this.map.set(symbol, st);
        }

        this.logger.log({ ts: nowMs, type: "SESSION_STOP", payload: { symbols: Array.from(allSymbols) } });
    }

    tick(input: {
        symbol: string;
        nowMs: number;

        markPrice: number;
        ohlc?: PaperTickOhlc;
        fundingRate: number;
        nextFundingTime: number;

        signal: PaperSide | null;
        signalReason: string;
        cooldownActive: boolean;
        configOverride?: PaperBrokerTickConfigOverride;
    }) {
        if (!this.cfg.enabled) return;

        const { symbol, nowMs, markPrice, ohlc, fundingRate, nextFundingTime, signal, signalReason, cooldownActive } = input;
        const cfg: PaperBrokerConfig = {
            ...this.cfg,
            ...(input.configOverride ?? {}),
        };
        const executionModel: PaperExecutionModel = cfg.executionModel ?? "closeOnly";
        const safeOhlc = executionModel === "conservativeOhlc" && isFiniteOhlc(ohlc) ? ohlc : null;
        const useConservativeOhlc = safeOhlc != null;
        this.syncRiskDay(nowMs);

        const st = this.map.get(symbol) ?? {
            order: null,
            position: null,
            executionState: "FLAT" as const,
            entryAttempt: 0,
            cooldownUntil: 0,
            totalRealizedPnl: 0
        };

        if (st.position) {
            st.executionState = "OPEN";
            const p = st.position;

            if (cfg.applyFunding) {
                const shouldApply =
                    Number.isFinite(nextFundingTime) &&
                    nowMs >= nextFundingTime &&
                    p.lastFundingAppliedForNextFundingTime !== nextFundingTime;

                if (shouldApply) {
                    const notional = markPrice * p.qty;
                    const payment = p.side === "LONG" ? -notional * fundingRate : notional * fundingRate;

                    p.fundingAccrued += payment;
                    p.realizedPnl += payment;
                    p.lastFundingAppliedForNextFundingTime = nextFundingTime;

                    this.logger.log({
                        ts: nowMs,
                        type: "FUNDING_APPLIED",
                        symbol,
                        payload: { side: p.side, fundingRate, notional, payment, nextFundingTime }
                    });
                }
            }

            const roiPct = calcRoiPct(p.side, p.entryPrice, markPrice, p.leverage);
            p.minRoiPct = Math.min(p.minRoiPct, roiPct);
            p.maxRoiPct = Math.max(p.maxRoiPct, roiPct);

            let closeType: "TP" | "SL" | null = null;
            let closePrice: number | null = null;

            const tpSl = evaluateTpSl({
                ohlc: safeOhlc,
                markPrice,
                entryPrice: p.entryPrice,
                tpPrice: p.tpPrice,
                slPrice: p.slPrice,
                side: p.side,
                mode: executionModel,
                tieBreakRule: "worstCase",
            });
            closeType = tpSl.closeType;
            closePrice = tpSl.closePrice;

            if (closeType && closePrice != null) {
                const notionalExit = closePrice * p.qty;
                const exitFee = fee(notionalExit, cfg.makerFeeRate);

                let pnlFromMove = 0;
                if (p.side === "LONG") pnlFromMove = (closePrice - p.entryPrice) * p.qty;
                else pnlFromMove = (p.entryPrice - closePrice) * p.qty;

                p.feesPaid += exitFee;
                p.realizedPnl += pnlFromMove;
                p.realizedPnl -= exitFee;

                st.totalRealizedPnl += p.realizedPnl;

                this.logger.log({
                    ts: nowMs,
                    type: closeType === "TP" ? "POSITION_CLOSE_TP" : "POSITION_CLOSE_SL",
                    symbol,
                    payload: {
                        side: p.side,
                        entryPrice: p.entryPrice,
                        closePrice,
                        qty: p.qty,
                        pnlFromMove,
                        fundingAccrued: p.fundingAccrued,
                        feesPaid: p.feesPaid,
                        realizedPnl: p.realizedPnl,
                        minRoiPct: p.minRoiPct,
                        maxRoiPct: p.maxRoiPct,
                        closedAt: nowMs
                    }
                });

                this.closedTrades += 1;
                if (closeType === "TP") this.wins += 1;
                else this.losses += 1;

                this.netRealized += p.realizedPnl;
                this.feesPaid += p.feesPaid;
                this.fundingAccrued += p.fundingAccrued;

                st.position = null;
                st.executionState = "FLAT";
                st.cooldownUntil = applyGlobalRearmCooldown(st.cooldownUntil, nowMs);
            }

            this.map.set(symbol, st);
            return;
        }

        if (st.order) {
            const o = st.order;

            if (nowMs >= o.expiresAt) {
                this.logger.log({
                    ts: nowMs,
                    type: "ORDER_EXPIRED",
                    symbol,
                    payload: { orderId: o.id, side: o.side, entryPrice: o.entryPrice, qty: o.qty }
                });

                st.order = null;
                st.executionState = "FLAT";
                st.cooldownUntil = applyGlobalRearmCooldown(st.cooldownUntil, nowMs);
                this.map.set(symbol, st);
                return;
            }

            const filled = evaluateLimitFill({
                ohlc: safeOhlc,
                markPrice,
                limitPrice: o.entryPrice,
                side: o.side,
                mode: executionModel,
            });

            if (filled) {
                const notionalEntry = o.entryPrice * o.qty;
                const entryFee = fee(notionalEntry, cfg.makerFeeRate);

                const { tp, sl } = calcTpSl(o.entryPrice, o.side, o.leverage, cfg.tpRoiPct, cfg.slRoiPct);

                const pos: Position = {
                    id: randomUUID(),
                    symbol,
                    side: o.side,
                    entryPrice: o.entryPrice,
                    qty: o.qty,
                    leverage: o.leverage,
                    tpPrice: tp,
                    slPrice: sl,
                    openedAt: nowMs,
                    realizedPnl: 0,
                    feesPaid: entryFee,
                    fundingAccrued: 0,
                    lastFundingAppliedForNextFundingTime: null,
                    minRoiPct: 0,
                    maxRoiPct: 0
                };

                pos.realizedPnl -= entryFee;

                this.logger.log({
                    ts: nowMs,
                    type: "ORDER_FILLED",
                    symbol,
                    payload: { orderId: o.id, side: o.side, entryPrice: o.entryPrice, qty: o.qty, fee: entryFee }
                });

                this.logger.log({
                    ts: nowMs,
                    type: "POSITION_OPEN",
                    symbol,
                    payload: { positionId: pos.id, side: pos.side, entryPrice: pos.entryPrice, qty: pos.qty, tpPrice: pos.tpPrice, slPrice: pos.slPrice }
                });

                st.order = null;
                st.position = pos;
                st.executionState = "OPEN";

                if (useConservativeOhlc) {
                    const instantTpSl = evaluateTpSl({
                        ohlc: safeOhlc,
                        markPrice,
                        entryPrice: pos.entryPrice,
                        tpPrice: pos.tpPrice,
                        slPrice: pos.slPrice,
                        side: pos.side,
                        mode: executionModel,
                        tieBreakRule: "worstCase",
                    });
                    if (instantTpSl.closeType && instantTpSl.closePrice != null) {
                        const closeType = instantTpSl.closeType;
                        const closePrice = instantTpSl.closePrice;
                        const notionalExit = closePrice * pos.qty;
                        const exitFee = fee(notionalExit, cfg.makerFeeRate);

                        let pnlFromMove = 0;
                        if (pos.side === "LONG") pnlFromMove = (closePrice - pos.entryPrice) * pos.qty;
                        else pnlFromMove = (pos.entryPrice - closePrice) * pos.qty;

                        pos.feesPaid += exitFee;
                        pos.realizedPnl += pnlFromMove;
                        pos.realizedPnl -= exitFee;
                        st.totalRealizedPnl += pos.realizedPnl;

                        this.logger.log({
                            ts: nowMs,
                            type: closeType === "TP" ? "POSITION_CLOSE_TP" : "POSITION_CLOSE_SL",
                            symbol,
                            payload: {
                                side: pos.side,
                                entryPrice: pos.entryPrice,
                                closePrice,
                                qty: pos.qty,
                                pnlFromMove,
                                fundingAccrued: pos.fundingAccrued,
                                feesPaid: pos.feesPaid,
                                realizedPnl: pos.realizedPnl,
                                minRoiPct: pos.minRoiPct,
                                maxRoiPct: pos.maxRoiPct,
                                closedAt: nowMs
                            }
                        });

                        this.closedTrades += 1;
                        if (closeType === "TP") this.wins += 1;
                        else this.losses += 1;
                        this.netRealized += pos.realizedPnl;
                        this.feesPaid += pos.feesPaid;
                        this.fundingAccrued += pos.fundingAccrued;

                        st.position = null;
                        st.executionState = "FLAT";
                        st.cooldownUntil = applyGlobalRearmCooldown(st.cooldownUntil, nowMs);
                    }
                }

                this.map.set(symbol, st);
                return;
            }

            this.map.set(symbol, st);
            return;
        }

        if (nowMs < st.cooldownUntil) {
            this.map.set(symbol, st);
            return;
        }

        if (cooldownActive) {
            this.map.set(symbol, st);
            return;
        }

        if (!signal) {
            this.map.set(symbol, st);
            return;
        }

        if (st.executionState !== "FLAT") {
            this.logger.log({
                ts: nowMs,
                type: "ORDER_SKIPPED",
                symbol,
                payload: { reason: "symbol_not_flat", signal, executionState: st.executionState }
            });
            this.map.set(symbol, st);
            return;
        }

        if ((cfg.directionMode === "long" && signal === "SHORT") || (cfg.directionMode === "short" && signal === "LONG")) {
            this.logger.log({
                ts: nowMs,
                type: "ORDER_SKIPPED",
                symbol,
                payload: { reason: "direction_blocked", signal, directionMode: cfg.directionMode }
            });
            this.map.set(symbol, st);
            return;
        }

        if (this.isDailyLossLimitReached()) {
            this.logger.log({
                ts: nowMs,
                type: "ORDER_SKIPPED",
                symbol,
                payload: { reason: "risk_daily_loss", signal, maxDailyLossUSDT: this.cfg.maxDailyLossUSDT, netRealized: this.netRealized }
            });
            this.map.set(symbol, st);
            return;
        }

        const margin = clampPositive(cfg.marginUSDT, 10);
        const lev = clampPositive(cfg.leverage, 5);
        const notional = margin * lev;

        const offset = Math.abs(cfg.entryOffsetPct) / 100;
        const entryPrice = signal === "LONG" ? markPrice * (1 - offset) : markPrice * (1 + offset);
        const qty = notional / entryPrice;

        const entryTimeoutMs = Math.max(1, Math.floor(Number(cfg.entryTimeoutSec) || 1)) * 1000;
        const order: EntryOrder = {
            id: `${this.runId}:${symbol}:${st.entryAttempt + 1}`,
            symbol,
            side: signal,
            entryPrice,
            qty,
            leverage: lev,
            placedAt: nowMs,
            expiresAt: nowMs + entryTimeoutMs
        };

        st.order = order;
        st.entryAttempt += 1;
        st.executionState = "OPENING";
        st.cooldownUntil = applyGlobalRearmCooldown(st.cooldownUntil, nowMs);

        this.logger.log({
            ts: nowMs,
            type: "SIGNAL_ACCEPTED",
            symbol,
            payload: { signal, signalReason, markPrice, fundingRate, nextFundingTime, entryOffsetPct: cfg.entryOffsetPct }
        });

        this.logger.log({
            ts: nowMs,
            type: "ORDER_PLACED",
            symbol,
            payload: { orderId: order.id, side: order.side, entryPrice: order.entryPrice, qty: order.qty, expiresAt: order.expiresAt }
        });

        this.map.set(symbol, st);
    }
}
