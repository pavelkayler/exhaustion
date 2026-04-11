import type { ShortOutcomeDerivedLabel, ShortSignalOutcomeRecord } from "../../analytics/shortSignalOutcomeTypes.js";
import type { ShortExhaustionSignalSnapshot, ShortExhaustionSignalState } from "../../engine/ShortExhaustionSignalEngine.js";

export const SHORT_REPLAY_STORAGE_VERSION = 1 as const;
export const SHORT_REPLAY_TERMINAL_STATES = ["CONFIRMED", "SOFT_FINAL", "FINAL", "SUPPRESSED", "REJECTED"] as const;
export const SHORT_REPLAY_TECHNICAL_TRANSITIONS = [
  "score_recomputed",
  "gate_failed",
  "veto_applied",
  "expired",
  "outcome_attached",
] as const;

export type ShortReplayTerminalState = typeof SHORT_REPLAY_TERMINAL_STATES[number];
export type ShortReplayTechnicalTransition = typeof SHORT_REPLAY_TECHNICAL_TRANSITIONS[number];
export type ShortReplayRunCompleteness = "COMPLETE" | "PARTIAL" | "FAILED";
export type ShortReplayRunStatus = "done" | "error";
export type ShortReplayJobStatus = "queued" | "running" | "done" | "error";
export type ShortReplayJobStage = "preparing" | "replaying" | "persisting";

export type ShortReplayCompactSnapshot = {
  ts: number;
  symbol: string;
  stage: ShortExhaustionSignalSnapshot["stage"];
  state: ShortExhaustionSignalSnapshot["state"];
  candidateScore: number;
  derivativesScore: number;
  exhaustionScore: number;
  microstructureScore: number;
  totalScore: number;
  reasons: string[];
  hardRejectReasons: string[];
  suppressionReasons: string[];
  summaryReason: string;
  signalVersion: string;
  featureSchemaVersion: string;
  metrics: Record<string, number | string | boolean | null>;
};

export type ShortReplayTransitionRecord = {
  id: string;
  runId: string;
  signalId: string | null;
  symbol: string;
  ts: number;
  kind: "state" | "technical";
  prevState: ShortExhaustionSignalState | null;
  nextState: ShortExhaustionSignalState | null;
  technicalType: ShortReplayTechnicalTransition | null;
  reason: string | null;
  snapshot: ShortReplayCompactSnapshot | null;
};

export type ShortReplaySignalRecord = {
  id: string;
  runId: string;
  symbol: string;
  signalTs: number;
  startedAtTs: number;
  terminalTs: number;
  firstState: ShortExhaustionSignalState;
  terminalState: ShortReplayTerminalState | "EXPIRED" | "CANDIDATE";
  transitionCount: number;
  transitionIds: string[];
  totalScore: number;
  reasonsSummary: string;
  summaryReason: string;
  signalVersion: string;
  featureSchemaVersion: string;
  compactSnapshot: ShortReplayCompactSnapshot;
  previousActiveSignalId: string | null;
  overlapGroupId: string;
  isOverlapping: boolean;
  finalTriggerEmitted: boolean;
  outcomeId: string | null;
  createdAtMs: number;
};

export type ShortReplayRunCoverage = {
  totalExpectedRows: number;
  actualRows: number;
  missingMinutesCount: number;
  missingSymbolsCount: number;
  hasGaps: boolean;
  coverageRatio: number;
  gapPolicyApplied: "skip_missing_minutes";
  completeness: ShortReplayRunCompleteness;
};

export type ShortReplayRunSummary = {
  totalSymbols: number;
  totalProcessedMinutes: number;
  totalSignals: number;
  terminalSignals: number;
  totalSetups: number;
  countsByTerminalState: Record<ShortReplaySignalRecord["terminalState"], number>;
  countsByLabel: Record<ShortOutcomeDerivedLabel, number>;
  returns: {
    avgRet3m: number | null;
    avgRet5m: number | null;
    avgRet15m: number | null;
    avgRet30m: number | null;
  };
};

