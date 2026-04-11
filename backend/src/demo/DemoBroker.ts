import { BybitDemoRestClient } from "../bybit/BybitDemoRestClient.js";
import { pickLinearMeta, type LinearInstrumentMeta } from "../bybit/instrumentsMeta.js";
import type { EventLogger } from "../logging/EventLogger.js";
import type { PaperBrokerConfig, PaperBrokerTickConfigOverride, PaperSide, PaperView } from "../paper/PaperBroker.js";
import { applyGlobalRearmCooldown } from "../runtime/rearmPolicy.js";
import { pollDemoClosedPnl } from "./operations/closedPnlPolling.js";
import { readDemoWalletUsdtBalance, startDemoBalancePolling, stopDemoBalancePolling } from "./operations/balance.js";
import { pollDemoExecutions } from "./operations/executionPolling.js";
import { placeManualDemoOrder } from "./operations/manualOrder.js";
import { reconcileDemoBroker } from "./operations/reconcile.js";
import { executeDemoSignalOrder } from "./operations/signalOrder.js";
import { pollDemoTransactionLog } from "./operations/transactionPolling.js";
import type { DemoStats, ManualBrokerSubmitResult, SymbolState, TickInput } from "./types.js";

export type { DemoStats, ManualBrokerSubmitResult } from "./types.js";

export class DemoBroker {
  private cfg: PaperBrokerConfig;
  private readonly logger: EventLogger;
  private readonly rest = new BybitDemoRestClient();
  private readonly map = new Map<string, SymbolState>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private executionsTimer: NodeJS.Timeout | null = null;
  private closedPnlTimer: NodeJS.Timeout | null = null;
  private transactionTimer: NodeJS.Timeout | null = null;
  private reconcileBusy = false;
  private executionsBusy = false;
  private closedPnlBusy = false;
  private transactionBusy = false;
  private missingKeysLogged = false;
  private openOrdersCache: Array<{ symbol: string; orderLinkId: string }> = [];
  private openOrderSymbolsCache = new Set<string>();
  private metaBySymbol = new Map<string, LinearInstrumentMeta>();
  private leverageAppliedBySymbol = new Map<string, number>();
  private leverageMaxBySymbol = new Map<string, number>();
  private readonly leverageFallbackBySymbol = new Map<string, number>([["SIRENUSDT", 5]]);
  private missingMetaLogged = new Set<string>();
  private lastReconcileAtMs = 0;
  private globalOpenOrdersCount = 0;
  private globalOpenPositionsCount = 0;
  private trackedOpenOrdersCount = 0;
  private trackedOpenPositionsCount = 0;
  private lastExecTimeMs: number | null = null;
  private lastClosedPnlTimeMs: number | null = null;
  private lastTransactionTimeMs: number | null = null;
  private execSeenIds = new Set<string>();
  private execSeenQueue: string[] = [];
  private closedPnlSeenIds = new Set<string>();
  private closedPnlSeenQueue: string[] = [];
  private transactionSeenIds = new Set<string>();
  private transactionSeenQueue: string[] = [];
  private demoClosedTradesCount = 0;
  private demoWins = 0;
  private demoLosses = 0;
  private demoRealizedPnlUsdt = 0;
  private demoFeesUsdt = 0;
  private demoFundingUsdt = 0;
  private currentBalanceUsdt: number | null = null;
  private currentBalanceUpdatedAtMs: number | null = null;
  private balancePollTimer: NodeJS.Timeout | null = null;
  private lifecycleToken = 0;
  private running = false;
  private sessionStartedAtMs = 0;
  public sessionStartBalanceUsdt: number | null = null;
  public sessionEndBalanceUsdt: number | null = null;

  constructor(
    cfg: PaperBrokerConfig,
    logger: EventLogger,
    private readonly runId: string,
    private readonly getMarkPrice?: (symbol: string) => number | null,
  ) {
    this.cfg = cfg;
    this.logger = logger;
  }

  protected getEventPrefix(): "DEMO" | "REAL" {
    return "DEMO";
  }

  protected eventType(suffix: string): string {
    return `${this.getEventPrefix()}_${suffix}`;
  }

