import { describe, expect, it } from "vitest";
import { getBotDefinition } from "../bots/registry.js";
import { ShortExhaustionSignalEngine } from "../engine/ShortExhaustionSignalEngine.js";

describe("ShortExhaustionSignalEngine candidate thresholds", () => {
  function makeEngine() {
    const botDef = getBotDefinition();
    return new ShortExhaustionSignalEngine(botDef.defaults);
  }

  it("uses configured candidate thresholds without relaxing them", () => {
    const botDef = getBotDefinition();
    const defaults = structuredClone(botDef.defaults);
    const cfg = botDef.normalizeBotConfig({
      ...defaults,
      candidate: {
        ...defaults.candidate,
        minPriceMove1mPct: 0.9,
        minPriceMove3mPct: 2.0,
        minPriceMove5mPct: 3.8,
        minPriceMove15mPct: 6.0,
        minVolumeBurstRatio: 2.2,
        minTurnoverBurstRatio: 2.2,
        maxUniverseRank: 3,
        minTurnover24hUsd: 35_000_000,
        maxTurnover24hUsd: 60_000_000,
        minOpenInterestValueUsd: 5_000_000,
        minTrades1m: 50,
        maxSpreadBps: 20,
        minDistanceFromLow24hPct: 8,
        minNearDepthUsd: 30_000,
        candidateScoreMin: 1.4,
      },
    });

    const engine = new ShortExhaustionSignalEngine(cfg);
    const thresholds = (engine as any).getCandidateThresholds() as Record<string, number | null>;

    expect(thresholds.minPriceMove1mPct).toBe(0.9);
    expect(thresholds.minPriceMove3mPct).toBe(2.0);
    expect(thresholds.minPriceMove5mPct).toBe(3.8);
    expect(thresholds.minPriceMove15mPct).toBe(6.0);
    expect(thresholds.minVolumeBurstRatio).toBe(2.2);
    expect(thresholds.minTurnoverBurstRatio).toBe(2.2);
    expect(thresholds.maxUniverseRank).toBe(3);
    expect(thresholds.minTurnover24hUsd).toBe(35_000_000);
    expect(thresholds.maxTurnover24hUsd).toBe(60_000_000);
    expect(thresholds.minOpenInterestValueUsd).toBe(5_000_000);
    expect(thresholds.minTrades1m).toBe(50);
    expect(thresholds.maxSpreadBps).toBe(20);
    expect(thresholds.minDistanceFromLow24hPct).toBe(8);
    expect(thresholds.minNearDepthUsd).toBe(30_000);
    expect(thresholds.candidateScoreMin).toBe(1.4);
  });

  it("marks a strong candidate fast-scalp setup as tradeable", () => {
    const advisory = (makeEngine() as any).computeAdvisoryVerdict({
      state: "CANDIDATE",
      totalScore: 1.74,
      derivativesScore: 0.61,
      exhaustionScore: 0,
      reasons: ["candidate:price_impulse", "candidate:activity_burst", "candidate:universe_rank"],
      hardRejectReasons: [],
      suppressionReasons: [],
      summaryReason: "candidate_not_trade_ready",
      biasLabel: "REVERSAL_BIAS",
      isSoftFinalSignal: false,
      isFinalShortSignal: false,
    });

    expect(advisory).toEqual({
      advisoryVerdict: "TRADEABLE",
      advisoryReason: "candidate_fast_scalp_setup",
    });
  });

  it("keeps weak liquidity-floor candidates out of live trading", () => {
    const advisory = (makeEngine() as any).computeAdvisoryVerdict({
      state: "CANDIDATE",
      totalScore: 1.4,
      derivativesScore: 0.4,
      exhaustionScore: 0,
      reasons: ["candidate:liquidity_floor"],
      hardRejectReasons: [],
      suppressionReasons: ["derivatives_oi_cluster_missing"],
      summaryReason: "derivatives_oi_cluster_missing",
      biasLabel: "NEUTRAL",
      isSoftFinalSignal: false,
      isFinalShortSignal: false,
    });

    expect(advisory).toEqual({
      advisoryVerdict: "OBSERVE_ONLY",
      advisoryReason: "liquidity_floor_scalp_candidate",
    });
  });

  it("does not boost candidate score from orderbook depth", () => {
    const engine = makeEngine() as any;
    const baseInput = {
      symbol: "RAVEUSDT",
      priceMove1mPct: 1.2,
      priceMove3mPct: 2.5,
      priceMove5mPct: 3.6,
      priceMove15mPct: 5.8,
      volumeBurst1m: 2.4,
      volumeBurst3m: 1.8,
      turnoverBurst1m: 2.3,
      turnoverBurst3m: 1.7,
      universeRank: 2,
      turnover24hUsd: 45_000_000,
      openInterestValue: 7_500_000,
      trades1m: 120,
      spreadBps: 6,
      highPrice24h: 1.5,
      lowPrice24h: 1,
      markPrice: 1.2,
      orderbook: {
        totalDepthNearUsd: 0,
      },
    };

    const shallowBook = engine.evaluateCandidate(baseInput, []);
    const deepBook = engine.evaluateCandidate({
      ...baseInput,
      orderbook: {
        totalDepthNearUsd: 250_000,
      },
    }, []);

    expect(deepBook.score).toBe(shallowBook.score);
  });
});
