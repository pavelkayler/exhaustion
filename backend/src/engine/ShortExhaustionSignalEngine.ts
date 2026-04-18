import type { ShortExhaustionBotConfig } from "../bots/registry.js";
import type { BybitLongShortRatioSnapshot } from "./BybitLongShortRatioStore.js";
import type { BybitOrderbookSummary } from "./BybitOrderbookStore.js";
import type { LiquidationWindowSnapshot } from "./LiquidationWindowStore.js";

export type ShortExhaustionSignalStage =
  | "IDLE"
  | "CANDIDATE"
  | "DERIVATIVES_CONFIRMED"
  | "EXHAUSTION_CONFIRMED"
  | "WATCHLIST"
  | "FINAL_SOFT_SIGNAL"
  | "FINAL_SHORT_SIGNAL";

export type ShortExhaustionSignalState =
  | "IDLE"
  | "CANDIDATE"
  | "WATCHLIST"
  | "CONFIRMED"
  | "SOFT_FINAL"
  | "FINAL"
  | "REJECTED"
  | "SUPPRESSED"
  | "EXPIRED";

export type ShortExhaustionAdvisoryVerdict = "NO_TRADE" | "OBSERVE_ONLY" | "TRADEABLE";
export type ShortExhaustionBiasLabel = "REVERSAL_BIAS" | "NEUTRAL" | "SQUEEZE_RISK";

export type ShortExhaustionSignalInput = {
  ts: number;
  symbol: string;
  markPrice: number | null;
  lastPrice: number | null;
  fundingRate: number;
  turnover24hUsd: number | null;
  openInterestValue: number | null;
  spreadBps: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;
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
  cvdDelta: number | null;
  cvdImbalanceRatio: number | null;
  divergencePriceUpCvdDown: boolean;
  divergencePriceDownCvdUp: boolean;
  liquidation: LiquidationWindowSnapshot;
  orderbook: BybitOrderbookSummary;
  longShortRatio: BybitLongShortRatioSnapshot;
};

export type ShortExhaustionSignalSnapshot = {
  ts: number;
  symbol: string;
  stage: ShortExhaustionSignalStage;
  state: ShortExhaustionSignalState;
  candidateScore: number;
  derivativesScore: number;
  exhaustionScore: number;
  microstructureScore: number;
  totalScore: number;
  isCandidate: boolean;
  isDerivativesConfirmed: boolean;
  isExhaustionConfirmed: boolean;
  isMicrostructureConfirmed: boolean;
  isMicrostructureVetoed: boolean;
  isHardRejected: boolean;
  isSoftFinalSignal?: boolean;
  isFinalShortSignal: boolean;
  reasons: string[];
  hardRejectReasons: string[];
  suppressionReasons: string[];
  summaryReason: string;
  advisoryVerdict: ShortExhaustionAdvisoryVerdict;
  advisoryReason: string;
  biasLabel: ShortExhaustionBiasLabel;
  reversalBiasScore: number;
  squeezeRiskScore: number;
  signalVersion: string;
  featureSchemaVersion: string;
  metrics: Record<string, number | string | boolean | null>;
};

type ScoreResult = {
  score: number;
  blockers: string[];
  vetoes?: string[];
};

type CandidateThresholds = {
  minPriceMove1mPct: number;
  minPriceMove3mPct: number;
  minPriceMove5mPct: number;
  minPriceMove15mPct: number;
  minVolumeBurstRatio: number;
  minTurnoverBurstRatio: number;
  maxUniverseRank: number;
  minTurnover24hUsd: number;
  minOpenInterestValueUsd: number;
  minTrades1m: number;
  maxSpreadBps: number;
  minDistanceFromLow24hPct: number;
  minNearDepthUsd: number;
  candidateScoreMin: number;
};

type DerivativeThresholds = {
  minOiMove1mPct: number;
  minOiMove5mPct: number;
  minOiAccelerationPct: number;
  minFundingAbsPct: number;
  minLongShortRatio: number;
  minShortLiquidationUsd60s: number;
  minShortLiquidationBurstRatio60s: number;
  minShortLiquidationImbalance60s: number;
  derivativesScoreMin: number;
};

type ExhaustionThresholds = {
  maxPriceContinuation30sPct: number;
  maxPriceContinuation1mPct: number;
  maxOiAccelerationPct: number;
  minNegativeCvdDelta: number;
  minNegativeCvdImbalance: number;
  exhaustionScoreMin: number;
};

type MicrostructureThresholds = {
  minAskToBidDepthRatio: number;
  minSellSideImbalance: number;
  maxNearestAskWallBps: number;
  minNearestBidWallBps: number;
  maxSpreadBps: number;
  minNearDepthUsd: number;
  microstructureScoreMin: number;
};

function scoreRatio(value: number | null, threshold: number, cap = 2): number {
  if (!Number.isFinite(value as number) || !(threshold > 0)) return 0;
  return Math.max(0, Math.min(cap, Number(value) / threshold));
}

function inverseRatio(value: number | null, threshold: number, cap = 2): number {
  if (!Number.isFinite(value as number) || !(threshold > 0)) return 0;
  return Math.max(0, Math.min(cap, threshold / Math.max(1e-8, Number(value))));
}

function rankScore(rank: number | null, maxRank: number): number {
  if (!Number.isFinite(rank as number) || !(maxRank > 0)) return 0;
  const normalized = 1 - ((Number(rank) - 1) / Math.max(1, maxRank));
  return Math.max(0, Math.min(1, normalized));
}

