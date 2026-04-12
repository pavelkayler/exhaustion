import fs from "node:fs";
import path from "node:path";

export type ExecutionMode = "demo" | "real";
export type ExecutorExitMode = "full" | "partial_and_trailing" | "trailing";

export type ExecutorSettings = {
  mode: ExecutionMode;
  maxUsdt: number;
  leverage: number;
  tpPct: number;
  slPct: number;
  firstOrderOffsetPct: number;
  gridOrdersCount: number;
  gridStepPct: number;
  orderAliveMin: number;
  cooldownMin: number;
  trackCandidateSignalsForResearch: boolean;
  takeCandidateSignalsInLiveExecution: boolean;
  takeFinalSignals: boolean;
  cancelActivePositionOrders: boolean;
  exit: ExecutorExitMode;
};

export type ExecutorPositionStage = "partial_pending" | "trailing_active";

export type ExecutorManagedPositionState = {
  key: string;
  symbol: string;
  side: string | null;
  stage: ExecutorPositionStage;
  initialSize: number;
  lastSize: number;
  entryPrice: number;
  updatedAt: number;
};

export type ExecutorPersistedState = {
  settings: ExecutorSettings;
  running: boolean;
  error: string | null;
  updatedAt: number | null;
  positionStates: Record<string, ExecutorManagedPositionState>;
};

const EXECUTOR_STATE_FILE_PATH = path.resolve(process.cwd(), "data", "execution-executor.json");

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function ensureDataDir() {
  fs.mkdirSync(path.dirname(EXECUTOR_STATE_FILE_PATH), { recursive: true });
}

function writeFileAtomic(filePath: string, content: string) {
  ensureDataDir();
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // ignore
  }
  fs.renameSync(tmp, filePath);
}

function readFiniteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  }
  return fallback;
}

function normalizeMode(value: unknown, fallback: ExecutionMode = "demo"): ExecutionMode {
  return String(value ?? "").trim().toLowerCase() === "real" ? "real" : fallback;
}

function normalizeExitMode(value: unknown, fallback: ExecutorExitMode = "full"): ExecutorExitMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "partial_and_trailing") return "partial_and_trailing";
  if (normalized === "trailing") return "trailing";
  return fallback;
}

export const DEFAULT_EXECUTOR_SETTINGS: ExecutorSettings = {
  mode: "demo",
  maxUsdt: 100,
  leverage: 10,
  tpPct: 3,
  slPct: 6,
  firstOrderOffsetPct: 0.6,
  gridOrdersCount: 2,
  gridStepPct: 1.2,
  orderAliveMin: 2,
  cooldownMin: 20,
  trackCandidateSignalsForResearch: false,
  takeCandidateSignalsInLiveExecution: true,
  takeFinalSignals: true,
  cancelActivePositionOrders: true,
  exit: "full",
};

function normalizeOrderAliveMin(source: Record<string, unknown>): number {
  if (Object.prototype.hasOwnProperty.call(source, "orderAliveMin")) {
    return Math.max(1, Math.floor(readFiniteNumber(source.orderAliveMin, DEFAULT_EXECUTOR_SETTINGS.orderAliveMin)));
  }
  if (Object.prototype.hasOwnProperty.call(source, "staleSec")) {
    const legacySeconds = Math.max(1, Math.floor(readFiniteNumber(source.staleSec, DEFAULT_EXECUTOR_SETTINGS.orderAliveMin * 60)));
    return Math.max(1, Math.round(legacySeconds / 60));
  }
  return DEFAULT_EXECUTOR_SETTINGS.orderAliveMin;
}

function normalizeSettings(raw: unknown): ExecutorSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    mode: normalizeMode(source.mode, DEFAULT_EXECUTOR_SETTINGS.mode),
    maxUsdt: Math.max(0, readFiniteNumber(source.maxUsdt, DEFAULT_EXECUTOR_SETTINGS.maxUsdt)),
    leverage: Math.max(1, readFiniteNumber(source.leverage, DEFAULT_EXECUTOR_SETTINGS.leverage)),
    tpPct: Math.max(0, readFiniteNumber(source.tpPct, DEFAULT_EXECUTOR_SETTINGS.tpPct)),
    slPct: Math.max(0, readFiniteNumber(source.slPct, DEFAULT_EXECUTOR_SETTINGS.slPct)),
    firstOrderOffsetPct: Math.max(
      0,
      readFiniteNumber(source.firstOrderOffsetPct, DEFAULT_EXECUTOR_SETTINGS.firstOrderOffsetPct),
    ),
    gridOrdersCount: Math.max(
      0,
      Math.floor(readFiniteNumber(source.gridOrdersCount, DEFAULT_EXECUTOR_SETTINGS.gridOrdersCount)),
    ),
    gridStepPct: Math.max(0, readFiniteNumber(source.gridStepPct, DEFAULT_EXECUTOR_SETTINGS.gridStepPct)),
    orderAliveMin: normalizeOrderAliveMin(source),
    cooldownMin: Math.max(0, Math.floor(readFiniteNumber(source.cooldownMin, DEFAULT_EXECUTOR_SETTINGS.cooldownMin))),
    trackCandidateSignalsForResearch: readBoolean(
      source.trackCandidateSignalsForResearch,
      DEFAULT_EXECUTOR_SETTINGS.trackCandidateSignalsForResearch,
    ),
    takeCandidateSignalsInLiveExecution: readBoolean(
      source.takeCandidateSignalsInLiveExecution,
      DEFAULT_EXECUTOR_SETTINGS.takeCandidateSignalsInLiveExecution,
    ),
    takeFinalSignals: readBoolean(source.takeFinalSignals, DEFAULT_EXECUTOR_SETTINGS.takeFinalSignals),
    cancelActivePositionOrders: readBoolean(
      source.cancelActivePositionOrders,
      DEFAULT_EXECUTOR_SETTINGS.cancelActivePositionOrders,
    ),
    exit: normalizeExitMode(source.exit, DEFAULT_EXECUTOR_SETTINGS.exit),
  };
}

