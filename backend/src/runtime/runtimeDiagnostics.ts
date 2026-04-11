type RuntimeDiagnosticsAccumulator = {
  calls: number;
  items: number;
  totalMs: number;
  maxMs: number;
  errors: number;
  lastMs: number | null;
  lastAtMs: number | null;
};

type RuntimeDiagnosticsSectionState = {
  total: RuntimeDiagnosticsAccumulator;
  currentInterval: RuntimeDiagnosticsAccumulator;
};

type RuntimeDiagnosticsSnapshotRow = {
  calls: number;
  items: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  errors: number;
  lastMs: number | null;
  lastAtMs: number | null;
};

type RuntimeDiagnosticsSnapshot = {
  startedAtMs: number;
  intervalMs: number;
  currentIntervalStartedAtMs: number;
  lastIntervalEndedAtMs: number | null;
  process: {
    uptimeSec: number;
    memory: NodeJS.MemoryUsage;
    cpuLastInterval: {
      wallMs: number;
      userMs: number;
      systemMs: number;
      totalMs: number;
      usagePctOfSingleCore: number;
    } | null;
  };
  hotLastInterval: Array<RuntimeDiagnosticsSnapshotRow & { name: string }>;
  sections: Record<string, {
    total: RuntimeDiagnosticsSnapshotRow;
    lastInterval: RuntimeDiagnosticsSnapshotRow;
  }>;
};

function createAccumulator(): RuntimeDiagnosticsAccumulator {
  return {
    calls: 0,
    items: 0,
    totalMs: 0,
    maxMs: 0,
    errors: 0,
    lastMs: null,
    lastAtMs: null,
  };
}

function cloneAccumulator(input: RuntimeDiagnosticsAccumulator): RuntimeDiagnosticsAccumulator {
  return {
    calls: input.calls,
    items: input.items,
    totalMs: input.totalMs,
    maxMs: input.maxMs,
    errors: input.errors,
    lastMs: input.lastMs,
    lastAtMs: input.lastAtMs,
  };
}

function toSnapshotRow(input: RuntimeDiagnosticsAccumulator): RuntimeDiagnosticsSnapshotRow {
  return {
    calls: input.calls,
    items: input.items,
    totalMs: Number(input.totalMs.toFixed(3)),
    avgMs: input.calls > 0 ? Number((input.totalMs / input.calls).toFixed(3)) : 0,
    maxMs: Number(input.maxMs.toFixed(3)),
    errors: input.errors,
    lastMs: input.lastMs == null ? null : Number(input.lastMs.toFixed(3)),
    lastAtMs: input.lastAtMs,
  };
}

function updateAccumulator(target: RuntimeDiagnosticsAccumulator, nowMs: number, durationMs: number, items: number, failed: boolean): void {
  target.calls += 1;
  target.items += Math.max(0, Math.floor(Number(items) || 0));
  target.totalMs += durationMs;
  target.maxMs = Math.max(target.maxMs, durationMs);
  target.lastMs = durationMs;
  target.lastAtMs = nowMs;
  if (failed) target.errors += 1;
}

export class RuntimeDiagnostics {
  private readonly startedAtMs: number;
  private readonly intervalMs: number;
  private currentIntervalStartedAtMs: number;
  private lastIntervalEndedAtMs: number | null = null;
  private readonly sections = new Map<string, RuntimeDiagnosticsSectionState>();
  private lastCompletedInterval = new Map<string, RuntimeDiagnosticsAccumulator>();
  private previousCpuUsage = process.cpuUsage();
  private previousCpuWallAtMs: number;
  private lastCpuInterval: RuntimeDiagnosticsSnapshot["process"]["cpuLastInterval"] = null;

  constructor(intervalMs = 60_000) {
    const now = Date.now();
    this.startedAtMs = now;
    this.intervalMs = intervalMs;
    this.currentIntervalStartedAtMs = now;
    this.previousCpuWallAtMs = now;
  }

