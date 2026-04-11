import { ShortExhaustionSignalEngine } from "./ShortExhaustionSignalEngine.js";

const proto = ShortExhaustionSignalEngine.prototype as any;

if (!proto.__noSoftFinalPatchApplied) {
  proto.__noSoftFinalPatchApplied = true;

  proto.evaluate = function patchedEvaluate(input: any) {
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
    const derivativeSoftBlockers = derivativesResult.blockers.filter((value: string) => derivativeSoftBlockerSet.has(value));
    const derivativeHardBlockers = derivativesResult.blockers.filter((value: string) => !derivativeSoftBlockerSet.has(value));
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

    const totalScore = Number((candidateResult.score + derivativesResult.score + exhaustionScore + microstructureResult.score).toFixed(4));
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

    let stage: any = "IDLE";
    if (isFinalShortSignal) stage = "FINAL_SHORT_SIGNAL";
    else if (fastScalpConfirmed || isExhaustionConfirmed) stage = "EXHAUSTION_CONFIRMED";
    else if (isDerivativesConfirmed) stage = "DERIVATIVES_CONFIRMED";
    else if (isCandidate) stage = "CANDIDATE";

    let state: any = "IDLE";
    if (isFinalShortSignal) state = "FINAL";
    else if (isCandidate && isDerivativesConfirmed && isExhaustionConfirmed && isMicrostructureVetoed) state = "SUPPRESSED";
    else if (fastScalpConfirmed || (isCandidate && isDerivativesConfirmed && isExhaustionConfirmed)) state = "CONFIRMED";
    else if (isCandidate && isDerivativesConfirmed) state = "WATCHLIST";
    else if (isCandidate) state = "CANDIDATE";
    else if (candidateResult.blockers.length > 0) state = "REJECTED";
    else if (suppressionReasons.length > 0) state = "SUPPRESSED";

    const summaryReason = isFinalShortSignal
      ? "final_short_signal"
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
      isSoftFinalSignal: false,
      isFinalShortSignal,
    });

    return {
      ts: input.ts,
      symbol: input.symbol,
      stage,
      state,
      candidateScore: Number(candidateResult.score.toFixed(4)),
      derivativesScore: Number(derivativesResult.score.toFixed(4)),
      exhaustionScore: Number(exhaustionScore.toFixed(4)),
      microstructureScore: Number(microstructureResult.score.toFixed(4)),
      totalScore,
      isCandidate,
      isDerivativesConfirmed,
      isExhaustionConfirmed,
      isMicrostructureConfirmed,
      isMicrostructureVetoed,
      isHardRejected,
      isSoftFinalSignal: false,
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
        softFinalReason: null,
        softFinalSignal: false,
        biasLabel,
        reversalBiasScore,
        squeezeRiskScore,
        fastScalpConfirmed,
      },
    };
  };
}
