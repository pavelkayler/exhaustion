import type { ShortExhaustionBotConfig } from "../../bots/registry.js";
import type { BybitLongShortRatioSnapshot } from "../../engine/BybitLongShortRatioStore.js";
import type { BybitOrderbookSummary } from "../../engine/BybitOrderbookStore.js";
import type { LiquidationWindowSnapshot } from "../../engine/LiquidationWindowStore.js";
import type { MarketWindowSnapshot } from "../../engine/MarketWindowStore.js";
import type { ShortExhaustionSignalInput } from "../../engine/ShortExhaustionSignalEngine.js";
import type { TradeActivityWindowSnapshot } from "../../engine/TradeActivityWindowStore.js";
import type { ShortSignalReferenceMarketSnapshot } from "../../analytics/shortSignalOutcomeTypes.js";

export type ShortRuntimeCadenceState = {
  confirmedPriceHistory: number[];
  confirmedOiHistory: number[];
  lastConfirmedAt: number | null;
};

export type ShortRuntimeOiSeedSnapshot = {
  refOi5m: number | null;
  refOi15m: number | null;
  refOi1h: number | null;
} | null;

export type ShortRuntimeContext = {
  priceMove30sPct: number | null;
  priceMove1mPct: number | null;
  priceMove3mPct: number | null;
  priceMove5mPct: number | null;
  priceMove15mPct: number | null;
  oiMove1mPct: number | null;
  oiMove5mPct: number | null;
  oiMove15mPct?: number | null;
  oiMove1hPct?: number | null;
  oiAccelerationPct: number | null;
  volumeBurst1m: number | null;
  volumeBurst3m: number | null;
  turnoverBurst1m: number | null;
  turnoverBurst3m: number | null;
  trades1m: number;
  universeRank: number | null;
  universeSize: number;
};

export type ShortRuntimeMarketRow = {
  symbol: string;
  markPrice: number | null;
  lastPrice: number | null;
  bid1: number | null;
  ask1: number | null;
  openInterest: number | null;
  openInterestValue: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  fundingIntervalHour: number | null;
  turnover24hUsd: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;
  updatedAt: number | null;
};

export type ShortRuntimeCvdFeatures = {
  cvdDelta: number | null;
  cvdImbalanceRatio: number | null;
  divergencePriceUpCvdDown: boolean;
  divergencePriceDownCvdUp: boolean;
};

export type ShortRuntimeRankingRow = {
  symbol: string;
  anomalyScore: number;
};

export type ShortRuntimeContextEntry = {
  context: ShortRuntimeContext;
  rankingRow: ShortRuntimeRankingRow;
};

function pctChange(now: number | null | undefined, ref: number | null | undefined): number | null {
  if (!Number.isFinite(now as number) || !Number.isFinite(ref as number) || Number(ref) === 0) return null;
  return ((Number(now) - Number(ref)) / Number(ref)) * 100;
}

function shortScoreRatio(value: number | null | undefined, threshold: number, cap = 2): number {
  if (!Number.isFinite(value as number) || !(threshold > 0)) return 0;
  return Math.max(0, Math.min(cap, Number(value) / threshold));
}

function shortMaxFinite(values: Array<number | null | undefined>): number {
  let best = 0;
  for (const value of values) {
    const numeric = Number(value ?? 0);
    if (Number.isFinite(numeric) && numeric > best) best = numeric;
  }
  return best;
}