  private ensureSection(name: string): RuntimeDiagnosticsSectionState {
    const normalized = String(name ?? "").trim();
    if (!normalized) {
      throw new Error("runtime_diagnostics_section_required");
    }
    let state = this.sections.get(normalized);
    if (!state) {
      state = {
        total: createAccumulator(),
        currentInterval: createAccumulator(),
      };
      this.sections.set(normalized, state);
    }
    return state;
  }

  private rotateIfNeeded(nowMs: number): void {
    if (nowMs - this.currentIntervalStartedAtMs < this.intervalMs) return;

    this.lastCompletedInterval = new Map<string, RuntimeDiagnosticsAccumulator>();
    for (const [name, state] of this.sections.entries()) {
      this.lastCompletedInterval.set(name, cloneAccumulator(state.currentInterval));
      state.currentInterval = createAccumulator();
    }

    const cpuDelta = process.cpuUsage(this.previousCpuUsage);
    const wallMs = Math.max(0, nowMs - this.previousCpuWallAtMs);
    const userMs = cpuDelta.user / 1000;
    const systemMs = cpuDelta.system / 1000;
    const totalMs = userMs + systemMs;
    this.lastCpuInterval = wallMs > 0
      ? {
          wallMs,
          userMs: Number(userMs.toFixed(3)),
          systemMs: Number(systemMs.toFixed(3)),
          totalMs: Number(totalMs.toFixed(3)),
          usagePctOfSingleCore: Number(((totalMs / wallMs) * 100).toFixed(2)),
        }
      : null;
    this.previousCpuUsage = process.cpuUsage();
    this.previousCpuWallAtMs = nowMs;
    this.lastIntervalEndedAtMs = nowMs;
    this.currentIntervalStartedAtMs = nowMs;
  }

  record(name: string, durationMs: number, options?: { items?: number; failed?: boolean; nowMs?: number }): void {
    const nowMs = Number.isFinite(options?.nowMs as number) ? Number(options?.nowMs) : Date.now();
    this.rotateIfNeeded(nowMs);
    const state = this.ensureSection(name);
    const resolvedDurationMs = Math.max(0, Number(durationMs) || 0);
    const items = Math.max(0, Math.floor(Number(options?.items) || 0));
    const failed = Boolean(options?.failed);
    updateAccumulator(state.total, nowMs, resolvedDurationMs, items, failed);
    updateAccumulator(state.currentInterval, nowMs, resolvedDurationMs, items, failed);
  }

  count(name: string, options?: { items?: number; failed?: boolean; nowMs?: number }): void {
    this.record(name, 0, options);
  }

  start(name: string): { end: (options?: { items?: number; failed?: boolean; nowMs?: number }) => void } {
    const startedAtNs = process.hrtime.bigint();
    let ended = false;
    return {
      end: (options) => {
        if (ended) return;
        ended = true;
        const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
        this.record(name, durationMs, options);
      },
    };
  }

  getSnapshot(): RuntimeDiagnosticsSnapshot {
    const nowMs = Date.now();
    this.rotateIfNeeded(nowMs);

    const sections = Object.fromEntries(
      Array.from(this.sections.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, state]) => [
          name,
          {
            total: toSnapshotRow(state.total),
            lastInterval: toSnapshotRow(this.lastCompletedInterval.get(name) ?? createAccumulator()),
          },
        ]),
    );

    const hotLastInterval = Array.from(this.lastCompletedInterval.entries())
      .map(([name, row]) => ({
        name,
        ...toSnapshotRow(row),
      }))
      .filter((row) => row.calls > 0 || row.totalMs > 0 || row.items > 0 || row.errors > 0)
      .sort((left, right) => {
        if (right.totalMs !== left.totalMs) return right.totalMs - left.totalMs;
        if (right.calls !== left.calls) return right.calls - left.calls;
        return left.name.localeCompare(right.name);
      });

    return {
      startedAtMs: this.startedAtMs,
      intervalMs: this.intervalMs,
      currentIntervalStartedAtMs: this.currentIntervalStartedAtMs,
      lastIntervalEndedAtMs: this.lastIntervalEndedAtMs,
      process: {
        uptimeSec: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        cpuLastInterval: this.lastCpuInterval,
      },
      hotLastInterval,
      sections,
    };
  }
}

export const runtimeDiagnostics = new RuntimeDiagnostics();