export type ShortReplayRunManifest = {
  version: typeof SHORT_REPLAY_STORAGE_VERSION;
  runId: string;
  status: ShortReplayRunStatus;
  createdAtMs: number;
  finishedAtMs: number;
  source: "api";
  signalVersion: string;
  featureSchemaVersion: string;
  outcomeRulesVersion: string | null;
  includeOutcomes: boolean;
  configHash: string;
  configSnapshot: Record<string, unknown>;
  universeSnapshot: {
    id: string;
    name: string;
    symbols: string[];
    count: number;
  };
  timeRange: {
    startMs: number;
    endMs: number;
  };
  researchStorageVersion: number;
  coverage: ShortReplayRunCoverage;
  summary: ShortReplayRunSummary;
  files: {
    signals: string;
    transitions: string;
    outcomes: string | null;
    setups: string;
    setupRevisions: string;
    setupTransitions: string;
    setupOutcomes: string;
  };
};

export type ShortReplayRunListItem = {
  runId: string;
  createdAtMs: number;
  finishedAtMs: number;
  signalVersion: string;
  featureSchemaVersion: string;
  includeOutcomes: boolean;
  universeId: string;
  universeName: string;
  startMs: number;
  endMs: number;
  completeness: ShortReplayRunCompleteness;
  totalSignals: number;
  terminalSignals: number;
  totalSetups: number;
  finalSignals: number;
  labels: Record<ShortOutcomeDerivedLabel, number>;
};

export type ShortReplaySignalDetail = {
  record: ShortReplaySignalRecord | null;
  transitions: ShortReplayTransitionRecord[];
  overlappingSiblings: ShortReplaySignalRecord[];
  outcome: ShortSignalOutcomeRecord | null;
};

export type ShortReplayRunsListResponse = {
  runs: ShortReplayRunListItem[];
};

export type ShortReplayRunResponse = {
  run: ShortReplayRunManifest;
};

export type ShortReplayJobSnapshot = {
  jobId: string;
  status: ShortReplayJobStatus;
  stage: ShortReplayJobStage;
  progressPct: number;
  currentSymbol: string | null;
  message: string | null;
  runId: string | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  finishedAtMs: number | null;
};

export type ShortReplayJobResponse = {
  job: ShortReplayJobSnapshot;
};

export type ShortReplaySignalsResponse = {
  runId: string;
  records: ShortReplaySignalRecord[];
};

export type ShortReplaySignalDetailResponse = {
  runId: string;
  detail: ShortReplaySignalDetail;
};

export type ShortSetupEntryMode = "market_now" | "limit_on_retest" | "confirmation_breakdown";
export type ShortSetupStyle = "aggressive" | "standard" | "conservative";
export type ShortSetupState = "draft" | "active" | "triggered" | "invalidated" | "expired" | "cancelled" | "shadow";
export type ShortSetupTradabilityStatus = "tradable" | "too_late" | "not_tradable" | "shadow";
export type ShortSetupRevisionReason =
  | "created"
  | "promoted_confirmed_to_soft_final"
  | "promoted_confirmed_to_final"
  | "retest_detected"
  | "new_local_high_before_invalidation"
  | "time_decay_adjustment"
  | "expired"
  | "superseded";

export type ShortSetupConfidenceBreakdown = {
  signalContext: number;
  entryQuality: number;
  invalidationQuality: number;
  targetQuality: number;
  rrQuality: number;
  decayPenalty: number;
};

export type ShortReplaySetupRecord = {
  id: string;
  runId: string;
  signalId: string;
  symbol: string;
  sourceSignalState: "CANDIDATE" | "CONFIRMED" | "SOFT_FINAL" | "FINAL" | "SUPPRESSED";
  setupState: ShortSetupState;
  tradabilityStatus: ShortSetupTradabilityStatus;
  setupType: "primary" | "shadow";
  setupStyle: ShortSetupStyle;
  entryMode: ShortSetupEntryMode;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  entryPriceMid: number | null;
  setupReferencePrice: number | null;
  invalidationPrice: number | null;
  invalidationPctFromReference: number | null;
  invalidationType: "structural_high";
  target1Price: number | null;
  target2Price: number | null;
  rrToTp1: number | null;
  rrToTp2: number | null;
  expectedRr: number | null;
  setupQualityScore: number;
  confidence: number;
  reasons: string[];
  setupRationale: string[];
  whyTradableSummary: string;
  lastRevisionReason: ShortSetupRevisionReason;
  isWeakened: boolean;
  degradationReason: string | null;
  confidenceBreakdown: ShortSetupConfidenceBreakdown;
  anchors: {
    signalHigh: number | null;
    rejectionCandleHigh: number | null;
    finalTriggerCandleHigh: number | null;
    setupHigh: number | null;
    signalBarStartMs: number | null;
  };
  isTradableNow: boolean;
  supersedesSetupId: string | null;
  supersededBySetupId: string | null;
  setupExpiryTs: number;
  revision: number;
  setupVersion: string;
  setupRulesVersion: string;
  createdAtMs: number;
  updatedAtMs: number;
  outcomeId: string | null;
};

