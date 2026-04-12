import type { ExecutorSettings } from "../../shared/types/domain";

export type ExecutorLocalSettings = ExecutorSettings;

export const DEFAULT_EXECUTOR_LOCAL_SETTINGS: ExecutorLocalSettings = {
  mode: "demo",
  maxUsdt: 100,
  leverage: 10,
  tpPct: 3,
  slPct: 6,
  firstOrderOffsetPct: 0.6,
  gridOrdersCount: 2,
  gridStepPct: 1.2,
  staleSec: 120,
  cooldownMin: 20,
  trackCandidateSignalsForResearch: false,
  takeCandidateSignalsInLiveExecution: true,
  takeFinalSignals: true,
  cancelActivePositionOrders: true,
  exit: "full",
};

export type NumericFieldKey =
  | "maxUsdt"
  | "leverage"
  | "tpPct"
  | "slPct"
  | "firstOrderOffsetPct"
  | "gridOrdersCount"
  | "gridStepPct"
  | "staleSec"
  | "cooldownMin";