function round4(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
}

function maxFinite(values: Array<number | null | undefined>): number {
  let best = 0;
  for (const value of values) {
    const numeric = Number(value ?? 0);
    if (Number.isFinite(numeric) && numeric > best) best = numeric;
  }
  return best;
}

function countTruthy(values: boolean[]): number {
  return values.filter(Boolean).length;
}

function hasWeakOrMissing(values: string[]): boolean {
  return values.some((value) => {
    const normalized = String(value ?? "").toLowerCase();
    return normalized.includes("weak") || normalized.includes("missing") || normalized.includes("thin") || normalized.includes("partial");
  });
}

function minCeil(value: number, relaxedCeil: number): number {
  return Math.min(value, relaxedCeil);
}

function maxFloor(value: number, relaxedFloor: number): number {
  return Math.max(value, relaxedFloor);
}

export class ShortExhaustionSignalEngine {
  private cfg: ShortExhaustionBotConfig;

  constructor(cfg: ShortExhaustionBotConfig) {
    this.cfg = cfg;
  }

  applyConfig(cfg: ShortExhaustionBotConfig): void {
    this.cfg = cfg;
  }

  evaluate(input: ShortExhaustionSignalInput): ShortExhaustionSignalSnapshot {
    const reasons: string[] = [];
    const hardRejectReasons: string[] = [];
    const suppressionReasons: string[] = [];

    const candidateResult = this.evaluateCandidate(input, reasons);
    const candidateThresholds = this.getCandidateThresholds();
    hardRejectReasons.push(...candidateResult.blockers);
    const isCandidate = candidateResult.blockers.length === 0 && candidateResult.score >= candidateThresholds.candidateScoreMin;

    const derivativesResult = isCandidate ? this.evaluateDerivatives(input, reasons) : { score: 0, blockers: [] };
    suppressionReasons.push(...derivativesResult.blockers);
    const derivativeThresholds = this.getDerivativeThresholds();
    const strictDerivativesConfirmed = isCandidate && derivativesResult.blockers.length === 0 && derivativesResult.score >= derivativeThresholds.derivativesScoreMin;
    const derivativeSoftBlockerSet = new Set<string>(["derivatives_oi_cluster_thin", "derivatives_crowding_context_missing"]);
    const derivativeSoftBlockers = derivativesResult.blockers.filter((value) => derivativeSoftBlockerSet.has(value));
    const derivativeHardBlockers = derivativesResult.blockers.filter((value) => !derivativeSoftBlockerSet.has(value));
    const isDerivativesConfirmed = strictDerivativesConfirmed || (
      isCandidate
      && derivativeHardBlockers.length === 0
      && derivativeSoftBlockers.length <= 1
      && derivativesResult.score >= Math.max(0.58, derivativeThresholds.derivativesScoreMin * 0.9)
    );

    const exhaustionThresholds = this.getExhaustionThresholds();
    const exhaustionScore = isDerivativesConfirmed ? this.evaluateExhaustion(input, reasons) : 0;
    const strictExhaustionConfirmed = isDerivativesConfirmed && exhaustionScore >= exhaustionThresholds.exhaustionScoreMin;
    const isExhaustionConfirmed = strictExhaustionConfirmed || (
      isDerivativesConfirmed
      && exhaustionScore >= Math.max(0.32, exhaustionThresholds.exhaustionScoreMin * 0.82)
    );

    const microstructureResult = isExhaustionConfirmed ? this.evaluateMicrostructure(input, reasons) : { score: 0, blockers: [], vetoes: [] };
    suppressionReasons.push(...microstructureResult.blockers);
    hardRejectReasons.push(...(microstructureResult.vetoes ?? []));
    const microstructureThresholds = this.getMicrostructureThresholds();
    const isMicrostructureVetoed = (microstructureResult.vetoes?.length ?? 0) > 0;
    const isMicrostructureConfirmed = !isMicrostructureVetoed && microstructureResult.score >= microstructureThresholds.microstructureScoreMin;

    const totalScore = round4(candidateResult.score + derivativesResult.score + exhaustionScore + microstructureResult.score);
    const isHardRejected = hardRejectReasons.length > 0;
    const { biasLabel, reversalBiasScore, squeezeRiskScore } = this.computeBias(input, derivativesResult.score, exhaustionScore);

    const fastScalpConfirmed = isCandidate
      && !isHardRejected
      && biasLabel !== "SQUEEZE_RISK"
      && reversalBiasScore >= squeezeRiskScore - 0.05
      && totalScore >= Math.max(1.7, this.cfg.observe.totalScoreMin * 0.8)
      && (
        (derivativesResult.score >= Math.max(0.58, derivativeThresholds.derivativesScoreMin * 0.9) && exhaustionScore >= Math.max(0.32, exhaustionThresholds.exhaustionScoreMin * 0.82))
        || (derivativesResult.score >= Math.max(0.72, derivativeThresholds.derivativesScoreMin) && exhaustionScore >= 0.24)
      );

    const softFinalDerivativeBlockerSet = new Set<string>([
      "derivatives_oi_cluster_thin",
      "derivatives_crowding_context_missing",
      "funding_not_crowded_long",
    ]);
    const softFinalDerivativeBlockers = derivativesResult.blockers.filter((value) => softFinalDerivativeBlockerSet.has(value));
    const softFinalHardDerivativeBlockers = derivativesResult.blockers.filter((value) => !softFinalDerivativeBlockerSet.has(value));
    const softFinalEligible = !isHardRejected
      && !isMicrostructureVetoed
      && !fastScalpConfirmed
      && isCandidate
      && biasLabel !== "SQUEEZE_RISK"
      && softFinalDerivativeBlockers.length > 0
      && softFinalHardDerivativeBlockers.length === 0
      && derivativesResult.score >= Math.max(0.46, derivativeThresholds.derivativesScoreMin * 0.78)
      && exhaustionScore >= Math.max(0.26, exhaustionThresholds.exhaustionScoreMin * 0.76)
      && totalScore >= Math.max(2.2, this.cfg.observe.totalScoreMin * 0.84);

    const isFinalShortSignal = (
      isCandidate
      && isDerivativesConfirmed
      && isExhaustionConfirmed
      && !isMicrostructureVetoed
      && totalScore >= this.cfg.observe.totalScoreMin
    ) || (
      fastScalpConfirmed
      && !isMicrostructureVetoed
      && microstructureResult.score >= Math.max(0.36, microstructureThresholds.microstructureScoreMin * 0.9)
      && totalScore >= Math.max(2.1, this.cfg.observe.totalScoreMin * 0.78)
    );
    const isSoftFinalSignal = !isFinalShortSignal && softFinalEligible;

    let stage: ShortExhaustionSignalStage = "IDLE";
    if (isFinalShortSignal) stage = "FINAL_SHORT_SIGNAL";
    else if (isSoftFinalSignal) stage = "FINAL_SOFT_SIGNAL";
    else if (fastScalpConfirmed || isExhaustionConfirmed) stage = "EXHAUSTION_CONFIRMED";
    else if (isDerivativesConfirmed) stage = "DERIVATIVES_CONFIRMED";
    else if (isCandidate) stage = "CANDIDATE";

    let state: ShortExhaustionSignalState = "IDLE";
    if (isFinalShortSignal) state = "FINAL";
    else if (isSoftFinalSignal) state = "SOFT_FINAL";
    else if (isCandidate && isDerivativesConfirmed && isExhaustionConfirmed && isMicrostructureVetoed) state = "SUPPRESSED";
    else if (fastScalpConfirmed || (isCandidate && isDerivativesConfirmed && isExhaustionConfirmed)) state = "CONFIRMED";
    else if (isCandidate && isDerivativesConfirmed) state = "WATCHLIST";
    else if (isCandidate) state = "CANDIDATE";
    else if (candidateResult.blockers.length > 0) state = "REJECTED";
    else if (suppressionReasons.length > 0) state = "SUPPRESSED";

    const summaryReason = isFinalShortSignal
      ? "final_short_signal"
      : isSoftFinalSignal
        ? `soft_final_${softFinalDerivativeBlockers[0] ?? "signal"}`
      : fastScalpConfirmed && !strictExhaustionConfirmed
        ? "fast_scalp_confirmed"
        : hardRejectReasons[0]
          ?? suppressionReasons[0]
          ?? reasons[reasons.length - 1]
          ?? state.toLowerCase();

    const { advisoryVerdict, advisoryReason } = this.computeAdvisoryVerdict({
      state,
      totalScore,
      derivativesScore: derivativesResult.score,
      exhaustionScore,
      reasons,
      hardRejectReasons,
      suppressionReasons,
      summaryReason,
      biasLabel,
      isSoftFinalSignal,
      isFinalShortSignal,
    });

    return {
      ts: input.ts,
      symbol: input.symbol,
      stage,
      state,
      candidateScore: round4(candidateResult.score),
      derivativesScore: round4(derivativesResult.score),
      exhaustionScore: round4(exhaustionScore),
      microstructureScore: round4(microstructureResult.score),
      totalScore,
      isCandidate,
      isDerivativesConfirmed,
      isExhaustionConfirmed,
      isMicrostructureConfirmed,
      isMicrostructureVetoed,
      isHardRejected,
      isSoftFinalSignal,
      isFinalShortSignal,
      reasons,
      hardRejectReasons,
      suppressionReasons,
      summaryReason,
      advisoryVerdict,
      advisoryReason,
      biasLabel,
      reversalBiasScore,
      squeezeRiskScore,
      signalVersion: this.cfg.observe.signalVersion,
      featureSchemaVersion: this.cfg.observe.featureSchemaVersion,
      metrics: {
        priceMove30sPct: input.priceMove30sPct,
        priceMove1mPct: input.priceMove1mPct,
        priceMove3mPct: input.priceMove3mPct,
        priceMove5mPct: input.priceMove5mPct,
        priceMove15mPct: input.priceMove15mPct,
        oiMove1mPct: input.oiMove1mPct,
        oiMove5mPct: input.oiMove5mPct,
        oiMove15mPct: input.oiMove15mPct ?? null,
        oiMove1hPct: input.oiMove1hPct ?? null,
        oiAccelerationPct: input.oiAccelerationPct,
        volumeBurst1m: input.volumeBurst1m,
        volumeBurst3m: input.volumeBurst3m,
        turnoverBurst1m: input.turnoverBurst1m,
        turnoverBurst3m: input.turnoverBurst3m,
        trades1m: input.trades1m,
        universeRank: input.universeRank,
        universeSize: input.universeSize,
        fundingRate: input.fundingRate,
        turnover24hUsd: input.turnover24hUsd,
        openInterestValue: input.openInterestValue,
        spreadBps: input.spreadBps,
        low24hDistancePct: this.computeLow24hDistancePct(input),
        cvdDelta: input.cvdDelta,
        cvdImbalanceRatio: input.cvdImbalanceRatio,
        divergencePriceUpCvdDown: input.divergencePriceUpCvdDown,
        shortLiquidationUsd60s: input.liquidation.shortLiquidationUsd60s,
        longLiquidationUsd60s: input.liquidation.longLiquidationUsd60s,
        shortLiquidationBurstRatio60s: input.liquidation.shortLiquidationBurstRatio60s,
        shortLiquidationImbalance60s: input.liquidation.shortLiquidationImbalance60s,
        longShortBuyRatio: input.longShortRatio.buyRatio,
        longShortSellRatio: input.longShortRatio.sellRatio,
        longShortRatio: input.longShortRatio.longShortRatio,
        orderbookImbalanceRatio: input.orderbook.imbalanceRatio,
        askToBidDepthRatio: input.orderbook.askToBidDepthRatio,
        nearestAskWallBps: input.orderbook.nearestAskWallBps,
        nearestBidWallBps: input.orderbook.nearestBidWallBps,
        nearestAskWallSize: input.orderbook.nearestAskWallSize,
        nearestBidWallSize: input.orderbook.nearestBidWallSize,
        totalDepthNearUsd: input.orderbook.totalDepthNearUsd,
        advisoryVerdict,
        advisoryReason,
        softFinalReason: isSoftFinalSignal ? (softFinalDerivativeBlockers[0] ?? "soft_final_signal") : null,
        softFinalSignal: isSoftFinalSignal,
        biasLabel,
        reversalBiasScore,
        squeezeRiskScore,
        fastScalpConfirmed,
      },
    };
  }