function normalizeManagedPositionState(
  key: string,
  raw: unknown,
): ExecutorManagedPositionState | null {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const stage = String(source.stage ?? "").trim().toLowerCase();
  if (stage !== "partial_pending" && stage !== "trailing_active") {
    return null;
  }
  const symbol = String(source.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;
  const initialSize = Number(source.initialSize);
  const lastSize = Number(source.lastSize);
  const entryPrice = Number(source.entryPrice);
  const updatedAt = Number(source.updatedAt);
  if (!Number.isFinite(initialSize) || initialSize <= 0) return null;
  if (!Number.isFinite(lastSize) || lastSize <= 0) return null;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  return {
    key,
    symbol,
    side: String(source.side ?? "").trim().toUpperCase() || null,
    stage,
    initialSize,
    lastSize,
    entryPrice,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : Date.now(),
  };
}

function normalizePersistedState(raw: unknown): ExecutorPersistedState {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawPositionStates = (
    source.positionStates && typeof source.positionStates === "object"
      ? source.positionStates
      : {}
  ) as Record<string, unknown>;

  const positionStates: Record<string, ExecutorManagedPositionState> = {};
  for (const [key, value] of Object.entries(rawPositionStates)) {
    const normalized = normalizeManagedPositionState(key, value);
    if (!normalized) continue;
    positionStates[key] = normalized;
  }

  return {
    settings: normalizeSettings(source.settings),
    running: readBoolean(source.running, false),
    error: source.error == null ? null : String(source.error),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : null,
    positionStates,
  };
}

function defaultState(): ExecutorPersistedState {
  return {
    settings: deepClone(DEFAULT_EXECUTOR_SETTINGS),
    running: false,
    error: null,
    updatedAt: null,
    positionStates: {},
  };
}

function tryLoadFromDisk(): ExecutorPersistedState {
  if (!fs.existsSync(EXECUTOR_STATE_FILE_PATH)) {
    return defaultState();
  }
  try {
    const text = fs.readFileSync(EXECUTOR_STATE_FILE_PATH, "utf8");
    return normalizePersistedState(JSON.parse(text));
  } catch {
    return defaultState();
  }
}

class ExecutorStore {
  private state: ExecutorPersistedState = tryLoadFromDisk();

  private touch() {
    this.state.updatedAt = Date.now();
  }

  private persistInternal() {
    writeFileAtomic(EXECUTOR_STATE_FILE_PATH, JSON.stringify(this.state, null, 2));
  }

  getState(): ExecutorPersistedState {
    return deepClone(this.state);
  }

  getSettings(): ExecutorSettings {
    return deepClone(this.state.settings);
  }

  setRunning(running: boolean): ExecutorPersistedState {
    this.state.running = Boolean(running);
    this.touch();
    this.persistInternal();
    return this.getState();
  }

  setError(error: string | null): ExecutorPersistedState {
    this.state.error = error == null ? null : String(error);
    this.touch();
    this.persistInternal();
    return this.getState();
  }

  updateSettings(patchRaw: unknown): ExecutorPersistedState {
    const patch = (patchRaw && typeof patchRaw === "object" ? patchRaw : {}) as Record<string, unknown>;
    this.state.settings = normalizeSettings({
      ...this.state.settings,
      ...patch,
    });
    this.touch();
    this.persistInternal();
    return this.getState();
  }

  setPositionState(key: string, value: ExecutorManagedPositionState | null): ExecutorPersistedState {
    if (!key) return this.getState();
    if (!value) {
      delete this.state.positionStates[key];
    } else {
      this.state.positionStates[key] = {
        ...value,
        key,
      };
    }
    this.touch();
    this.persistInternal();
    return this.getState();
  }

  removePositionStates(keys: string[]): ExecutorPersistedState {
    let changed = false;
    for (const key of keys) {
      if (!key || !(key in this.state.positionStates)) continue;
      delete this.state.positionStates[key];
      changed = true;
    }
    if (changed) {
      this.touch();
      this.persistInternal();
    }
    return this.getState();
  }

  resetPositionStates(): ExecutorPersistedState {
    this.state.positionStates = {};
    this.touch();
    this.persistInternal();
    return this.getState();
  }

  getFilePath(): string {
    return EXECUTOR_STATE_FILE_PATH;
  }
}

export const executorStore = new ExecutorStore();
