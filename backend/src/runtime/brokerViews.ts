import { configStore } from "./configStore.js";
import type { RuntimeBotStats } from "./types.js";
import type { DemoBroker } from "../demo/DemoBroker.js";
import type { PaperBroker, PaperView } from "../paper/PaperBroker.js";
import type { PaperBrokerPool } from "../paper/PaperBrokerPool.js";
import type { RealBroker } from "../real/RealBroker.js";

type BrokerViewDeps = {
  paper: PaperBrokerPool | PaperBroker | null;
  demo: DemoBroker | null;
  real: RealBroker | null;
};

export function buildRuntimeBotStats(deps: BrokerViewDeps): RuntimeBotStats {
  const mode = configStore.get().execution.mode;
  if ((mode === "demo" || (!deps.real && !deps.paper && deps.demo)) && deps.demo) {
    const demoStats = deps.demo.getStats();
    const balanceSnapshot = deps.demo.getCurrentBalance();
    return {
      openPositions: demoStats.trackedOpenPositions,
      pendingOrders: Math.max(demoStats.trackedOpenOrders, demoStats.pendingEntries),
      closedTrades: demoStats.closedTrades,
      wins: demoStats.wins,
      losses: demoStats.losses,
      netRealized: demoStats.realizedPnlUsdt,
      feesPaid: demoStats.feesUsdt,
      fundingAccrued: demoStats.fundingUsdt,
      executionMode: "demo",
      demoStats: {
        openPositions: demoStats.openPositions,
        openOrders: demoStats.openOrders,
        globalOpenPositions: demoStats.globalOpenPositions,
        globalOpenOrders: demoStats.globalOpenOrders,
        trackedOpenPositions: demoStats.trackedOpenPositions,
        trackedOpenOrders: demoStats.trackedOpenOrders,
        pendingEntries: demoStats.pendingEntries,
        lastReconcileAtMs: demoStats.lastReconcileAtMs,
        tradesCount: demoStats.closedTrades,
        closedTrades: demoStats.closedTrades,
        wins: demoStats.wins,
        losses: demoStats.losses,
        realizedPnlUsdt: demoStats.realizedPnlUsdt,
        feesUsdt: demoStats.feesUsdt,
        fundingUsdt: demoStats.fundingUsdt,
        lastExecTimeMs: demoStats.lastExecTimeMs,
        startBalanceUsdt: deps.demo.sessionStartBalanceUsdt,
        currentBalanceUsdt: balanceSnapshot.currentBalanceUsdt,
        currentBalanceUpdatedAtMs: balanceSnapshot.currentBalanceUpdatedAtMs,
      },
    };
  }
  if ((mode === "real" || (!deps.demo && !deps.paper && deps.real)) && deps.real) {
    const realStats = deps.real.getRealStats();
    const balanceSnapshot = deps.real.getCurrentBalance();
    return {
      openPositions: realStats.trackedOpenPositions,
      pendingOrders: Math.max(realStats.trackedOpenOrders, realStats.pendingEntries),
      closedTrades: realStats.closedTrades,
      wins: realStats.wins,
      losses: realStats.losses,
      netRealized: realStats.realizedPnlUsdt,
      feesPaid: realStats.feesUsdt,
      fundingAccrued: realStats.fundingUsdt,
      executionMode: "real",
      realStats: {
        openPositions: realStats.openPositions,
        openOrders: realStats.openOrders,
        globalOpenPositions: realStats.globalOpenPositions,
        globalOpenOrders: realStats.globalOpenOrders,
        trackedOpenPositions: realStats.trackedOpenPositions,
        trackedOpenOrders: realStats.trackedOpenOrders,
        pendingEntries: realStats.pendingEntries,
        lastReconcileAtMs: realStats.lastReconcileAtMs,
        tradesCount: realStats.closedTrades,
        closedTrades: realStats.closedTrades,
        wins: realStats.wins,
        losses: realStats.losses,
        realizedPnlUsdt: realStats.realizedPnlUsdt,
        feesUsdt: realStats.feesUsdt,
        fundingUsdt: realStats.fundingUsdt,
        lastExecTimeMs: realStats.lastExecTimeMs,
        startBalanceUsdt: deps.real.sessionStartBalanceUsdt,
        currentBalanceUsdt: balanceSnapshot.currentBalanceUsdt,
        currentBalanceUpdatedAtMs: balanceSnapshot.currentBalanceUpdatedAtMs,
      },
    };
  }
  if ((mode === "paper" || (!deps.demo && !deps.real && deps.paper)) && deps.paper) {
    return { ...deps.paper.getStats(), executionMode: "paper" };
  }
  return {
    openPositions: 0,
    pendingOrders: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    netRealized: 0,
    feesPaid: 0,
    fundingAccrued: 0,
    executionMode: mode,
  };
}

export function resolveRuntimePaperView(args: BrokerViewDeps & { symbol: string; markPrice: number | null }): PaperView {
  const mode = configStore.get().execution.mode;
  if ((mode === "demo" || (!args.real && !args.paper && args.demo)) && args.demo) {
    return args.demo.getView(args.symbol, args.markPrice);
  }
  if ((mode === "real" || (!args.demo && !args.paper && args.real)) && args.real) {
    return args.real.getView(args.symbol, args.markPrice);
  }
  if (!((mode === "paper" || (!args.demo && !args.real && args.paper)) && args.paper)) {
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
  return args.paper.getView(args.symbol, args.markPrice);
}