  private getCandidateThresholds(): CandidateThresholds {
    return {
      minPriceMove1mPct: minCeil(this.cfg.candidate.minPriceMove1mPct, 0.6),
      minPriceMove3mPct: minCeil(this.cfg.candidate.minPriceMove3mPct, 1.2),
      minPriceMove5mPct: minCeil(this.cfg.candidate.minPriceMove5mPct, 2),
      minPriceMove15mPct: minCeil(this.cfg.candidate.minPriceMove15mPct, 3.5),
      minVolumeBurstRatio: minCeil(this.cfg.candidate.minVolumeBurstRatio, 1.65),
      minTurnoverBurstRatio: minCeil(this.cfg.candidate.minTurnoverBurstRatio, 1.65),
      maxUniverseRank: maxFloor(this.cfg.candidate.maxUniverseRank, 8),
      minTurnover24hUsd: Math.max(0, this.cfg.candidate.minTurnover24hUsd),
      minOpenInterestValueUsd: minCeil(this.cfg.candidate.minOpenInterestValueUsd, 2_000_000),
      minTrades1m: minCeil(this.cfg.candidate.minTrades1m, 14),
      maxSpreadBps: maxFloor(this.cfg.candidate.maxSpreadBps, 30),
      minDistanceFromLow24hPct: minCeil(this.cfg.candidate.minDistanceFromLow24hPct, 3),
      minNearDepthUsd: minCeil(this.cfg.candidate.minNearDepthUsd, 15_000),
      candidateScoreMin: minCeil(this.cfg.candidate.candidateScoreMin, 0.95),
    };
  }

