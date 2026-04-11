import type { ShortExhaustionSignalSnapshot } from "../engine/ShortExhaustionSignalEngine.js";

export const SHORT_OUTCOME_TRACK_STATES = ["CANDIDATE", "CONFIRMED", "SOFT_FINAL", "FINAL", "SUPPRESSED"] as const;
export type ShortOutcomeTrackedState = typeof SHORT_OUTCOME_TRACK_STATES[number];

export const SHORT_OUTCOME_HORIZONS = [3, 5, 15, 30] as const;
export type ShortOutcomeHorizonMinutes = typeof SHORT_OUTCOME_HORIZONS[number];
export type ShortOutcomeHorizonKey = "3m" | "5m" | "15m" | "30m";

export type ShortOutcomeReferencePriceType =
  | "midPrice"
  | "lastPrice"
  | "markPrice"
  | "klineClose";

export type ShortOutcomeScoreBucket = "low" | "medium" | "high" | "extreme";

export type ShortOutcomeDerivedLabel =
  | "pending"
  | "excellent reversal"
  | "good reversal"
  | "weak pullback"
  | "failed reversal"
  | "continuation squeeze";

export type ShortOutcomeProcessingStatus = "pending" | "complete" | "partial";

export type ShortSignalReferenceMarketSnapshot = {
  capturedAtMs: number;
  bid1: number | null;
  ask1: number | null;
  midPrice: number | null;
  lastPrice: number | null;
  markPrice: number | null;
};

export type ShortSignalMinuteBar = {
  symbol: string;
  startMs: number;
  endMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  turnover: number | null;
  markPrice: number | null;
  lastPrice: number | null;
  bid1: number | null;
  ask1: number | null;
  source: "ws" | "recorder" | "rest";
  loadedAtMs: number;
};

