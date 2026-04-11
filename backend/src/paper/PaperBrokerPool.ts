import type { EventLogger } from "../logging/EventLogger.js";
import {
  PaperBroker,
  type PaperBrokerConfig,
  type PaperBrokerTickConfigOverride,
  type PaperSide,
  type PaperStats,
  type PaperTickOhlc,
  type PaperView,
} from "./PaperBroker.js";

type TickInput = {
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
  maxTradesPerSymbol?: number;
};

function sum(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (!Number.isFinite(value as number)) continue;
    total += Number(value);
    seen = true;
  }
  return seen ? total : null;
}

function weightedAverage(entries: Array<{ value: number | null; weight: number | null }>): number | null {
  let totalWeight = 0;
  let totalValue = 0;
  for (const entry of entries) {
    if (!Number.isFinite(entry.value as number) || !Number.isFinite(entry.weight as number)) continue;
    const weight = Number(entry.weight);
    if (weight <= 0) continue;
    totalWeight += weight;
    totalValue += Number(entry.value) * weight;
  }
  if (totalWeight <= 0) return null;
  return totalValue / totalWeight;
}

export class PaperBrokerPool {
  private baseCfg: PaperBrokerConfig;
  private readonly logger: EventLogger;
  private readonly runId: string;
  private readonly slots: PaperBroker[] = [];

  constructor(cfg: PaperBrokerConfig, logger: EventLogger, runId = "run") {
    this.baseCfg = { ...cfg };
    this.logger = logger;
    this.runId = runId;
    this.ensureSlotCount(1);
  }

  private childConfig(): PaperBrokerConfig {
    return {
      ...this.baseCfg,
      // Pool-level limit is checked once across all slots.
      maxDailyLossUSDT: 0,
    };
  }

  private ensureSlotCount(nextCount: number) {
    const target = Math.max(1, Math.floor(Number(nextCount) || 1));
    while (this.slots.length < target) {
      this.slots.push(new PaperBroker(this.childConfig(), this.logger, `${this.runId}:slot${this.slots.length + 1}`));
    }
  }

  private isDailyLossLimitReached(): boolean {
    const limit = Number(this.baseCfg.maxDailyLossUSDT);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    return this.getStats().netRealized <= -limit;
  }

  applyConfigForNextTrades(next: Partial<PaperBrokerConfig>) {
    const patch = next ?? {};
    this.baseCfg = {
      ...this.baseCfg,
      ...patch,
    };
    for (const slot of this.slots) {
      slot.applyConfigForNextTrades({
        ...patch,
        maxDailyLossUSDT: 0,
      });
    }
  }

  getActiveTradesCount(symbol: string, side?: PaperSide): number {
    return this.slots.reduce((total, slot) => total + slot.getActiveTradesCount(symbol, side), 0);
  }

  getStats(): PaperStats {
    return this.slots.reduce<PaperStats>((acc, slot) => {
      const stats = slot.getStats();
      acc.openPositions += stats.openPositions;
      acc.pendingOrders += stats.pendingOrders;
      acc.closedTrades += stats.closedTrades;
      acc.wins += stats.wins;
      acc.losses += stats.losses;
      acc.netRealized += stats.netRealized;
      acc.feesPaid += stats.feesPaid;
      acc.fundingAccrued += stats.fundingAccrued;
      return acc;
    }, {
      openPositions: 0,
      pendingOrders: 0,
      closedTrades: 0,
      wins: 0,
      losses: 0,
      netRealized: 0,
      feesPaid: 0,
      fundingAccrued: 0,
    });
  }

  getView(symbol: string, markPrice: number | null): PaperView {
    const views = this.slots.map((slot) => slot.getView(symbol, markPrice));
    const activeViews = views.filter((view) => view.paperStatus !== "IDLE");
    if (activeViews.length === 0) {
      return views[0] ?? {
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

    const openViews = activeViews.filter((view) => view.paperStatus === "OPEN");
    const pendingViews = activeViews.filter((view) => view.paperStatus === "ENTRY_PENDING");
    const primaryViews = openViews.length > 0 ? openViews : pendingViews;
    const quantities = primaryViews.map((view) => view.paperQty ?? null);
    const entryPrice = weightedAverage(primaryViews.map((view) => ({ value: view.paperEntryPrice, weight: view.paperQty })));
    const tpPrice = weightedAverage(openViews.map((view) => ({ value: view.paperTpPrice, weight: view.paperQty })));
    const slPrice = weightedAverage(openViews.map((view) => ({ value: view.paperSlPrice, weight: view.paperQty })));
    const sides = new Set(primaryViews.map((view) => view.paperSide).filter(Boolean));
    const singleSide = sides.size === 1;
    return {
      paperStatus: openViews.length > 0 ? "OPEN" : "ENTRY_PENDING",
      paperSide: singleSide ? (Array.from(sides)[0] as PaperSide) : null,
      paperEntryPrice: singleSide ? entryPrice : null,
      paperTpPrice: singleSide ? tpPrice : null,
      paperSlPrice: singleSide ? slPrice : null,
      paperQty: sum(quantities),
      paperOrderExpiresAt: pendingViews.length > 0 ? Math.max(...pendingViews.map((view) => Number(view.paperOrderExpiresAt ?? 0))) : null,
      paperUnrealizedPnl: sum(openViews.map((view) => view.paperUnrealizedPnl ?? null)),
      paperRealizedPnl: views.reduce((total, view) => total + Number(view.paperRealizedPnl ?? 0), 0),
    };
  }

  stopAll(args: {
    nowMs: number;
    symbols: string[];
    getMarkPrice: (symbol: string) => number | null;
    closeOpenPositions?: boolean;
  }) {
    for (const slot of this.slots) {
      slot.stopAll(args);
    }
  }

  tick(input: TickInput) {
    const maxTradesPerSymbol = Math.max(1, Math.floor(Number(input.maxTradesPerSymbol) || 1));
    this.ensureSlotCount(maxTradesPerSymbol);

    for (const slot of this.slots) {
      slot.tick({
        ...input,
        signal: null,
        signalReason: input.signalReason,
      });
    }

    if (!input.signal || input.cooldownActive) return;

    if (this.isDailyLossLimitReached()) {
      this.logger.log({
        ts: input.nowMs,
        type: "ORDER_SKIPPED",
        symbol: input.symbol,
        payload: {
          reason: "paper_pool_max_daily_loss",
          maxDailyLossUSDT: this.baseCfg.maxDailyLossUSDT,
        },
      });
      return;
    }

    const activeCount = this.getActiveTradesCount(input.symbol, this.baseCfg.directionMode === "both" ? input.signal ?? undefined : undefined);
    if (activeCount >= maxTradesPerSymbol) {
      this.logger.log({
        ts: input.nowMs,
        type: "ORDER_SKIPPED",
        symbol: input.symbol,
        payload: {
          reason: "symbol_trade_limit",
          activeTrades: activeCount,
          maxTradesPerSymbol,
          signal: input.signal,
        },
      });
      return;
    }

    const idleSlot = this.slots.find((slot) => slot.getActiveTradesCount(input.symbol) === 0);
    idleSlot?.tick(input);
  }
}