  private evaluateCandidate(input: ShortExhaustionSignalInput, reasons: string[]): ScoreResult {
    const thresholds = this.getCandidateThresholds();
    const blockers: string[] = [];
    const low24hDistancePct = this.computeLow24hDistancePct(input);
    const priceRatios = [
      scoreRatio(input.priceMove1mPct, thresholds.minPriceMove1mPct, 1.45),
      scoreRatio(input.priceMove3mPct, thresholds.minPriceMove3mPct, 1.8),
      scoreRatio(input.priceMove5mPct, thresholds.minPriceMove5mPct, 1.9),
      scoreRatio(input.priceMove15mPct, thresholds.minPriceMove15mPct, 1.9),
    ];
    const hasPriceImpulse =
      (input.priceMove1mPct ?? 0) >= thresholds.minPriceMove1mPct * 1.1
      || (input.priceMove3mPct ?? 0) >= thresholds.minPriceMove3mPct
      || (input.priceMove5mPct ?? 0) >= thresholds.minPriceMove5mPct
      || (input.priceMove15mPct ?? 0) >= thresholds.minPriceMove15mPct;
    if (!hasPriceImpulse) blockers.push("candidate_price_impulse_missing");

    const strongestPriceRatio = maxFinite(priceRatios);
    const strongPriceImpulse = strongestPriceRatio >= 1.25;
    const volumeBurst = maxFinite([input.volumeBurst1m, input.volumeBurst3m]);
    const turnoverBurst = maxFinite([input.turnoverBurst1m, input.turnoverBurst3m]);
    if (volumeBurst < thresholds.minVolumeBurstRatio && turnoverBurst < thresholds.minTurnoverBurstRatio && !strongPriceImpulse) {
      blockers.push("candidate_activity_burst_missing");
    }
    if (input.universeRank == null || input.universeRank > thresholds.maxUniverseRank) {
      blockers.push("candidate_universe_rank_too_low");
    }
    if ((input.turnover24hUsd ?? 0) < thresholds.minTurnover24hUsd) {
      blockers.push("candidate_turnover_below_floor");
    }
    if (this.cfg.candidate.maxTurnover24hUsd != null && (input.turnover24hUsd ?? 0) > this.cfg.candidate.maxTurnover24hUsd) {
      blockers.push("candidate_turnover_above_cap");
    }
    if ((input.openInterestValue ?? 0) < thresholds.minOpenInterestValueUsd) {
      blockers.push("candidate_open_interest_below_floor");
    }
    if ((input.trades1m ?? 0) < thresholds.minTrades1m) {
      blockers.push("candidate_trade_activity_too_low");
    }
    if (low24hDistancePct != null && low24hDistancePct < thresholds.minDistanceFromLow24hPct && !strongPriceImpulse) {
      blockers.push("candidate_not_extended_enough");
    }

    let score = 0;
    score += strongestPriceRatio * 0.44;
    score += scoreRatio(turnoverBurst, thresholds.minTurnoverBurstRatio, 1.8) * 0.16;
    score += scoreRatio(volumeBurst, thresholds.minVolumeBurstRatio, 1.6) * 0.12;
    score += rankScore(input.universeRank, thresholds.maxUniverseRank) * 0.11;
    score += scoreRatio(input.turnover24hUsd, thresholds.minTurnover24hUsd, 1.4) * 0.06;
    score += scoreRatio(input.openInterestValue, thresholds.minOpenInterestValueUsd, 1.35) * 0.05;
    score += scoreRatio(input.trades1m, thresholds.minTrades1m, 1.35) * 0.03;
    score += inverseRatio(input.spreadBps, thresholds.maxSpreadBps, 1.4) * 0.015;
    score += scoreRatio(input.orderbook.totalDepthNearUsd, thresholds.minNearDepthUsd, 1.5) * 0.015;

    if (hasPriceImpulse) reasons.push("candidate:price_impulse");
    if (turnoverBurst >= thresholds.minTurnoverBurstRatio || volumeBurst >= thresholds.minVolumeBurstRatio || strongPriceImpulse) {
      reasons.push("candidate:activity_burst");
    }
    if (input.universeRank != null && input.universeRank <= thresholds.maxUniverseRank) {
      reasons.push("candidate:universe_rank");
    }
    if (
      (input.turnover24hUsd ?? 0) >= thresholds.minTurnover24hUsd
      && (input.openInterestValue ?? 0) >= thresholds.minOpenInterestValueUsd
      && (input.trades1m ?? 0) >= thresholds.minTrades1m
    ) {
      reasons.push("candidate:liquidity_floor");
    }

    return { score, blockers };
  }

