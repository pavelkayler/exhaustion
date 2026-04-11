import { CONFIG } from "../config.js";

export const SHORT_EXHAUSTION_BOT_ID = "short-exhaustion-v1";
export const DEFAULT_BOT_ID = SHORT_EXHAUSTION_BOT_ID;

export type ShortExhaustionBotConfig = {
  fundingCooldown: {
    beforeMin: number;
    afterMin: number;
  };
  signals: {};
  candidate: {
    minPriceMove1mPct: number;
    minPriceMove3mPct: number;
    minPriceMove5mPct: number;
    minPriceMove15mPct: number;
    minVolumeBurstRatio: number;
    minTurnoverBurstRatio: number;
    maxUniverseRank: number;
    minTurnover24hUsd: number;
    maxTurnover24hUsd: number | null;
    minOpenInterestValueUsd: number;
    minTrades1m: number;
    maxSpreadBps: number;
    minDistanceFromLow24hPct: number;
    minNearDepthUsd: number;
    candidateScoreMin: number;
  };
  derivatives: {
    minOiMove1mPct: number;
    minOiMove5mPct: number;
    minOiAccelerationPct: number;
    minFundingAbsPct: number;
    useLongShortRatio: boolean;
    minLongShortRatio: number;
    longShortRatioWeight: number;
    minShortLiquidationUsd60s: number;
    minShortLiquidationBurstRatio60s: number;
    minShortLiquidationImbalance60s: number;
    derivativesScoreMin: number;
  };
  exhaustion: {
    maxPriceContinuation30sPct: number;
    maxPriceContinuation1mPct: number;
    maxOiAccelerationPct: number;
    minNegativeCvdDelta: number;
    minNegativeCvdImbalance: number;
    exhaustionScoreMin: number;
  };
  microstructure: {
    minAskToBidDepthRatio: number;
    minSellSideImbalance: number;
    maxNearestAskWallBps: number;
    minNearestBidWallBps: number;
    maxSpreadBps: number;
    minNearDepthUsd: number;
    microstructureScoreMin: number;
  };
  observe: {
    observeOnly: boolean;
    logCandidateTransitions: boolean;
    logWatchlistTransitions: boolean;
    logFinalSignals: boolean;
    totalScoreMin: number;
    minLogIntervalSec: number;
    signalVersion: string;
    featureSchemaVersion: string;
  };
  strategy: {
    signalTfMin: number;
    minBarsBetweenSignals: number;
    cooldownCandles: number;
    expiryCandles: number;
  };
};

export type BotConfig = ShortExhaustionBotConfig;

export type BotRegistryEntry = {
  id: string;
  name: string;
  defaults: BotConfig;
  normalizeBotConfig: (raw: unknown) => BotConfig;
  validateBotConfig: (cfg: BotConfig) => void;
};

function toFinite(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Math.floor(toFinite(value, fallback));
  return Math.min(max, Math.max(min, n));
}

function toNullablePositive(value: unknown, fallback: number | null): number | null {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return null;
  return n;
}

