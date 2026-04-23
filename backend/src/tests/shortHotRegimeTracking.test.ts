import { describe, expect, it } from "vitest";
import { getBotDefinition } from "../bots/registry.js";
import type { ShortExhaustionSignalSnapshot } from "../engine/ShortExhaustionSignalEngine.js";
import {
  applyHotRegimeTrackingSnapshot,
  buildShortCandidateSignature,
  shouldSuppressRepeatedCandidateCluster,
  type HotRegimeGateState,
} from "../api/shortHotRegimeTracking.js";

function makeGateState(): HotRegimeGateState {
  return {
    lastState: null,
    lastCandidateClusterAtMs: 0,
    lastCandidateScore: null,
    lastCandidateSignature: null,
    hotRegimeActive: false,
    hotRegimeEnteredAtMs: 0,
    hotRegimeLastActiveAtMs: 0,
    hotRegimeUntilMs: 0,
  };
}

function makeSnapshot(overrides?: Partial<ShortExhaustionSignalSnapshot>): ShortExhaustionSignalSnapshot {
  return {
    ts: 1_000,
    symbol: "RAVEUSDT",
    stage: "CANDIDATE",
    state: "CANDIDATE",
    candidateScore: 1.45,
    derivativesScore: 0.45,
    exhaustionScore: 0.2,
    microstructureScore: 0.1,
    totalScore: 2.2,
    isCandidate: true,
    isDerivativesConfirmed: false,
    isExhaustionConfirmed: false,
    isMicrostructureConfirmed: false,
    isMicrostructureVetoed: false,
    isHardRejected: false,
    isSoftFinalSignal: false,
    isFinalShortSignal: false,
    reasons: ["candidate:price_impulse", "candidate:activity_burst"],
    hardRejectReasons: [],
    suppressionReasons: [],
    summaryReason: "candidate_price_impulse",
    advisoryVerdict: "OBSERVE_ONLY",
    advisoryReason: "candidate_needs_one_more_push",
    biasLabel: "NEUTRAL",
    reversalBiasScore: 0.9,
    squeezeRiskScore: 0.45,
    signalVersion: "short-exhaustion-v1",
    featureSchemaVersion: "short-exhaustion-features-v3",
    metrics: {
      priceMove5mPct: 3.4,
      priceMove15mPct: 5.6,
      oiMove5mPct: 1.1,
      volumeBurst1m: 2.1,
      turnoverBurst1m: 2.1,
    },
    ...overrides,
  };
}

describe("hot regime tracking", () => {
  const botDef = getBotDefinition();
  const hotCfg = botDef.normalizeBotConfig({
    ...botDef.defaults,
    observe: {
      ...botDef.defaults.observe,
      useHotRegimeTracking: true,
    },
  });

  it("keeps symbols on watchlist during the sticky hot regime window", () => {
    const gate = makeGateState();
    applyHotRegimeTrackingSnapshot(makeSnapshot(), gate, hotCfg);

    const stickySnapshot = applyHotRegimeTrackingSnapshot(
      makeSnapshot({
        ts: 20 * 60_000,
        stage: "IDLE",
        state: "REJECTED",
        isCandidate: false,
        candidateScore: 0.45,
        totalScore: 0.8,
        summaryReason: "candidate_price_impulse_missing",
        metrics: {},
      }),
      gate,
      hotCfg,
    );

    expect(stickySnapshot.state).toBe("WATCHLIST");
    expect(stickySnapshot.stage).toBe("WATCHLIST");
    expect(stickySnapshot.summaryReason).toBe("hot_regime_active");

    const cooledOffSnapshot = applyHotRegimeTrackingSnapshot(
      makeSnapshot({
        ts: 31 * 60_000,
        stage: "IDLE",
        state: "REJECTED",
        isCandidate: false,
        candidateScore: 0.35,
        totalScore: 0.7,
        summaryReason: "candidate_price_impulse_missing",
        metrics: {},
      }),
      gate,
      hotCfg,
    );

    expect(cooledOffSnapshot.state).toBe("REJECTED");
  });

  it("allows renewed candidate windows in hot mode while legacy still suppresses them", () => {
    const firstCandidate = makeSnapshot({
      ts: 60_000,
      totalScore: 2.1,
    });
    const gate = makeGateState();
    gate.lastCandidateClusterAtMs = firstCandidate.ts;
    gate.lastCandidateScore = firstCandidate.totalScore;
    gate.lastCandidateSignature = buildShortCandidateSignature(firstCandidate);

    const renewedCandidate = makeSnapshot({
      ts: firstCandidate.ts + 6 * 60_000,
      totalScore: 2.18,
    });

    expect(shouldSuppressRepeatedCandidateCluster(renewedCandidate, gate, false)).toBe(true);
    expect(shouldSuppressRepeatedCandidateCluster(renewedCandidate, gate, true)).toBe(false);
  });
});