  private getDerivativeThresholds(): DerivativeThresholds {
    return {
      minOiMove1mPct: minCeil(this.cfg.derivatives.minOiMove1mPct, 0.2),
      minOiMove5mPct: minCeil(this.cfg.derivatives.minOiMove5mPct, 0.7),
      minOiAccelerationPct: minCeil(this.cfg.derivatives.minOiAccelerationPct, 0.025),
      minFundingAbsPct: minCeil(this.cfg.derivatives.minFundingAbsPct, 0.005),
      minLongShortRatio: minCeil(this.cfg.derivatives.minLongShortRatio, 1.08),
      minShortLiquidationUsd60s: minCeil(this.cfg.derivatives.minShortLiquidationUsd60s, 12_000),
      minShortLiquidationBurstRatio60s: minCeil(this.cfg.derivatives.minShortLiquidationBurstRatio60s, 1.2),
      minShortLiquidationImbalance60s: minCeil(this.cfg.derivatives.minShortLiquidationImbalance60s, 0.1),
      derivativesScoreMin: minCeil(this.cfg.derivatives.derivativesScoreMin, 0.65),
    };
  }

  private evaluateDerivatives(input: ShortExhaustionSignalInput, reasons: string[]): ScoreResult {
    const thresholds = this.getDerivativeThresholds();
    const blockers: string[] = [];
    const fundingPctAbs = Math.abs(input.fundingRate) * 100;
    const longShortRatio = input.longShortRatio.longShortRatio;
    const oi1mReady = (input.oiMove1mPct ?? 0) >= thresholds.minOiMove1mPct;
    const oi5mReady = (input.oiMove5mPct ?? 0) >= thresholds.minOiMove5mPct;
    const oiAccelerationReady = (input.oiAccelerationPct ?? 0) >= thresholds.minOiAccelerationPct;
    const oiSupportCount = countTruthy([oi1mReady, oi5mReady, oiAccelerationReady]);

    const fundingCrowdedLong = input.fundingRate > 0 && fundingPctAbs >= thresholds.minFundingAbsPct * 0.65;
    const longShortReady = longShortRatio != null && longShortRatio >= thresholds.minLongShortRatio;
    const crowdingSupportCount = countTruthy([fundingCrowdedLong, longShortReady]);

    const liqUsdReady = (input.liquidation.shortLiquidationUsd60s ?? 0) >= thresholds.minShortLiquidationUsd60s;
    const liqBurstReady = (input.liquidation.shortLiquidationBurstRatio60s ?? 0) >= thresholds.minShortLiquidationBurstRatio60s;
    const liqImbalanceReady = (input.liquidation.shortLiquidationImbalance60s ?? 0) >= thresholds.minShortLiquidationImbalance60s;
    const liqSupportCount = countTruthy([liqUsdReady, liqBurstReady, liqImbalanceReady]);

    if (oiSupportCount === 0) blockers.push("derivatives_oi_cluster_missing");
    else if (oiSupportCount === 1) blockers.push("derivatives_oi_cluster_thin");
    if (crowdingSupportCount === 0 && liqSupportCount === 0) blockers.push("derivatives_crowding_context_missing");
    if (input.fundingRate < 0 && liqSupportCount === 0 && !longShortReady) blockers.push("funding_not_crowded_long");

    let score = 0;
    score += scoreRatio(input.oiMove1mPct, thresholds.minOiMove1mPct, 1.55) * 0.15;
    score += scoreRatio(input.oiMove5mPct, thresholds.minOiMove5mPct, 1.8) * 0.22;
    score += scoreRatio(input.oiAccelerationPct, thresholds.minOiAccelerationPct, 1.7) * 0.16;
    score += scoreRatio(fundingPctAbs, thresholds.minFundingAbsPct, 1.8) * 0.11;
    score += scoreRatio(input.liquidation.shortLiquidationUsd60s, thresholds.minShortLiquidationUsd60s, 1.7) * 0.12;
    score += scoreRatio(input.liquidation.shortLiquidationBurstRatio60s, thresholds.minShortLiquidationBurstRatio60s, 1.6) * 0.08;
    score += scoreRatio(input.liquidation.shortLiquidationImbalance60s, thresholds.minShortLiquidationImbalance60s, 1.45) * 0.08;
    if (this.cfg.derivatives.useLongShortRatio && longShortRatio != null) {
      score += scoreRatio(longShortRatio, thresholds.minLongShortRatio, 1.5) * this.cfg.derivatives.longShortRatioWeight;
    } else if (longShortRatio != null) {
      score += scoreRatio(longShortRatio, thresholds.minLongShortRatio, 1.45) * Math.max(this.cfg.derivatives.longShortRatioWeight * 0.5, 0.06);
    }
    if (oiSupportCount >= 2) score += 0.08;
    else if (oiSupportCount === 1) score += 0.03;
    if (liqSupportCount >= 2) score += 0.08;
    else if (liqSupportCount === 1) score += 0.03;
    if (crowdingSupportCount >= 1) score += 0.06;

    if (oiSupportCount >= 2) reasons.push("derivatives:oi_crowding_cluster");
    if (fundingCrowdedLong || longShortReady) reasons.push("derivatives:crowded_long_context");
    if (liqSupportCount >= 1) reasons.push("derivatives:short_liquidation_trap");
    if (score > 0.5) reasons.push("derivatives:crowded_long_pump");

    return { score, blockers };
  }