function normalizeShortExhaustionBotConfig(raw: unknown): ShortExhaustionBotConfig {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const funding = source.fundingCooldown ?? {};
  const candidate = source.candidate ?? {};
  const derivatives = source.derivatives ?? {};
  const exhaustion = source.exhaustion ?? {};
  const microstructure = source.microstructure ?? {};
  const observe = source.observe ?? {};
  const strategy = source.strategy ?? {};

  return {
    fundingCooldown: {
      beforeMin: toInt(funding.beforeMin, 0, 0, 240),
      afterMin: toInt(funding.afterMin, 0, 0, 240),
    },
    signals: {},
    candidate: {
      minPriceMove1mPct: Math.max(0, toFinite(candidate.minPriceMove1mPct ?? candidate.minFreshPriceMovePct, 0.8)),
      minPriceMove3mPct: Math.max(0, toFinite(candidate.minPriceMove3mPct ?? candidate.minPriceMovePct, 1.8)),
      minPriceMove5mPct: Math.max(0, toFinite(candidate.minPriceMove5mPct, 3)),
      minPriceMove15mPct: Math.max(0, toFinite(candidate.minPriceMove15mPct, 5)),
      minVolumeBurstRatio: Math.max(1, toFinite(candidate.minVolumeBurstRatio, 2)),
      minTurnoverBurstRatio: Math.max(1, toFinite(candidate.minTurnoverBurstRatio, 2)),
      maxUniverseRank: toInt(candidate.maxUniverseRank, 5, 1, 10_000),
      minTurnover24hUsd: Math.max(0, toFinite(candidate.minTurnover24hUsd, 15_000_000)),
      maxTurnover24hUsd: toNullablePositive(candidate.maxTurnover24hUsd, null),
      minOpenInterestValueUsd: Math.max(0, toFinite(candidate.minOpenInterestValueUsd, 3_000_000)),
      minTrades1m: toInt(candidate.minTrades1m, 25, 0, 100_000),
      maxSpreadBps: Math.max(0, toFinite(candidate.maxSpreadBps, 25)),
      minDistanceFromLow24hPct: Math.max(0, toFinite(candidate.minDistanceFromLow24hPct, 5)),
      minNearDepthUsd: Math.max(0, toFinite(candidate.minNearDepthUsd, 20_000)),
      candidateScoreMin: Math.max(0, toFinite(candidate.candidateScoreMin, 1.25)),
    },
    derivatives: {
      minOiMove1mPct: Math.max(0, toFinite(derivatives.minOiMove1mPct, 0.35)),
      minOiMove5mPct: Math.max(0, toFinite(derivatives.minOiMove5mPct ?? derivatives.minOiMovePct, 1.2)),
      minOiAccelerationPct: Math.max(0, toFinite(derivatives.minOiAccelerationPct, 0.05)),
      minFundingAbsPct: Math.max(0, toFinite(derivatives.minFundingAbsPct, 0.01)),
      useLongShortRatio: Boolean(derivatives.useLongShortRatio ?? false),
      minLongShortRatio: Math.max(0, toFinite(derivatives.minLongShortRatio, 1.1)),
      longShortRatioWeight: Math.max(0, toFinite(derivatives.longShortRatioWeight, 0.12)),
      minShortLiquidationUsd60s: Math.max(0, toFinite(derivatives.minShortLiquidationUsd60s, 25_000)),
      minShortLiquidationBurstRatio60s: Math.max(0, toFinite(derivatives.minShortLiquidationBurstRatio60s, 1.5)),
      minShortLiquidationImbalance60s: Math.max(0, toFinite(derivatives.minShortLiquidationImbalance60s, 0.2)),
      derivativesScoreMin: Math.max(0, toFinite(derivatives.derivativesScoreMin, 0.85)),
    },
    exhaustion: {
      maxPriceContinuation30sPct: Math.max(0.001, toFinite(exhaustion.maxPriceContinuation30sPct ?? exhaustion.maxFreshPriceContinuationPct, 0.3)),
      maxPriceContinuation1mPct: Math.max(0.001, toFinite(exhaustion.maxPriceContinuation1mPct, 0.9)),
      maxOiAccelerationPct: Math.max(0.001, toFinite(exhaustion.maxOiAccelerationPct ?? exhaustion.maxFreshOiAccelerationPct, 0.15)),
      minNegativeCvdDelta: Math.max(0, toFinite(exhaustion.minNegativeCvdDelta, 1)),
      minNegativeCvdImbalance: Math.max(0, toFinite(exhaustion.minNegativeCvdImbalance, 0.05)),
      exhaustionScoreMin: Math.max(0, toFinite(exhaustion.exhaustionScoreMin, 0.7)),
    },
    microstructure: {
      minAskToBidDepthRatio: Math.max(0.01, toFinite(microstructure.minAskToBidDepthRatio, 1.05)),
      minSellSideImbalance: Math.max(0, toFinite(microstructure.minSellSideImbalance, 0.04)),
      maxNearestAskWallBps: Math.max(0.01, toFinite(microstructure.maxNearestAskWallBps, 12)),
      minNearestBidWallBps: Math.max(0, toFinite(microstructure.minNearestBidWallBps, 8)),
      maxSpreadBps: Math.max(0.01, toFinite(microstructure.maxSpreadBps, 35)),
      minNearDepthUsd: Math.max(0, toFinite(microstructure.minNearDepthUsd, 15_000)),
      microstructureScoreMin: Math.max(0, toFinite(microstructure.microstructureScoreMin, 0.55)),
    },
    observe: {
      observeOnly: Boolean(observe.observeOnly ?? true),
      logCandidateTransitions: Boolean(observe.logCandidateTransitions ?? true),
      logWatchlistTransitions: Boolean(observe.logWatchlistTransitions ?? true),
      logFinalSignals: Boolean(observe.logFinalSignals ?? true),
      totalScoreMin: Math.max(0, toFinite(observe.totalScoreMin, 2.75)),
      minLogIntervalSec: toInt(observe.minLogIntervalSec, 30, 1, 86_400),
      signalVersion: String(observe.signalVersion ?? "short-exhaustion-v1").trim() || "short-exhaustion-v1",
      featureSchemaVersion: String(observe.featureSchemaVersion ?? "short-exhaustion-features-v3").trim() || "short-exhaustion-features-v3",
    },
    strategy: {
      signalTfMin: toInt(strategy.signalTfMin, 1, 1, 60),
      minBarsBetweenSignals: toInt(strategy.minBarsBetweenSignals, 1, 0, 10_000),
      cooldownCandles: toInt(strategy.cooldownCandles, 3, 0, 10_000),
      expiryCandles: toInt(strategy.expiryCandles, 3, 1, 10_000),
    },
  };
}