export function finiteOr(value: number | null | undefined, fallback: number | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

export function resolveComparableOpenInterest(args: {
  openInterest: number | null | undefined;
  openInterestValue: number | null | undefined;
  markPrice: number | null | undefined;
}): number | null {
  const openInterest = finiteOr(args.openInterest ?? null, null);
  if (openInterest != null && openInterest > 0) return openInterest;
  const openInterestValue = finiteOr(args.openInterestValue ?? null, null);
  const markPrice = finiteOr(args.markPrice ?? null, null);
  if (openInterestValue != null && openInterestValue > 0 && markPrice != null && markPrice > 0) {
    return openInterestValue / markPrice;
  }
  return null;
}

export function readSpreadBps(bid1: number | null, ask1: number | null, markPrice: number | null): number | null {
  if (bid1 == null || ask1 == null || markPrice == null) return null;
  if (!Number.isFinite(bid1) || !Number.isFinite(ask1) || !Number.isFinite(markPrice) || bid1 <= 0 || ask1 <= 0 || markPrice <= 0) return null;
  return ((ask1 - bid1) / markPrice) * 10_000;
}

export function createEmptyShortRuntimeContext(universeSize: number): ShortRuntimeContext {
  return {
    priceMove30sPct: null,
    priceMove1mPct: null,
    priceMove3mPct: null,
    priceMove5mPct: null,
    priceMove15mPct: null,
    oiMove1mPct: null,
    oiMove5mPct: null,
    oiMove15mPct: null,
    oiMove1hPct: null,
    oiAccelerationPct: null,
    volumeBurst1m: null,
    volumeBurst3m: null,
    turnoverBurst1m: null,
    turnoverBurst3m: null,
    trades1m: 0,
    universeRank: null,
    universeSize: Math.max(0, universeSize),
  };
}

function readHistoryRef(history: number[], lookbackCandles: number): number | null {
  if (!Array.isArray(history) || history.length < lookbackCandles) return null;
  const value = history[history.length - lookbackCandles] ?? null;
  return Number.isFinite(value as number) ? Number(value) : null;
}

function computeShortRuntimeAnomalyScore(args: {
  context: ShortRuntimeContext;
  tradeSnapshot: TradeActivityWindowSnapshot;
  shortCfg: ShortExhaustionBotConfig;
}): number {
  return shortMaxFinite([
    shortScoreRatio(args.context.priceMove1mPct, args.shortCfg.candidate.minPriceMove1mPct, 1.2),
    shortScoreRatio(args.context.priceMove3mPct, args.shortCfg.candidate.minPriceMove3mPct, 1.4),
    shortScoreRatio(args.context.priceMove5mPct, args.shortCfg.candidate.minPriceMove5mPct, 1.5),
    shortScoreRatio(args.context.priceMove15mPct, args.shortCfg.candidate.minPriceMove15mPct, 1.5),
  ]) * 0.62
  + shortMaxFinite([
    shortScoreRatio(args.tradeSnapshot.turnoverBurst1mVs15m, args.shortCfg.candidate.minTurnoverBurstRatio, 1.6),
    shortScoreRatio(args.tradeSnapshot.turnoverBurst3mVs15m, args.shortCfg.candidate.minTurnoverBurstRatio, 1.6),
  ]) * 0.24
  + shortMaxFinite([
    shortScoreRatio(args.tradeSnapshot.volumeBurst1mVs15m, args.shortCfg.candidate.minVolumeBurstRatio, 1.5),
    shortScoreRatio(args.tradeSnapshot.volumeBurst3mVs15m, args.shortCfg.candidate.minVolumeBurstRatio, 1.5),
  ]) * 0.14;
}

export function buildShortRuntimeContextEntry(args: {
  symbol: string;
  universeSize: number;
  now: number;
  shortCfg: ShortExhaustionBotConfig;
  getMarketRow: (symbol: string) => ShortRuntimeMarketRow | null;
  getCadence: (symbol: string) => ShortRuntimeCadenceState | undefined;
  getOiSeed?: (symbol: string) => ShortRuntimeOiSeedSnapshot;
  getMarketSnapshot: (symbol: string, now: number) => MarketWindowSnapshot;
  getTradeSnapshot: (symbol: string, now: number) => TradeActivityWindowSnapshot;
}): ShortRuntimeContextEntry {
  const raw = args.getMarketRow(args.symbol);
  const markPrice = finiteOr(raw?.markPrice, null);
  const openInterestValue = finiteOr(raw?.openInterestValue, null);
  const openInterest = resolveComparableOpenInterest({
    openInterest: finiteOr(raw?.openInterest, null),
    openInterestValue,
    markPrice,
  });
  const oiSeed = args.getOiSeed?.(args.symbol) ?? null;
  const cadence = args.getCadence(args.symbol);
  const confirmedPriceHistory = cadence?.confirmedPriceHistory ?? [];
  const confirmedOiHistory = cadence?.confirmedOiHistory ?? [];
  const marketSnapshot = args.getMarketSnapshot(args.symbol, args.now);
  const tradeSnapshot = args.getTradeSnapshot(args.symbol, args.now);
  const priceRef1m = readHistoryRef(confirmedPriceHistory, 1) ?? marketSnapshot.markPrice1mAgo;
  const oiRef1m = readHistoryRef(confirmedOiHistory, 1) ?? marketSnapshot.openInterest1mAgo;
  const priceMove30sPct = markPrice == null ? null : pctChange(markPrice, marketSnapshot.markPrice30sAgo ?? null);
  const priceMove1mPct = markPrice == null ? null : pctChange(markPrice, priceRef1m);
  const priceMove3mPct = markPrice == null ? null : pctChange(markPrice, readHistoryRef(confirmedPriceHistory, 3));
  const priceMove5mPct = markPrice == null ? null : pctChange(markPrice, readHistoryRef(confirmedPriceHistory, 5));
  const priceMove15mPct = markPrice == null ? null : pctChange(markPrice, readHistoryRef(confirmedPriceHistory, 15));
  const oiMove1mPct = openInterest == null ? null : pctChange(openInterest, oiRef1m);
  const oiMove5mPct = openInterest == null
    ? null
    : pctChange(openInterest, readHistoryRef(confirmedOiHistory, 5) ?? oiSeed?.refOi5m ?? null);
  const oiMove15mPct = openInterest == null
    ? null
    : pctChange(openInterest, readHistoryRef(confirmedOiHistory, 15) ?? oiSeed?.refOi15m ?? null);
  const oiMove1hPct = openInterest == null
    ? null
    : pctChange(openInterest, readHistoryRef(confirmedOiHistory, 60) ?? oiSeed?.refOi1h ?? null);
  const oiAccelerationPct =
    oiMove1mPct == null || oiMove5mPct == null
      ? null
      : oiMove1mPct - (oiMove5mPct / 5);

  const context: ShortRuntimeContext = {
    priceMove30sPct,
    priceMove1mPct,
    priceMove3mPct,
    priceMove5mPct,
    priceMove15mPct,
    oiMove1mPct,
    oiMove5mPct,
    oiMove15mPct,
    oiMove1hPct,
    oiAccelerationPct,
    volumeBurst1m: tradeSnapshot.volumeBurst1mVs15m,
    volumeBurst3m: tradeSnapshot.volumeBurst3mVs15m,
    turnoverBurst1m: tradeSnapshot.turnoverBurst1mVs15m,
    turnoverBurst3m: tradeSnapshot.turnoverBurst3mVs15m,
    trades1m: tradeSnapshot.trades1m,
    universeRank: null,
    universeSize: args.universeSize,
  };

  return {
    context,
    rankingRow: {
      symbol: args.symbol,
      anomalyScore: computeShortRuntimeAnomalyScore({
        context,
        tradeSnapshot,
        shortCfg: args.shortCfg,
      }),
    },
  };
}

export function applyShortRuntimeUniverseRanks(
  contexts: Map<string, ShortRuntimeContext>,
  rankingRows: Iterable<ShortRuntimeRankingRow>,
): void {
  for (const current of contexts.values()) {
    current.universeRank = null;
  }

  Array.from(rankingRows)
    .sort((left, right) => {
      const scoreDelta = right.anomalyScore - left.anomalyScore;
      if (scoreDelta !== 0) return scoreDelta;
      return left.symbol.localeCompare(right.symbol);
    })
    .forEach((row, index) => {
      const current = contexts.get(row.symbol);
      if (!current) return;
      current.universeRank = index + 1;
    });
}

export function buildShortRuntimeContexts(args: {
  symbols: string[];
  now: number;
  shortCfg: ShortExhaustionBotConfig;
  getMarketRow: (symbol: string) => ShortRuntimeMarketRow | null;
  getCadence: (symbol: string) => ShortRuntimeCadenceState | undefined;
  getOiSeed?: (symbol: string) => ShortRuntimeOiSeedSnapshot;
  getMarketSnapshot: (symbol: string, now: number) => MarketWindowSnapshot;
  getTradeSnapshot: (symbol: string, now: number) => TradeActivityWindowSnapshot;
}): Map<string, ShortRuntimeContext> {
  const contexts = new Map<string, ShortRuntimeContext>();
  const rankingRows: ShortRuntimeRankingRow[] = [];

  for (const symbol of args.symbols) {
    const entry = buildShortRuntimeContextEntry({
      symbol,
      universeSize: args.symbols.length,
      now: args.now,
      shortCfg: args.shortCfg,
      getMarketRow: args.getMarketRow,
      getCadence: args.getCadence,
      ...(args.getOiSeed ? { getOiSeed: args.getOiSeed } : {}),
      getMarketSnapshot: args.getMarketSnapshot,
      getTradeSnapshot: args.getTradeSnapshot,
    });
    rankingRows.push(entry.rankingRow);
    contexts.set(symbol, entry.context);
  }

  applyShortRuntimeUniverseRanks(contexts, rankingRows);
  return contexts;
}

export function buildShortSignalReferenceMarket(args: {
  marketRow: ShortRuntimeMarketRow | null;
  orderbook: BybitOrderbookSummary;
  capturedAtMs: number;
}): ShortSignalReferenceMarketSnapshot | null {
  const bid1 = finiteOr(args.orderbook.bestBid, finiteOr(args.marketRow?.bid1, null));
  const ask1 = finiteOr(args.orderbook.bestAsk, finiteOr(args.marketRow?.ask1, null));
  const midPrice = finiteOr(
    args.orderbook.midPrice,
    bid1 != null && ask1 != null && bid1 > 0 && ask1 > 0 ? (bid1 + ask1) / 2 : null,
  );
  const lastPrice = finiteOr(args.marketRow?.lastPrice, null);
  const markPrice = finiteOr(args.marketRow?.markPrice, null);
  if (midPrice == null && lastPrice == null && markPrice == null) return null;
  return {
    capturedAtMs: args.capturedAtMs,
    bid1,
    ask1,
    midPrice,
    lastPrice,
    markPrice,
  };
}

export function buildShortSignalInput(args: {
  now: number;
  symbol: string;
  marketRow: ShortRuntimeMarketRow | null;
  context: ShortRuntimeContext;
  cvd: ShortRuntimeCvdFeatures;
  liquidation: LiquidationWindowSnapshot;
  orderbook: BybitOrderbookSummary;
  longShortRatio: BybitLongShortRatioSnapshot;
}): ShortExhaustionSignalInput {
  const markPrice = finiteOr(args.marketRow?.markPrice, null);
  const openInterestValue = finiteOr(args.marketRow?.openInterestValue, null);
  return {
    ts: args.now,
    symbol: args.symbol,
    markPrice: markPrice != null && markPrice > 0 ? markPrice : null,
    lastPrice: finiteOr(args.marketRow?.lastPrice, null),
    fundingRate: finiteOr(args.marketRow?.fundingRate, 0) ?? 0,
    turnover24hUsd: finiteOr(args.marketRow?.turnover24hUsd, null),
    openInterestValue: openInterestValue != null && openInterestValue > 0 ? openInterestValue : null,
    spreadBps: readSpreadBps(
      finiteOr(args.marketRow?.bid1, null),
      finiteOr(args.marketRow?.ask1, null),
      markPrice,
    ),
    highPrice24h: finiteOr(args.marketRow?.highPrice24h, null),
    lowPrice24h: finiteOr(args.marketRow?.lowPrice24h, null),
    priceMove30sPct: args.context.priceMove30sPct,
    priceMove1mPct: args.context.priceMove1mPct,
    priceMove3mPct: args.context.priceMove3mPct,
    priceMove5mPct: args.context.priceMove5mPct,
    priceMove15mPct: args.context.priceMove15mPct,
    oiMove1mPct: args.context.oiMove1mPct,
    oiMove5mPct: args.context.oiMove5mPct,
    oiMove15mPct: args.context.oiMove15mPct ?? null,
    oiMove1hPct: args.context.oiMove1hPct ?? null,
    oiAccelerationPct: args.context.oiAccelerationPct,
    volumeBurst1m: args.context.volumeBurst1m,
    volumeBurst3m: args.context.volumeBurst3m,
    turnoverBurst1m: args.context.turnoverBurst1m,
    turnoverBurst3m: args.context.turnoverBurst3m,
    trades1m: args.context.trades1m,
    universeRank: args.context.universeRank,
    universeSize: args.context.universeSize,
    cvdDelta: args.cvd.cvdDelta,
    cvdImbalanceRatio: args.cvd.cvdImbalanceRatio,
    divergencePriceUpCvdDown: args.cvd.divergencePriceUpCvdDown,
    divergencePriceDownCvdUp: args.cvd.divergencePriceDownCvdUp,
    liquidation: args.liquidation,
    orderbook: args.orderbook,
    longShortRatio: args.longShortRatio,
  };
}