  private getExhaustionThresholds(): ExhaustionThresholds {
    return {
      maxPriceContinuation30sPct: maxFloor(this.cfg.exhaustion.maxPriceContinuation30sPct, 0.45),
      maxPriceContinuation1mPct: maxFloor(this.cfg.exhaustion.maxPriceContinuation1mPct, 1.15),
      maxOiAccelerationPct: maxFloor(this.cfg.exhaustion.maxOiAccelerationPct, 0.22),
      minNegativeCvdDelta: minCeil(this.cfg.exhaustion.minNegativeCvdDelta, 0.6),
      minNegativeCvdImbalance: minCeil(this.cfg.exhaustion.minNegativeCvdImbalance, 0.03),
      exhaustionScoreMin: minCeil(this.cfg.exhaustion.exhaustionScoreMin, 0.42),
    };
  }

  private evaluateExhaustion(input: ShortExhaustionSignalInput, reasons: string[]): number {
    const thresholds = this.getExhaustionThresholds();
    let score = 0;
    score += inverseRatio(input.priceMove30sPct, thresholds.maxPriceContinuation30sPct, 1.9) * 0.22;
    score += inverseRatio(input.priceMove1mPct, thresholds.maxPriceContinuation1mPct, 1.75) * 0.18;
    score += inverseRatio(input.oiAccelerationPct, thresholds.maxOiAccelerationPct, 1.6) * 0.16;
    if ((input.priceMove30sPct ?? Number.POSITIVE_INFINITY) <= thresholds.maxPriceContinuation30sPct) score += 0.08;
    if ((input.priceMove1mPct ?? Number.POSITIVE_INFINITY) <= thresholds.maxPriceContinuation1mPct) score += 0.06;
    if ((input.oiAccelerationPct ?? Number.POSITIVE_INFINITY) <= thresholds.maxOiAccelerationPct) score += 0.05;
    if ((input.priceMove30sPct ?? 0) <= 0) score += 0.06;
    if (
      input.priceMove1mPct != null
      && input.priceMove3mPct != null
      && input.priceMove3mPct > 0
      && input.priceMove1mPct <= input.priceMove3mPct * 0.42
    ) {
      score += 0.05;
    }
    if (input.divergencePriceUpCvdDown) score += 0.15;
    if ((input.cvdDelta ?? 0) <= -thresholds.minNegativeCvdDelta) score += 0.09;
    if ((input.cvdImbalanceRatio ?? 0) <= -thresholds.minNegativeCvdImbalance) score += 0.07;
    if ((input.priceMove30sPct ?? Number.POSITIVE_INFINITY) <= thresholds.maxPriceContinuation30sPct && (input.liquidation.shortLiquidationUsd60s ?? 0) > 0) {
      score += 0.06;
    }
    if (score > 0.3) reasons.push("exhaustion:follow_through_failed");
    return score;
  }