function validateShortExhaustionBotConfig(cfg: BotConfig): void {
  if (cfg.candidate.maxTurnover24hUsd != null && cfg.candidate.maxTurnover24hUsd < cfg.candidate.minTurnover24hUsd) {
    throw new Error("invalid_short_exhaustion_turnover_range");
  }
  if (cfg.candidate.maxUniverseRank < 1) {
    throw new Error("invalid_short_exhaustion_universe_rank");
  }
  if (cfg.microstructure.minNearestBidWallBps <= cfg.microstructure.maxNearestAskWallBps * 0.25) {
    throw new Error("invalid_short_exhaustion_wall_distances");
  }
}

const CURRENT_BOT: BotRegistryEntry = {
  id: SHORT_EXHAUSTION_BOT_ID,
  name: "Short Exhaustion",
  defaults: normalizeShortExhaustionBotConfig({
    fundingCooldown: {
      beforeMin: 0,
      afterMin: 0,
    },
    signals: {},
    candidate: {
      minPriceMove1mPct: 0.8,
      minPriceMove3mPct: 1.8,
      minPriceMove5mPct: 3,
      minPriceMove15mPct: 5,
      minVolumeBurstRatio: 2,
      minTurnoverBurstRatio: 2,
      maxUniverseRank: 5,
      minTurnover24hUsd: 15_000_000,
      maxTurnover24hUsd: null,
      minOpenInterestValueUsd: 3_000_000,
      minTrades1m: 25,
      maxSpreadBps: 25,
      minDistanceFromLow24hPct: 5,
      minNearDepthUsd: 20_000,
      candidateScoreMin: 1.25,
    },
    derivatives: {
      minOiMove1mPct: 0.35,
      minOiMove5mPct: 1.2,
      minOiAccelerationPct: 0.05,
      minFundingAbsPct: 0.01,
      useLongShortRatio: false,
      minLongShortRatio: 1.1,
      longShortRatioWeight: 0.12,
      minShortLiquidationUsd60s: 25_000,
      minShortLiquidationBurstRatio60s: 1.5,
      minShortLiquidationImbalance60s: 0.2,
      derivativesScoreMin: 0.85,
    },
    exhaustion: {
      maxPriceContinuation30sPct: 0.3,
      maxPriceContinuation1mPct: 0.9,
      maxOiAccelerationPct: 0.15,
      minNegativeCvdDelta: 1,
      minNegativeCvdImbalance: 0.05,
      exhaustionScoreMin: 0.7,
    },
    microstructure: {
      minAskToBidDepthRatio: 1.05,
      minSellSideImbalance: 0.04,
      maxNearestAskWallBps: 12,
      minNearestBidWallBps: 8,
      maxSpreadBps: 35,
      minNearDepthUsd: 15_000,
      microstructureScoreMin: 0.55,
    },
    observe: {
      observeOnly: true,
      logCandidateTransitions: true,
      logWatchlistTransitions: true,
      logFinalSignals: true,
      totalScoreMin: 2.75,
      minLogIntervalSec: 30,
      signalVersion: "short-exhaustion-v1",
      featureSchemaVersion: "short-exhaustion-features-v3",
    },
    strategy: {
      signalTfMin: 1,
      minBarsBetweenSignals: 1,
      cooldownCandles: 3,
      expiryCandles: 3,
    },
  }),
  normalizeBotConfig: normalizeShortExhaustionBotConfig,
  validateBotConfig: validateShortExhaustionBotConfig,
};

export function listBots(): Array<Pick<BotRegistryEntry, "id" | "name">> {
  return [{ id: CURRENT_BOT.id, name: CURRENT_BOT.name }];
}

export function getBotDefinition(_botId?: string | null): BotRegistryEntry {
  return CURRENT_BOT;
}
