import type { ShortExhaustionBotConfig } from "../bots/registry.js";
import type {
  ShortExhaustionSignalSnapshot,
  ShortExhaustionSignalStage,
  ShortExhaustionSignalState,
} from "../engine/ShortExhaustionSignalEngine.js";

export const HOT_REGIME_MIN_STICKY_MS = 30 * 60_000;
export const HOT_REGIME_REPEAT_SUPPRESSION_MS = 2 * 60_000;
export const HOT_REGIME_REPEAT_MIN_SCORE_DELTA = 0.35;

export type HotRegimeGateState = {
  lastState: ShortExhaustionSignalState | null;
  lastCandidateClusterAtMs: number;
  lastCandidateScore: number | null;
  lastCandidateSignature: string | null;
  hotRegimeActive: boolean;
  hotRegimeEnteredAtMs: number;
  hotRegimeLastActiveAtMs: number;
  hotRegimeUntilMs: number;
};

function readSnapshotMetricNumber(snapshot: ShortExhaustionSignalSnapshot, key: string): number | null {
  const value = snapshot.metrics?.[key];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isHotRegimeActiveState(state: ShortExhaustionSignalState | null | undefined): boolean {
  return state === "CANDIDATE" || state === "WATCHLIST" || state === "CONFIRMED" || state === "SOFT_FINAL" || state === "FINAL";
}

export function isHotRegimeTrackingEnabled(cfg: Pick<ShortExhaustionBotConfig, "observe"> | null | undefined): boolean {
  return Boolean(cfg?.observe?.useHotRegimeTracking);
}

export function buildShortCandidateSignature(snapshot: ShortExhaustionSignalSnapshot): string {
  const reasons = [...snapshot.reasons].sort().join("|");
  const suppressions = [...snapshot.suppressionReasons].sort().join("|");
  return `${snapshot.summaryReason}::${reasons}::${suppressions}`;
}

export function shouldSuppressRepeatedCandidateCluster(
  snapshot: ShortExhaustionSignalSnapshot,
  gate: Pick<HotRegimeGateState, "lastCandidateClusterAtMs" | "lastCandidateScore" | "lastCandidateSignature">,
  useHotRegimeTracking: boolean,
): boolean {
  if (snapshot.state !== "CANDIDATE") return false;
  if (!(gate.lastCandidateClusterAtMs > 0) || !gate.lastCandidateSignature) return false;
  const elapsedMs = snapshot.ts - gate.lastCandidateClusterAtMs;
  const suppressionWindowMs = useHotRegimeTracking
    ? HOT_REGIME_REPEAT_SUPPRESSION_MS
    : 10 * 60_000;
  if (elapsedMs > suppressionWindowMs) return false;
  const signature = buildShortCandidateSignature(snapshot);
  const scoreDelta = Number(snapshot.totalScore) - Number(gate.lastCandidateScore ?? 0);
  return signature === gate.lastCandidateSignature && scoreDelta < HOT_REGIME_REPEAT_MIN_SCORE_DELTA;
}

function hasMeaningfulHotRegimeActivity(
  snapshot: ShortExhaustionSignalSnapshot,
  cfg: ShortExhaustionBotConfig,
): boolean {
  if (isHotRegimeActiveState(snapshot.state)) return true;

  const candidateScore = Number(snapshot.candidateScore);
  const priceMove5mPct = readSnapshotMetricNumber(snapshot, "priceMove5mPct");
  const priceMove15mPct = readSnapshotMetricNumber(snapshot, "priceMove15mPct");
  const oiMove5mPct = readSnapshotMetricNumber(snapshot, "oiMove5mPct");
  const volumeBurst1m = readSnapshotMetricNumber(snapshot, "volumeBurst1m");
  const volumeBurst3m = readSnapshotMetricNumber(snapshot, "volumeBurst3m");
  const turnoverBurst1m = readSnapshotMetricNumber(snapshot, "turnoverBurst1m");
  const turnoverBurst3m = readSnapshotMetricNumber(snapshot, "turnoverBurst3m");
  const strongestVolumeBurst = Math.max(volumeBurst1m ?? 0, volumeBurst3m ?? 0);
  const strongestTurnoverBurst = Math.max(turnoverBurst1m ?? 0, turnoverBurst3m ?? 0);

  return candidateScore >= cfg.candidate.candidateScoreMin * 0.78
    || (priceMove5mPct ?? 0) >= Math.max(1.2, cfg.candidate.minPriceMove5mPct * 0.7)
    || (priceMove15mPct ?? 0) >= Math.max(2.5, cfg.candidate.minPriceMove15mPct * 0.68)
    || (oiMove5mPct ?? 0) >= Math.max(0.6, cfg.derivatives.minOiMove5mPct * 0.65)
    || strongestVolumeBurst >= Math.max(1.2, cfg.candidate.minVolumeBurstRatio * 0.85)
    || strongestTurnoverBurst >= Math.max(1.2, cfg.candidate.minTurnoverBurstRatio * 0.85);
}

function toWatchlistSnapshot(
  snapshot: ShortExhaustionSignalSnapshot,
  summaryReason: string,
): ShortExhaustionSignalSnapshot {
  const stage: ShortExhaustionSignalStage = "WATCHLIST";
  return {
    ...snapshot,
    stage,
    state: "WATCHLIST",
    summaryReason,
  };
}

export function applyHotRegimeTrackingSnapshot(
  snapshot: ShortExhaustionSignalSnapshot,
  gate: HotRegimeGateState,
  cfg: ShortExhaustionBotConfig,
): ShortExhaustionSignalSnapshot {
  if (!isHotRegimeTrackingEnabled(cfg)) return snapshot;

  const hasMeaningfulActivity = hasMeaningfulHotRegimeActivity(snapshot, cfg);
  if (hasMeaningfulActivity) {
    if (!gate.hotRegimeActive) {
      gate.hotRegimeEnteredAtMs = snapshot.ts;
    }
    gate.hotRegimeActive = true;
    gate.hotRegimeLastActiveAtMs = snapshot.ts;
    gate.hotRegimeUntilMs = Math.max(gate.hotRegimeUntilMs, snapshot.ts + HOT_REGIME_MIN_STICKY_MS);
  } else if (gate.hotRegimeActive && snapshot.ts > gate.hotRegimeUntilMs) {
    gate.hotRegimeActive = false;
    gate.hotRegimeEnteredAtMs = 0;
    gate.hotRegimeLastActiveAtMs = 0;
    gate.hotRegimeUntilMs = 0;
  }

  if (!gate.hotRegimeActive) return snapshot;

  const hotRegimeAgeSec = Math.max(0, Math.floor((snapshot.ts - gate.hotRegimeEnteredAtMs) / 1000));
  const metrics = {
    ...snapshot.metrics,
    hotRegimeActive: true,
    hotRegimeAgeSec,
    hotRegimeUntilMs: gate.hotRegimeUntilMs,
    hotRegimeLastActiveAtMs: gate.hotRegimeLastActiveAtMs,
  };

  if (
    snapshot.state === "FINAL"
    || snapshot.state === "SOFT_FINAL"
    || snapshot.state === "CONFIRMED"
    || snapshot.state === "CANDIDATE"
    || snapshot.state === "WATCHLIST"
  ) {
    return {
      ...snapshot,
      metrics,
    };
  }

  const advisoryVerdict = snapshot.biasLabel === "SQUEEZE_RISK" ? "NO_TRADE" : "OBSERVE_ONLY";
  const advisoryReason = snapshot.biasLabel === "SQUEEZE_RISK"
    ? "hot_regime_squeeze_risk"
    : "hot_regime_active";

  return {
    ...toWatchlistSnapshot(snapshot, "hot_regime_active"),
    advisoryVerdict,
    advisoryReason,
    metrics: {
      ...metrics,
      advisoryVerdict,
      advisoryReason,
    },
  };
}