  private getMicrostructureThresholds(): MicrostructureThresholds {
    return {
      minAskToBidDepthRatio: minCeil(this.cfg.microstructure.minAskToBidDepthRatio, 1.02),
      minSellSideImbalance: minCeil(this.cfg.microstructure.minSellSideImbalance, 0.02),
      maxNearestAskWallBps: maxFloor(this.cfg.microstructure.maxNearestAskWallBps, 16),
      minNearestBidWallBps: minCeil(this.cfg.microstructure.minNearestBidWallBps, 6),
      maxSpreadBps: maxFloor(this.cfg.microstructure.maxSpreadBps, 40),
      minNearDepthUsd: minCeil(this.cfg.microstructure.minNearDepthUsd, 12_000),
      microstructureScoreMin: minCeil(this.cfg.microstructure.microstructureScoreMin, 0.42),
    };
  }

  private evaluateMicrostructure(input: ShortExhaustionSignalInput, reasons: string[]): ScoreResult {
    const thresholds = this.getMicrostructureThresholds();
    const blockers: string[] = [];
    const vetoes: string[] = [];
    const imbalance = input.orderbook.imbalanceRatio != null ? -input.orderbook.imbalanceRatio : null;

    if ((input.orderbook.askToBidDepthRatio ?? 0) < thresholds.minAskToBidDepthRatio) {
      blockers.push("ask_depth_not_dominant");
    }
    if ((imbalance ?? 0) < thresholds.minSellSideImbalance) {
      blockers.push("orderbook_sell_imbalance_missing");
    }
    if ((input.orderbook.nearestAskWallBps ?? Number.POSITIVE_INFINITY) > thresholds.maxNearestAskWallBps) {
      blockers.push("nearby_ask_wall_missing");
    }
    if ((input.orderbook.nearestBidWallBps ?? 0) < thresholds.minNearestBidWallBps) {
      blockers.push("bid_fragility_missing");
    }
    if ((input.spreadBps ?? Number.POSITIVE_INFINITY) > thresholds.maxSpreadBps) {
      vetoes.push("microstructure_spread_too_wide");
    }
    if ((input.orderbook.totalDepthNearUsd ?? 0) < thresholds.minNearDepthUsd) {
      vetoes.push("microstructure_near_depth_too_thin");
    }

    let score = 0;
    score += scoreRatio(input.orderbook.askToBidDepthRatio, thresholds.minAskToBidDepthRatio, 1.7) * 0.28;
    score += scoreRatio(imbalance, thresholds.minSellSideImbalance, 1.6) * 0.22;
    score += inverseRatio(input.orderbook.nearestAskWallBps, thresholds.maxNearestAskWallBps, 1.5) * 0.16;
    score += scoreRatio(input.orderbook.nearestBidWallBps, thresholds.minNearestBidWallBps, 1.5) * 0.12;
    score += inverseRatio(input.spreadBps, thresholds.maxSpreadBps, 1.4) * 0.12;
    score += scoreRatio(input.orderbook.totalDepthNearUsd, thresholds.minNearDepthUsd, 1.5) * 0.1;

    if (score > 0.34) reasons.push("microstructure:ask_pressure_above");
    return { score, blockers, vetoes };
  }

  private computeLow24hDistancePct(input: ShortExhaustionSignalInput): number | null {
    const price = Number(input.markPrice ?? input.lastPrice ?? 0);
    const low = Number(input.lowPrice24h ?? 0);
    if (!(price > 0) || !(low > 0)) return null;
    return ((price - low) / low) * 100;
  }