export type ShortSignalCompactSnapshot = {
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

export type ShortSignalOutcomeSourceEvent = {
  type: "SHORT_SIGNAL_TRANSITION" | "SHORT_SIGNAL_TRIGGER";
  ts: number;
  key: string;
  sessionId: string | null;
  eventsFile: string | null;
};

export type ShortSignalOutcomeHorizon = {
  horizonKey: ShortOutcomeHorizonKey;
  horizonMinutes: ShortOutcomeHorizonMinutes;
  targetTs: number;
  resolvedAtTs: number | null;
  futurePrice: number | null;
  rawReturn: number | null;
  shortReturn: number | null;
  mfe: number | null;
  mae: number | null;
  didReachTarget: boolean | null;
  didInvalidate: boolean | null;
  isResolved: boolean;
};

export type ShortSignalOutcomeRecord = {
  id: string;
  signalId: string;
  symbol: string;
  state: ShortOutcomeTrackedState;
  signalTs: number;
  sessionId: string | null;
  scopeId: string;
  sourceEvent: ShortSignalOutcomeSourceEvent;
  compactSnapshot: ShortSignalCompactSnapshot;
  referencePrice: number | null;
  referencePriceType: ShortOutcomeReferencePriceType | null;
  referenceMarket: ShortSignalReferenceMarketSnapshot | null;
  previousActiveSignalId: string | null;
  overlapGroupId: string;
  isOverlapping: boolean;
  totalScore: number;
  scoreBucket: ShortOutcomeScoreBucket;
  derivedLabel: ShortOutcomeDerivedLabel;
  derivedLabelVersion: string;
  derivedLabelExplanation: string[];
  horizons: Record<ShortOutcomeHorizonKey, ShortSignalOutcomeHorizon>;
  ret3m: number | null;
  ret5m: number | null;
  ret15m: number | null;
  ret30m: number | null;
  rawRet3m: number | null;
  rawRet5m: number | null;
  rawRet15m: number | null;
  rawRet30m: number | null;
  mfe30m: number | null;
  mae30m: number | null;
  reasonsSummary: string;
  processingStatus: ShortOutcomeProcessingStatus;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
};

export type ShortSignalOutcomeStoreFile = {
  version: 1;
  updatedAtMs: number;
  records: ShortSignalOutcomeRecord[];
};

export type ShortSignalOutcomeListFilters = {
  symbol?: string;
  state?: ShortOutcomeTrackedState | "ALL";
  label?: ShortOutcomeDerivedLabel | "ALL";
  scoreBucket?: ShortOutcomeScoreBucket | "ALL";
  dateFromTs?: number | null;
  dateToTs?: number | null;
  page?: number;
  pageSize?: number;
  limit?: number;
  sortKey?:
    | "signalTs"
    | "symbol"
    | "state"
    | "totalScore"
    | "derivedLabel"
    | "ret3m"
    | "ret5m"
    | "ret15m"
    | "ret30m"
    | "mfe30m"
    | "mae30m"
    | "processingStatus"
    | "reasonsSummary";
  sortDir?: "asc" | "desc";
};

export type ShortSignalOutcomeListResponse = {
  records: ShortSignalOutcomeRecord[];
  total: number;
  page: number;
  pageSize: number;
  byState: Record<ShortOutcomeTrackedState, number>;
  byLabel: Record<ShortOutcomeDerivedLabel, number>;
  pending: number;
  updatedAtMs: number;
  sortKey:
    | "signalTs"
    | "symbol"
    | "state"
    | "totalScore"
    | "derivedLabel"
    | "ret3m"
    | "ret5m"
    | "ret15m"
    | "ret30m"
    | "mfe30m"
    | "mae30m"
    | "processingStatus"
    | "reasonsSummary";
  sortDir: "asc" | "desc";
  limit: number;
};

export type ShortSignalCalibrationOutcomeClass =
  | "reversal"
  | "weak_pullback"
  | "continuation_squeeze"
  | "failed_reversal"
  | "pending";

export type ShortSignalCalibrationClassSummary = {
  outcomeClass: ShortSignalCalibrationOutcomeClass;
  count: number;
  avgScore: number | null;
  avgRet5m: number | null;
  avgRet15m: number | null;
  avgRet30m: number | null;
  avgMfe30m: number | null;
  avgMae30m: number | null;
  avgAccountRatioSkew5m: number | null;
  avgAccountRatioSkew15m: number | null;
  avgPremiumClose5mPct: number | null;
  avgPremiumDelta5mPct: number | null;
  avgPremiumClose15mPct: number | null;
  avgPremiumDelta15mPct: number | null;
  avgOiMove5mPct: number | null;
  avgOiMove15mPct: number | null;
  avgOiToTurnoverRatio: number | null;
};

export type ShortSignalCalibrationClusterRecord = {
  id: string;
  symbol: string;
  startTs: number;
  endTs: number;
  signalCount: number;
  representativeOutcomeId: string;
  derivedLabel: ShortOutcomeDerivedLabel;
  outcomeClass: ShortSignalCalibrationOutcomeClass;
  totalScore: number;
  ret5m: number | null;
  ret15m: number | null;
  ret30m: number | null;
  mfe30m: number | null;
  mae30m: number | null;
  reasonsSummary: string;
  accountRatioSkew5m: number | null;
  accountRatioSkew15m: number | null;
  premiumClose5mPct: number | null;
  premiumDelta5mPct: number | null;
  premiumClose15mPct: number | null;
  premiumDelta15mPct: number | null;
  oiMove5mPct: number | null;
  oiMove15mPct: number | null;
  oiToTurnoverRatio: number | null;
};

export type ShortSignalCalibrationSummaryResponse = {
  generatedAtMs: number;
  clusterWindowMin: number;
  limit: number;
  totalCandidateRecords: number;
  totalClusters: number;
  summaries: ShortSignalCalibrationClassSummary[];
  clusters: ShortSignalCalibrationClusterRecord[];
};
