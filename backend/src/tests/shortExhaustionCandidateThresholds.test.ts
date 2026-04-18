import { describe, expect, it } from "vitest";
import { getBotDefinition } from "../bots/registry.js";
import { ShortExhaustionSignalEngine } from "../engine/ShortExhaustionSignalEngine.js";

describe("ShortExhaustionSignalEngine candidate thresholds", () => {
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
});