  protected getMissingApiKeysReason(): string {
    return "missing_demo_api_keys";
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

  protected onTickRestError(args: TickInput, stage: string, err: any, st?: SymbolState) {
    const transientTimeSkew = this.isTimestampSkewError(err);
    this.logger.log({
      ts: args.nowMs,
      type: transientTimeSkew ? this.eventType("ORDER_WARN") : this.eventType("ORDER_ERROR"),
      symbol: args.symbol,
      payload: {
        stage,
        retCode: err?.retCode,
        retMsg: err?.retMsg,
        ...(transientTimeSkew ? { reason: "timestamp_window_transient" } : {}),
      },
    });
    this.logger.log({
      ts: args.nowMs,
      type: this.eventType("AUTO_ORDER_REJECTED"),
      symbol: args.symbol,
      payload: {
        stage,
        signal: args.signal,
        signalReason: args.signalReason,
        retCode: err?.retCode,
        retMsg: err?.retMsg,
        ...(transientTimeSkew ? { reason: "timestamp_window_transient" } : { reason: `broker_${stage}_error` }),
      },
    });
    if (st) {
      if (!transientTimeSkew) {
        st.cooldownUntil = applyGlobalRearmCooldown(st.cooldownUntil, args.nowMs);
      }
      this.refreshExecutionState(st);
    }
  }


  protected isTimestampSkewError(err: any): boolean {
    const retCode = Number(err?.retCode);
    const retMsg = String(err?.retMsg ?? err?.message ?? "").toLowerCase();
    return retCode === 10002
      || retCode === -1
      || retMsg.includes("time exceeds the time window")
      || retMsg.includes("server timestamp")
      || retMsg.includes("recv_window")
      || retMsg.includes("request expired");
  }

  protected isBenignCancelRaceError(err: any): boolean {
    const retCode = Number(err?.retCode);
    const retMsg = String(err?.retMsg ?? err?.message ?? "").toLowerCase();
    return retCode === 110001
      || retMsg.includes("order not exists")
      || retMsg.includes("too late to cancel")
      || retMsg.includes("order does not exist")
      || retMsg.includes("cancel order has been finished")
      || retMsg.includes("order has been filled")
      || retMsg.includes("order has been cancelled");
  }

  protected reserveEntrySlot(st: SymbolState, side?: PaperSide) {
    st.entryReservations = Math.max(0, st.entryReservations) + 1;
    if (side === "LONG" || side === "SHORT") {
      st.entryReservationsBySide[side] = Math.max(0, Number(st.entryReservationsBySide[side]) || 0) + 1;
    }
    this.refreshExecutionState(st);
  }

  protected releaseEntrySlot(st: SymbolState, side?: PaperSide) {
    st.entryReservations = Math.max(0, st.entryReservations - 1);
    if (side === "LONG" || side === "SHORT") {
      st.entryReservationsBySide[side] = Math.max(0, (Number(st.entryReservationsBySide[side]) || 0) - 1);
    }
    this.refreshExecutionState(st);
  }

  private getState(symbol: string): SymbolState {
    const current = this.map.get(symbol);
    if (current) return current;
    const created: SymbolState = {
      positionOpen: false,
      openTradeSlots: 0,
      openTradeSlotsBySide: { LONG: 0, SHORT: 0 },
      entryReservations: 0,
      entryReservationsBySide: { LONG: 0, SHORT: 0 },
      executionState: "FLAT",
      entryAttempt: 0,
      side: null,
      entryPrice: null,
      qty: null,
      tpPrice: null,
      slPrice: null,
      pendingEntries: [],
      cooldownUntil: 0,
      lastServerUnrealizedPnl: null,
      realizedPnl: 0,
      feesPaid: 0,
      fundingAccrued: 0,
    };
    this.map.set(symbol, created);
    return created;
  }

  private refreshExecutionState(st: SymbolState) {
    if ((st.pendingEntries.length > 0 || st.entryReservations > 0) && !st.positionOpen) {
      st.executionState = "OPENING";
      return;
    }
    if (st.positionOpen) {
      st.executionState = "OPEN";
      return;
    }
    st.executionState = "FLAT";
  }

  private clearPendingByOrderLinkId(st: SymbolState, orderLinkId: string) {
    st.pendingEntries = st.pendingEntries.filter((entry) => entry.orderLinkId !== orderLinkId);
    this.refreshExecutionState(st);
  }

  getActiveTradesCount(symbol: string, side?: PaperSide): number {
    const st = this.map.get(symbol);
    if (!st) return 0;
    if (side === "LONG" || side === "SHORT") {
      const openBySide = Math.max(0, Number(st.openTradeSlotsBySide[side]) || 0);
      const pendingBySide = st.pendingEntries.filter((entry) => entry.side === side).length;
      const reservedBySide = Math.max(0, Number(st.entryReservationsBySide[side]) || 0);
      return openBySide + pendingBySide + reservedBySide;
    }
    return Math.max(0, st.openTradeSlots) + st.pendingEntries.length + Math.max(0, st.entryReservations);
  }

  getView(symbol: string, markPrice: number | null): PaperView {
    const st = this.map.get(symbol);
    if (!st || !this.cfg.enabled) {
      return {
        paperStatus: "IDLE",
        paperSide: null,
        paperEntryPrice: null,
        paperTpPrice: null,
        paperSlPrice: null,
        paperQty: null,
        paperOrderExpiresAt: null,
        paperUnrealizedPnl: null,
        paperRealizedPnl: 0,
      };
    }

    if (st.positionOpen) {
      const qty = Number.isFinite(st.qty as number) ? Number(st.qty) : null;
      const entryPrice = Number.isFinite(st.entryPrice as number) ? Number(st.entryPrice) : null;
      const unrealizedPnl = st.lastServerUnrealizedPnl != null
        ? st.lastServerUnrealizedPnl
        : (
          qty != null && entryPrice != null && markPrice != null && Number.isFinite(markPrice) && st.side != null
            ? (st.side === "LONG"
              ? (markPrice - entryPrice) * qty
              : (entryPrice - markPrice) * qty)
            : null
        );
      return {
        paperStatus: "OPEN",
        paperSide: st.side,
        paperEntryPrice: entryPrice,
        paperTpPrice: st.tpPrice,
        paperSlPrice: st.slPrice,
        paperQty: qty,
        paperOrderExpiresAt: null,
        paperUnrealizedPnl: unrealizedPnl,
        paperRealizedPnl: st.realizedPnl,
      };
    }

    if (st.pendingEntries.length > 0) {
      const primary = st.pendingEntries[0]!;
      const totalQty = st.pendingEntries.reduce((sum, entry) => sum + (Number(entry.qty) || 0), 0);
      const expiresAt = Math.max(...st.pendingEntries.map((entry) => Number(entry.expiresAt) || 0));
      const sides = new Set(st.pendingEntries.map((entry) => entry.side));
      const singleSide = sides.size === 1;
      return {
        paperStatus: "ENTRY_PENDING",
        paperSide: singleSide ? primary.side : null,
        paperEntryPrice: singleSide ? primary.entryPrice : null,
        paperTpPrice: singleSide ? primary.tpPrice : null,
        paperSlPrice: singleSide ? primary.slPrice : null,
        paperQty: totalQty > 0 ? totalQty : null,
        paperOrderExpiresAt: expiresAt > 0 ? expiresAt : null,
        paperUnrealizedPnl: null,
        paperRealizedPnl: st.realizedPnl,
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
      paperRealizedPnl: st.realizedPnl,
    };
  }

  private isLeverageInvalidError(err: any): boolean {
    const retCode = Number(err?.retCode);
    const retMsg = String(err?.retMsg ?? "").toLowerCase();
    return retCode === 10001 || retMsg.includes("leverage invalid");
  }

  private async resolveMaxLeverage(symbol: string): Promise<number | null> {
    const cached = this.leverageMaxBySymbol.get(symbol);
    if (Number.isFinite(cached) && cached && cached > 0) return cached;

    const fallback = this.leverageFallbackBySymbol.get(symbol);
    if (Number.isFinite(fallback) && fallback && fallback > 0) {
      this.leverageMaxBySymbol.set(symbol, fallback);
      return fallback;
    }

    try {
      const instruments = await this.rest.getInstrumentsInfoLinear({ symbol });
      const first = Array.isArray(instruments) ? instruments[0] : null;
      const maxLevRaw = Number((first as any)?.leverageFilter?.maxLeverage);
      if (Number.isFinite(maxLevRaw) && maxLevRaw > 0) {
        this.leverageMaxBySymbol.set(symbol, maxLevRaw);
        return maxLevRaw;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async ensureLeverageConfigured(args: TickInput, st: SymbolState): Promise<boolean> {
    const desiredLeverage = Math.max(1, Math.floor(Number(args.configOverride?.leverage ?? this.cfg.leverage) || 1));
    const currentApplied = this.leverageAppliedBySymbol.get(args.symbol);
    if (currentApplied === desiredLeverage) return true;
    try {
      await this.rest.setLeverageLinear({
        symbol: args.symbol,
        buyLeverage: String(desiredLeverage),
        sellLeverage: String(desiredLeverage),
      });
      this.leverageAppliedBySymbol.set(args.symbol, desiredLeverage);
      return true;
    } catch (err: any) {
      if (!this.isLeverageInvalidError(err)) {
        this.onTickRestError(args, "setLeverage", err, st);
        return false;
      }

      const maxLeverage = await this.resolveMaxLeverage(args.symbol);
      const fallbackLeverage = Number.isFinite(maxLeverage) && maxLeverage != null
        ? Math.max(1, Math.floor(Math.min(desiredLeverage, maxLeverage)))
        : null;
      if (!fallbackLeverage || fallbackLeverage === desiredLeverage) {
        this.onTickRestError(args, "setLeverage", err, st);
        return false;
      }

      try {
        await this.rest.setLeverageLinear({
          symbol: args.symbol,
          buyLeverage: String(fallbackLeverage),
          sellLeverage: String(fallbackLeverage),
        });
        if (!this.isRunningLifecycle()) return false;
        this.logger.log({
          ts: args.nowMs,
          type: this.eventType("LEVERAGE_CLAMP"),
          symbol: args.symbol,
          payload: { desiredLeverage, appliedLeverage: fallbackLeverage, maxLeverage },
        });
        this.leverageAppliedBySymbol.set(args.symbol, fallbackLeverage);
        return true;
      } catch (retryErr: any) {
        this.onTickRestError(args, "setLeverageFallback", retryErr, st);
        return false;
      }
    }
  }

  protected isRunningLifecycle(token?: number) {
    return this.running && (token == null || token === this.lifecycleToken);
  }

  protected getLifecycleToken() {
    return this.lifecycleToken;
  }

  start() {
    if (this.reconcileTimer) return;
    this.running = true;
    this.lifecycleToken += 1;
    if (this.sessionStartedAtMs <= 0) this.sessionStartedAtMs = Date.now();
    void this.reconcile(this.lifecycleToken);
    this.reconcileTimer = setInterval(() => {
      void this.reconcile(this.lifecycleToken);
    }, 1500);
    if (!this.executionsTimer) {
      void this.pollExecutions(this.lifecycleToken);
      this.executionsTimer = setInterval(() => {
        void this.pollExecutions(this.lifecycleToken);
      }, 5000);
    }
    if (!this.closedPnlTimer) {
      void this.pollClosedPnl(this.lifecycleToken);
      this.closedPnlTimer = setInterval(() => {
        void this.pollClosedPnl(this.lifecycleToken);
      }, 5000);
    }
    if (!this.transactionTimer) {
      void this.pollTransactionLog(this.lifecycleToken);
      this.transactionTimer = setInterval(() => {
        void this.pollTransactionLog(this.lifecycleToken);
      }, 30_000);
    }
    this.startBalancePolling();
  }

  stop() {
    this.running = false;
    this.lifecycleToken += 1;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.executionsTimer) {
      clearInterval(this.executionsTimer);
      this.executionsTimer = null;
    }
    if (this.closedPnlTimer) {
      clearInterval(this.closedPnlTimer);
      this.closedPnlTimer = null;
    }
    if (this.transactionTimer) {
      clearInterval(this.transactionTimer);
      this.transactionTimer = null;
    }
    this.stopBalancePolling();
  }

  getStats(): DemoStats {
    let pendingEntries = 0;
    for (const st of this.map.values()) {
      pendingEntries += st.pendingEntries.length;
    }
    return {
      mode: "demo",
      openPositions: this.globalOpenPositionsCount,
      openOrders: this.globalOpenOrdersCount,
      globalOpenPositions: this.globalOpenPositionsCount,
      globalOpenOrders: this.globalOpenOrdersCount,
      trackedOpenPositions: this.trackedOpenPositionsCount,
      trackedOpenOrders: this.trackedOpenOrdersCount,
      pendingEntries,
      lastReconcileAtMs: this.lastReconcileAtMs,
      tradesCount: this.demoClosedTradesCount,
      closedTrades: this.demoClosedTradesCount,
      wins: this.demoWins,
      losses: this.demoLosses,
      realizedPnlUsdt: this.demoRealizedPnlUsdt,
      feesUsdt: this.demoFeesUsdt,
      fundingUsdt: this.demoFundingUsdt,
      lastExecTimeMs: this.lastExecTimeMs,
      currentBalanceUsdt: this.currentBalanceUsdt,
      currentBalanceUpdatedAtMs: this.currentBalanceUpdatedAtMs,
    };
  }

  getCurrentBalance(): { currentBalanceUsdt: number | null; currentBalanceUpdatedAtMs: number | null } {
    return {
      currentBalanceUsdt: this.currentBalanceUsdt,
      currentBalanceUpdatedAtMs: this.currentBalanceUpdatedAtMs,
    };
  }

  private startBalancePolling() {
    this.balancePollTimer = startDemoBalancePolling({
      balancePollTimer: this.balancePollTimer,
      lifecycleToken: this.lifecycleToken,
      isRunningLifecycle: (token) => this.isRunningLifecycle(token),
      getWalletUsdtBalance: () => this.getWalletUsdtBalance(),
      setBalanceSnapshot: (balance, updatedAtMs) => {
        this.currentBalanceUsdt = balance;
        this.currentBalanceUpdatedAtMs = updatedAtMs;
      },
    });
  }

  private stopBalancePolling() {
    this.balancePollTimer = stopDemoBalancePolling(this.balancePollTimer);
  }

  private parseNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private trackSeen(id: string, seen: Set<string>, queue: string[], maxSize = 4000) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    queue.push(id);
    if (queue.length > maxSize) {
      const removed = queue.shift();
      if (removed) seen.delete(removed);
    }
  }

  private trackExecSeen(execId: string) {
    this.trackSeen(execId, this.execSeenIds, this.execSeenQueue);
  }

  private trackClosedPnlSeen(id: string) {
    this.trackSeen(id, this.closedPnlSeenIds, this.closedPnlSeenQueue);
  }

  private trackTransactionSeen(id: string) {
    this.trackSeen(id, this.transactionSeenIds, this.transactionSeenQueue);
  }

  private inferPositionSideFromCloseOrder(orderSideRaw: unknown): PaperSide {
    const orderSide = String(orderSideRaw ?? "").trim().toUpperCase();
    return orderSide === "BUY" ? "SHORT" : "LONG";
  }

  protected inferServerPositionSide(row: Record<string, any> | null | undefined): PaperSide | null {
    const sideRaw = String(row?.side ?? "").trim().toUpperCase();
    if (sideRaw === "BUY") return "LONG";
    if (sideRaw === "SELL") return "SHORT";
    return null;
  }

  protected applyAggregatedServerPositions(symbol: string, positions: Array<Record<string, any>>): SymbolState {
    const st = this.getState(symbol);
    const activePositions = (Array.isArray(positions) ? positions : []).filter((row) => this.parseNumber(row?.size) > 0);
    if (activePositions.length === 0) {
      st.positionOpen = false;
      st.openTradeSlots = 0;
      st.openTradeSlotsBySide = { LONG: 0, SHORT: 0 };
      st.side = null;
      st.entryPrice = null;
      st.qty = null;
      st.tpPrice = null;
      st.slPrice = null;
      st.lastServerUnrealizedPnl = null;
      this.refreshExecutionState(st);
      return st;
    }

    let totalQty = 0;
    let weightedEntry = 0;
    let weightedTp = 0;
    let weightedSl = 0;
    let totalTpWeight = 0;
    let totalSlWeight = 0;
    let totalUnrealized = 0;
    let hasUnrealized = false;
    const sides = new Set<PaperSide>();
    const openTradeSlotsBySide: Record<PaperSide, number> = { LONG: 0, SHORT: 0 };

    for (const row of activePositions) {
      const qty = this.parseNumber(row?.size);
      if (!(qty > 0)) continue;
      totalQty += qty;
      const side = this.inferServerPositionSide(row);
      if (side) {
        sides.add(side);
        openTradeSlotsBySide[side] += 1;
      }

      const avgPrice = this.parseNumber(row?.avgPrice);
      if (avgPrice > 0) weightedEntry += avgPrice * qty;

      const takeProfit = this.parseNumber(row?.takeProfit);
      if (takeProfit > 0) {
        weightedTp += takeProfit * qty;
        totalTpWeight += qty;
      }

      const stopLoss = this.parseNumber(row?.stopLoss);
      if (stopLoss > 0) {
        weightedSl += stopLoss * qty;
        totalSlWeight += qty;
      }

      const unrealized = Number(row?.unrealisedPnl);
      if (Number.isFinite(unrealized)) {
        totalUnrealized += unrealized;
        hasUnrealized = true;
      }
    }

    st.positionOpen = totalQty > 0;
    st.openTradeSlotsBySide = openTradeSlotsBySide;
    st.openTradeSlots = openTradeSlotsBySide.LONG + openTradeSlotsBySide.SHORT;
    st.side = sides.size === 1 ? Array.from(sides)[0]! : null;
    st.entryPrice = totalQty > 0 ? weightedEntry / totalQty : null;
    st.qty = totalQty > 0 ? totalQty : null;
    st.tpPrice = st.side != null && totalTpWeight > 0 ? weightedTp / totalTpWeight : null;
    st.slPrice = st.side != null && totalSlWeight > 0 ? weightedSl / totalSlWeight : null;
    st.lastServerUnrealizedPnl = hasUnrealized ? totalUnrealized : null;
    this.refreshExecutionState(st);
    return st;
  }

  private applyClosedTradeStats(args: {
    symbol: string;
    side: PaperSide;
    realizedPnl: number;
    feesPaid: number;
    fundingAccrued?: number;
    closedAtMs: number;
    source: "closed_pnl" | "execution";
    payload?: Record<string, unknown>;
  }) {
    const fundingAccrued = Number(args.fundingAccrued ?? 0) || 0;
    this.demoClosedTradesCount += 1;
    if (args.realizedPnl > 0) this.demoWins += 1;
    else this.demoLosses += 1;
    this.demoRealizedPnlUsdt += args.realizedPnl;
    const st = this.getState(args.symbol);
    st.realizedPnl += args.realizedPnl;
    st.feesPaid += args.feesPaid;
    st.fundingAccrued += fundingAccrued;
    this.logger.log({
      ts: args.closedAtMs,
      type: this.eventType("EXECUTION"),
      symbol: args.symbol,
      payload: {
        side: args.side,
        realizedPnl: args.realizedPnl,
        closedPnl: args.realizedPnl,
        feesPaid: args.feesPaid,
        fundingAccrued,
        closedAt: args.closedAtMs,
        closeType: "FORCE",
        source: args.source,
        ...(args.payload ?? {}),
      },
    });
  }

  private async pollExecutions(token = this.lifecycleToken) {
    if (!this.isRunningLifecycle(token) || this.executionsBusy || !this.rest.hasCredentials()) return;
    this.executionsBusy = true;
    const nowMs = Date.now();
    try {
      await pollDemoExecutions({
        token,
        rest: this.rest,
        logger: this.logger,
        eventType: (suffix) => this.eventType(suffix),
        isRunningLifecycle: (nextToken) => this.isRunningLifecycle(nextToken),
        parseNumber: (value) => this.parseNumber(value),
        sessionStartedAtMs: this.sessionStartedAtMs,
        lastExecTimeMs: this.lastExecTimeMs,
        setLastExecTimeMs: (value) => {
          this.lastExecTimeMs = value;
        },
        execSeenIds: this.execSeenIds,
        trackExecSeen: (execId) => this.trackExecSeen(execId),
        addDemoFeesUsdt: (value) => {
          this.demoFeesUsdt += value;
        },
      });
    } catch (err: any) {
      if (!this.isRunningLifecycle(token)) return;
      this.logger.log({
        ts: nowMs,
        type: this.eventType("ORDER_ERROR"),
        payload: {
          stage: "executions",
          retCode: err?.retCode,
          retMsg: err?.retMsg,
          errorName: err?.name,
          errorMessage: err?.message,
          request: { limit: 100 },
        },
      });
    } finally {
      this.executionsBusy = false;
    }
  }

  private async pollClosedPnl(token = this.lifecycleToken) {
    if (!this.isRunningLifecycle(token) || this.closedPnlBusy || !this.rest.hasCredentials()) return;
    this.closedPnlBusy = true;
    const nowMs = Date.now();
    try {
      await pollDemoClosedPnl({
        token,
        rest: this.rest,
        logger: this.logger,
        eventType: (suffix) => this.eventType(suffix),
        isRunningLifecycle: (nextToken) => this.isRunningLifecycle(nextToken),
        parseNumber: (value) => this.parseNumber(value),
        sessionStartedAtMs: this.sessionStartedAtMs,
        lastClosedPnlTimeMs: this.lastClosedPnlTimeMs,
        setLastClosedPnlTimeMs: (value) => {
          this.lastClosedPnlTimeMs = value;
        },
        closedPnlSeenIds: this.closedPnlSeenIds,
        trackClosedPnlSeen: (id) => this.trackClosedPnlSeen(id),
        inferPositionSideFromCloseOrder: (orderSideRaw) => this.inferPositionSideFromCloseOrder(orderSideRaw),
        applyClosedTradeStats: (args) => this.applyClosedTradeStats(args),
        getState: (symbol) => this.getState(symbol),
        refreshExecutionState: (state) => this.refreshExecutionState(state),
      });
    } catch (err: any) {
      if (!this.isRunningLifecycle(token)) return;
      this.logger.log({
        ts: nowMs,
        type: this.eventType("ORDER_ERROR"),
        payload: {
          stage: "closed_pnl",
          retCode: err?.retCode,
          retMsg: err?.retMsg,
        },
      });
    } finally {
      this.closedPnlBusy = false;
    }
  }

  private async pollTransactionLog(token = this.lifecycleToken) {
    if (!this.isRunningLifecycle(token) || this.transactionBusy || !this.rest.hasCredentials()) return;
    this.transactionBusy = true;
    const nowMs = Date.now();
    try {
      await pollDemoTransactionLog({
        token,
        rest: this.rest,
        logger: this.logger,
        eventType: (suffix) => this.eventType(suffix),
        isRunningLifecycle: (nextToken) => this.isRunningLifecycle(nextToken),
        parseNumber: (value) => this.parseNumber(value),
        sessionStartedAtMs: this.sessionStartedAtMs,
        lastTransactionTimeMs: this.lastTransactionTimeMs,
        setLastTransactionTimeMs: (value) => {
          this.lastTransactionTimeMs = value;
        },
        transactionSeenIds: this.transactionSeenIds,
        trackTransactionSeen: (id) => this.trackTransactionSeen(id),
        addDemoFundingUsdt: (value) => {
          this.demoFundingUsdt += value;
        },
        getState: (symbol) => this.getState(symbol),
      });
    } catch (err: any) {
      if (!this.isRunningLifecycle(token)) return;
      this.logger.log({
        ts: nowMs,
        type: this.eventType("ORDER_ERROR"),
        payload: {
          stage: "transaction_log",
          retCode: err?.retCode,
          retMsg: err?.retMsg,
        },
      });
    } finally {
      this.transactionBusy = false;
    }
  }

  async getWalletUsdtBalance(): Promise<number | null> {
    return readDemoWalletUsdtBalance(this.rest);
  }

  private async getMeta(symbol: string): Promise<LinearInstrumentMeta | null> {
    const cached = this.metaBySymbol.get(symbol);
    if (cached) return cached;
    const list = await this.rest.getInstrumentsInfoLinear({ symbol });
    const meta = pickLinearMeta(list[0]);
    if (!meta) return null;
    this.metaBySymbol.set(symbol, meta);
    return meta;
  }

  async placeManualOrder(args: {
    symbol: string;
    side: PaperSide;
    nowMs: number;
    entryPrice: number;
    tpPrice: number;
    slPrice: number;
    maxTradesPerSymbol?: number;
    configOverride?: PaperBrokerTickConfigOverride;
    reason?: string;
  }): Promise<ManualBrokerSubmitResult> {
    return placeManualDemoOrder({
      brokerLabel: "Demo",
      cfg: this.cfg,
      logger: this.logger,
      rest: this.rest,
      runId: this.runId,
      missingKeysLogged: this.missingKeysLogged,
      setMissingKeysLogged: (value) => {
        this.missingKeysLogged = value;
      },
      getMissingApiKeysReason: () => this.getMissingApiKeysReason(),
      eventType: (suffix) => this.eventType(suffix),
      getState: (symbol) => this.getState(symbol),
      getActiveTradesCount: (symbol, side) => this.getActiveTradesCount(symbol, side),
      reserveEntrySlot: (state, side) => this.reserveEntrySlot(state, side),
      releaseEntrySlot: (state, side) => this.releaseEntrySlot(state, side),
      getMeta: (symbol) => this.getMeta(symbol),
      ensureLeverageConfigured: (nextArgs, state) => this.ensureLeverageConfigured(nextArgs, state),
      onTickRestError: (nextArgs, stage, err, state) => this.onTickRestError(nextArgs, stage, err, state),
      clearPendingByOrderLinkId: (state, orderLinkId) => this.clearPendingByOrderLinkId(state, orderLinkId),
      refreshExecutionState: (state) => this.refreshExecutionState(state),
    }, args);
  }

  async tick(args: TickInput): Promise<boolean> {
    return executeDemoSignalOrder({
      cfg: this.cfg,
      logger: this.logger,
      rest: this.rest,
      runId: this.runId,
      getMarkPrice: this.getMarkPrice,
      missingKeysLogged: this.missingKeysLogged,
      setMissingKeysLogged: (value) => {
        this.missingKeysLogged = value;
      },
      getMissingApiKeysReason: () => this.getMissingApiKeysReason(),
      eventType: (suffix) => this.eventType(suffix),
      getState: (symbol) => this.getState(symbol),
      getActiveTradesCount: (symbol, side) => this.getActiveTradesCount(symbol, side),
      openOrderSymbolsCache: this.openOrderSymbolsCache,
      missingMetaLogged: this.missingMetaLogged,
      reserveEntrySlot: (state, side) => this.reserveEntrySlot(state, side),
      releaseEntrySlot: (state, side) => this.releaseEntrySlot(state, side),
      getMeta: (symbol) => this.getMeta(symbol),
      ensureLeverageConfigured: (nextArgs, state) => this.ensureLeverageConfigured(nextArgs, state),
      onTickRestError: (nextArgs, stage, err, state) => this.onTickRestError(nextArgs, stage, err, state),
      isBenignCancelRaceError: (err) => this.isBenignCancelRaceError(err),
      clearPendingByOrderLinkId: (state, orderLinkId) => this.clearPendingByOrderLinkId(state, orderLinkId),
      refreshExecutionState: (state) => this.refreshExecutionState(state),
    }, args);
  }

  private async reconcile(token = this.lifecycleToken) {
    if (!this.isRunningLifecycle(token) || this.reconcileBusy || !this.rest.hasCredentials()) return;
    this.reconcileBusy = true;
    const nowMs = Date.now();

    try {
      await reconcileDemoBroker({
        token,
        rest: this.rest,
        logger: this.logger,
        eventType: (suffix) => this.eventType(suffix),
        isRunningLifecycle: (nextToken) => this.isRunningLifecycle(nextToken),
        map: this.map,
        setLastReconcileAtMs: (value) => {
          this.lastReconcileAtMs = value;
        },
        setGlobalOpenOrdersCount: (value) => {
          this.globalOpenOrdersCount = value;
        },
        setGlobalOpenPositionsCount: (value) => {
          this.globalOpenPositionsCount = value;
        },
        setTrackedOpenOrdersCount: (value) => {
          this.trackedOpenOrdersCount = value;
        },
        setTrackedOpenPositionsCount: (value) => {
          this.trackedOpenPositionsCount = value;
        },
        setOpenOrdersCache: (value) => {
          this.openOrdersCache = value;
        },
        setOpenOrderSymbolsCache: (value) => {
          this.openOrderSymbolsCache = value;
        },
        inferServerPositionSide: (row) => this.inferServerPositionSide(row),
        applyAggregatedServerPositions: (symbol, positions) => this.applyAggregatedServerPositions(symbol, positions),
        refreshExecutionState: (state) => this.refreshExecutionState(state),
      });
    } catch (err: any) {
      if (!this.isRunningLifecycle(token)) return;
      this.logger.log({
        ts: nowMs,
        type: this.eventType("ORDER_ERROR"),
        payload: {
          stage: "reconcile",
          retCode: err?.retCode,
          retMsg: err?.retMsg,
          errorName: err?.name,
          errorMessage: err?.message,
          request: { settleCoin: "USDT" },
        },
      });
    } finally {
      this.reconcileBusy = false;
    }
  }
}
