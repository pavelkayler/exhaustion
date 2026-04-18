import type { ExecutorSettings } from "../../shared/types/domain";

export type ExecutorLocalSettings = ExecutorSettings;

const FIXED_EXECUTOR_GRID_ORDERS_COUNT = 3;
const FIXED_EXECUTOR_GRID_STEP_PCT = 15;
const FIXED_EXECUTOR_SL_PCT = Number(
  (100 / FIXED_EXECUTOR_GRID_ORDERS_COUNT).toFixed(4),
);

export const DEFAULT_EXECUTOR_LOCAL_SETTINGS: ExecutorLocalSettings = {
  mode: "demo",
  maxUsdt: 100,
  leverage: 10,
  tpPct: 5,
  slPct: FIXED_EXECUTOR_SL_PCT,
  firstOrderOffsetPct: 0.6,
  gridOrdersCount: FIXED_EXECUTOR_GRID_ORDERS_COUNT,
  gridStepPct: FIXED_EXECUTOR_GRID_STEP_PCT,
  orderAliveMin: 0,
  cooldownMin: 5,
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
  | "orderAliveMin"
  | "cooldownMin";