  private computeBias(
    input: ShortExhaustionSignalInput,
    derivativesScore: number,
    exhaustionScore: number,
  ): { biasLabel: ShortExhaustionBiasLabel; reversalBiasScore: number; squeezeRiskScore: number } {
    const derivativeThresholds = this.getDerivativeThresholds();
    const exhaustionThresholds = this.getExhaustionThresholds();
    const microstructureThresholds = this.getMicrostructureThresholds();
    const fundingPctAbs = Math.abs(input.fundingRate) * 100;
    const longShortRatio = input.longShortRatio.longShortRatio;
    let reversalBiasScore = 0;
    let squeezeRiskScore = 0;

    reversalBiasScore += inverseRatio(input.priceMove30sPct, exhaustionThresholds.maxPriceContinuation30sPct, 1.7) * 0.18;
    reversalBiasScore += inverseRatio(input.priceMove1mPct, exhaustionThresholds.maxPriceContinuation1mPct, 1.5) * 0.14;
    reversalBiasScore += inverseRatio(input.oiAccelerationPct, exhaustionThresholds.maxOiAccelerationPct, 1.5) * 0.14;
    reversalBiasScore += Math.min(1.6, derivativesScore) * 0.16;
    reversalBiasScore += Math.min(1.6, exhaustionScore) * 0.18;
    reversalBiasScore += scoreRatio(fundingPctAbs, derivativeThresholds.minFundingAbsPct, 1.4) * 0.08;
    reversalBiasScore += scoreRatio(longShortRatio, derivativeThresholds.minLongShortRatio, 1.3) * 0.06;
    if (input.divergencePriceUpCvdDown) reversalBiasScore += 0.18;
    if ((input.liquidation.shortLiquidationUsd60s ?? 0) >= derivativeThresholds.minShortLiquidationUsd60s) reversalBiasScore += 0.12;

    squeezeRiskScore += scoreRatio(input.priceMove30sPct, exhaustionThresholds.maxPriceContinuation30sPct, 1.8) * 0.2;
    squeezeRiskScore += scoreRatio(input.priceMove1mPct, exhaustionThresholds.maxPriceContinuation1mPct, 1.6) * 0.16;
    squeezeRiskScore += scoreRatio(input.oiAccelerationPct, derivativeThresholds.minOiAccelerationPct, 1.8) * 0.16;
    squeezeRiskScore += scoreRatio(input.oiMove1mPct, derivativeThresholds.minOiMove1mPct, 1.6) * 0.12;
    squeezeRiskScore += scoreRatio(input.oiMove5mPct, derivativeThresholds.minOiMove5mPct, 1.6) * 0.14;
    squeezeRiskScore += scoreRatio(fundingPctAbs, derivativeThresholds.minFundingAbsPct, 1.5) * 0.08;
    squeezeRiskScore += scoreRatio(longShortRatio, derivativeThresholds.minLongShortRatio, 1.5) * 0.08;
    if (!input.divergencePriceUpCvdDown) squeezeRiskScore += 0.12;
    if ((input.orderbook.askToBidDepthRatio ?? 0) < microstructureThresholds.minAskToBidDepthRatio) squeezeRiskScore += 0.08;

    reversalBiasScore = round4(reversalBiasScore);
    squeezeRiskScore = round4(squeezeRiskScore);
    let biasLabel: ShortExhaustionBiasLabel = "NEUTRAL";
    if (reversalBiasScore >= squeezeRiskScore + 0.15) biasLabel = "REVERSAL_BIAS";
    else if (squeezeRiskScore >= reversalBiasScore + 0.15) biasLabel = "SQUEEZE_RISK";
    return { biasLabel, reversalBiasScore, squeezeRiskScore };
  }

  private computeAdvisoryVerdict(args: {
    state: ShortExhaustionSignalState;
    totalScore: number;
    derivativesScore: number;
    exhaustionScore: number;
    reasons: string[];
    hardRejectReasons: string[];
    suppressionReasons: string[];
    summaryReason: string;
    biasLabel: ShortExhaustionBiasLabel;
    isSoftFinalSignal: boolean;
    isFinalShortSignal: boolean;
  }): { advisoryVerdict: ShortExhaustionAdvisoryVerdict; advisoryReason: string } {
    const { state, totalScore, derivativesScore, exhaustionScore, reasons, hardRejectReasons, suppressionReasons, summaryReason, biasLabel, isSoftFinalSignal, isFinalShortSignal } = args;
    const isLiquidityFloorCandidate = reasons.includes("candidate:liquidity_floor");
    const weakSuppression = hasWeakOrMissing(suppressionReasons);
    const derivativesWeak = summaryReason === "derivatives_oi_cluster_thin"
      || summaryReason === "derivatives_oi_cluster_missing"
      || suppressionReasons.some((value) => String(value ?? "").startsWith("derivatives_oi_"));

    if (isFinalShortSignal) {
      return { advisoryVerdict: "TRADEABLE", advisoryReason: "confirmed_signal_ready" };
    }
    if (isSoftFinalSignal || state === "SOFT_FINAL") {
      return { advisoryVerdict: "TRADEABLE", advisoryReason: "soft_final_signal_ready" };
    }
    if (state === "CONFIRMED") {
      return { advisoryVerdict: "TRADEABLE", advisoryReason: "confirmed_signal_ready" };
    }
    if (state === "WATCHLIST") {
      return {
        advisoryVerdict: biasLabel === "SQUEEZE_RISK" ? "NO_TRADE" : "OBSERVE_ONLY",
        advisoryReason: biasLabel === "SQUEEZE_RISK" ? "watchlist_but_squeeze_risk" : "watchlist_wait_for_confirmation",
      };
    }
    if (state === "SUPPRESSED" || state === "REJECTED" || state === "EXPIRED") {
      return { advisoryVerdict: "NO_TRADE", advisoryReason: summaryReason || state.toLowerCase() };
    }
    if (state === "CANDIDATE") {
      if (hardRejectReasons.length > 0 || biasLabel === "SQUEEZE_RISK") {
        return { advisoryVerdict: "NO_TRADE", advisoryReason: hardRejectReasons[0] ?? suppressionReasons[0] ?? "candidate_too_weak" };
      }
      if (isLiquidityFloorCandidate && derivativesWeak && totalScore >= 1.35) {
        return { advisoryVerdict: "OBSERVE_ONLY", advisoryReason: "liquidity_floor_scalp_candidate" };
      }
      if (!weakSuppression && derivativesScore >= 0.58 && exhaustionScore >= 0.24 && totalScore >= 1.7) {
        return { advisoryVerdict: "OBSERVE_ONLY", advisoryReason: "candidate_fast_scalp_setup" };
      }
      if (isLiquidityFloorCandidate && totalScore >= 1.55) {
        return { advisoryVerdict: "OBSERVE_ONLY", advisoryReason: "candidate_needs_one_more_push" };
      }
      return { advisoryVerdict: "NO_TRADE", advisoryReason: "candidate_not_trade_ready" };
    }
    return { advisoryVerdict: "NO_TRADE", advisoryReason: state.toLowerCase() };
  }
}