export type ShortReplaySetupRevisionRecord = {
  id: string;
  runId: string;
  setupId: string;
  signalId: string;
  symbol: string;
  revision: number;
  ts: number;
  reasonCode: ShortSetupRevisionReason;
  changedFields: string[];
  note: string | null;
  snapshot: ShortReplaySetupRecord;
};

export type ShortReplaySetupTransitionRecord = {
  id: string;
  runId: string;
  setupId: string;
  signalId: string;
  symbol: string;
  ts: number;
  prevState: ShortSetupState | null;
  nextState: ShortSetupState;
  revision: number;
  reasonCode: ShortSetupRevisionReason;
  note: string | null;
};

export type ShortReplaySetupOutcomeRecord = {
  id: string;
  runId: string;
  setupId: string;
  signalId: string;
  symbol: string;
  entryMode: ShortSetupEntryMode;
  setupStateAtOpen: ShortSetupState;
  didEnter: boolean;
  entryTs: number | null;
  entryPrice: number | null;
  didHitTp1: boolean;
  didHitTp2: boolean;
  didInvalidateFirst: boolean;
  invalidated: boolean;
  invalidationTs: number | null;
  invalidationPrice: number | null;
  tp1Ts: number | null;
  tp1Price: number | null;
  tp2Ts: number | null;
  tp2Price: number | null;
  expired: boolean;
  expiryTs: number;
  maxFavorableMove: number | null;
  maxAdverseMove: number | null;
  bestRrAchieved: number | null;
  timeToTp1Ms: number | null;
  timeToTp2Ms: number | null;
  timeToInvalidationMs: number | null;
  signalRet15m: number | null;
  signalRet30m: number | null;
  original: {
    revision: number;
    didEnter: boolean;
    didHitTp1: boolean;
    didHitTp2: boolean;
    didInvalidateFirst: boolean;
    invalidated: boolean;
    expired: boolean;
    bestRrAchieved: number | null;
  };
  createdAtMs: number;
  updatedAtMs: number;
};

export type ShortReplaySetupsResponse = {
  runId: string;
  records: ShortReplaySetupRecord[];
};

export type ShortReplaySetupDetail = {
  record: ShortReplaySetupRecord | null;
  revisions: ShortReplaySetupRevisionRecord[];
  transitions: ShortReplaySetupTransitionRecord[];
  outcome: ShortReplaySetupOutcomeRecord | null;
  signal: ShortReplaySignalRecord | null;
};

export type ShortReplaySetupDetailResponse = {
  runId: string;
  detail: ShortReplaySetupDetail;
};

export type ShortLiveSetupRecord = ShortReplaySetupRecord & {
  liveSetupId: string;
  current: boolean;
  restoredFromDisk: boolean;
  lastSignalState: "CANDIDATE" | "CONFIRMED" | "SOFT_FINAL" | "FINAL" | "SUPPRESSED" | null;
  latestRevisionSummary: {
    revision: number;
    ts: number;
    reasonCode: ShortSetupRevisionReason;
    changedFields: string[];
    note: string | null;
  } | null;
};

export type ShortLiveSetupDetail = {
  record: ShortLiveSetupRecord | null;
  revisions: ShortReplaySetupRevisionRecord[];
  transitions: ShortReplaySetupTransitionRecord[];
};

export type ShortLiveSetupsResponse = {
  records: ShortLiveSetupRecord[];
};

export type ShortLiveSetupDetailResponse = {
  detail: ShortLiveSetupDetail;
};
