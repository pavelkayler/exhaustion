import fs from "node:fs";
import path from "node:path";

export type MinuteOiRecorderMode = "off" | "record_only" | "record_while_running";
export type MinuteOiRecorderState = "idle" | "waiting" | "running" | "error";

export type MinuteOiRecorderStatus = {
  state: MinuteOiRecorderState;
  mode: MinuteOiRecorderMode;
  message: string | null;
  writes: number;
  droppedBoundaryPoints: number;
  trackedSymbols: number;
  lastWriteAtMs: number | null;
};

export type RecorderMinuteOiRow = {
  ts: number;
  openInterestValue: number;
  source: "bybit_ws";
  recordedAtMs: number;
};

type IngestArgs = {
  symbol: string;
  openInterestValue: number;
  tsMs: number;
};

export type MinuteOiRecorderIngestResult = {
  wrote: boolean;
  completedMinuteTs: number | null;
};

const MINUTE_MS = 60_000;
const FIVE_MIN_MS = 5 * MINUTE_MS;

function floorToMinute(tsMs: number): number {
  return Math.floor(tsMs / MINUTE_MS) * MINUTE_MS;
}

function isIntermediateMinute(tsMs: number): boolean {
  return tsMs % FIVE_MIN_MS !== 0;
}

function readLastNonEmptyLine(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return null;
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line) return line;
  }
  return null;
}

function toUtcDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export class MinuteOiRecorder {
  private readonly rootDir: string;
  private mode: MinuteOiRecorderMode = "off";
  private activeMode: MinuteOiRecorderMode = "off";
  private state: MinuteOiRecorderState = "idle";
  private message: string | null = "Recorder is waiting for runtime session.";
  private writes = 0;
  private droppedBoundaryPoints = 0;
  private trackedSymbols = new Set<string>();
  private symbolLastMinuteTs = new Map<string, number>();
  private minuteSymbolCoverage = new Map<number, Set<string>>();
  private lastCompletedMinuteTs: number | null = null;
  private lastWriteAtMs: number | null = null;

  constructor(rootDir = path.resolve(process.cwd(), "data", "recorder", "bybit", "open_interest_1m")) {
    this.rootDir = rootDir;
  }

  setMode(mode: MinuteOiRecorderMode) {
    this.mode = mode;
    if (mode === "off") {
      this.state = "idle";
      this.activeMode = "off";
      this.message = "Recorder is not started.";
      this.trackedSymbols.clear();
      this.minuteSymbolCoverage.clear();
      this.lastCompletedMinuteTs = null;
      return;
    }
    if (this.state !== "running") {
      this.activeMode = "off";
      this.message = mode === "record_only"
        ? "Recorder is waiting for record-only stream."
        : "Recorder is waiting for runtime session.";
    }
  }

  activate(symbols: string[]) {
    if (this.mode === "off") return;
    this.activeMode = this.mode;
    this.state = "running";
    this.message = this.mode === "record_only"
      ? "Recording minute OI from Bybit WS (record-only mode)."
      : "Recording minute OI from Bybit WS (record-while-running mode).";
    this.trackedSymbols = new Set((Array.isArray(symbols) ? symbols : []).map((s) => String(s ?? "").trim()).filter(Boolean));
    this.minuteSymbolCoverage.clear();
    this.lastCompletedMinuteTs = null;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  deactivate() {
    if (this.mode === "off") {
      this.state = "idle";
      this.activeMode = "off";
      this.message = "Recorder is not started.";
      this.trackedSymbols.clear();
      this.minuteSymbolCoverage.clear();
      this.lastCompletedMinuteTs = null;
      return;
    }
    this.state = "idle";
    this.activeMode = "off";
    this.message = this.mode === "record_only"
      ? "Recorder is waiting for record-only stream."
      : "Recorder is waiting for runtime session.";
    this.trackedSymbols.clear();
    this.minuteSymbolCoverage.clear();
    this.lastCompletedMinuteTs = null;
  }

  ingestTicker(args: IngestArgs): MinuteOiRecorderIngestResult {
    if (this.activeMode === "off" || this.state !== "running") return { wrote: false, completedMinuteTs: null };
    const symbol = String(args.symbol ?? "").trim();
    const oiv = Number(args.openInterestValue);
    const tsMs = Number(args.tsMs);
    if (!symbol || !Number.isFinite(oiv) || oiv <= 0 || !Number.isFinite(tsMs) || tsMs <= 0) return { wrote: false, completedMinuteTs: null };
    if (this.trackedSymbols.size > 0 && !this.trackedSymbols.has(symbol)) return { wrote: false, completedMinuteTs: null };

    const minuteTs = floorToMinute(tsMs);
    if (!isIntermediateMinute(minuteTs)) {
      this.droppedBoundaryPoints += 1;
      return { wrote: false, completedMinuteTs: null };
    }

    const filePath = this.chunkFilePath(symbol, minuteTs);
    const knownLast = this.symbolLastMinuteTs.get(symbol);
    const lastMinuteTs = knownLast ?? this.readLastMinuteTsFromDisk(symbol);
    if (lastMinuteTs != null) this.symbolLastMinuteTs.set(symbol, lastMinuteTs);
    if (lastMinuteTs != null && minuteTs <= lastMinuteTs) return { wrote: false, completedMinuteTs: null };

    const row: RecorderMinuteOiRow = {
      ts: minuteTs,
      openInterestValue: oiv,
      source: "bybit_ws",
      recordedAtMs: Date.now(),
    };
    this.appendRow(filePath, row);
    this.symbolLastMinuteTs.set(symbol, minuteTs);
    this.writes += 1;
    this.lastWriteAtMs = row.recordedAtMs;
    let completedMinuteTs: number | null = null;
    const coverage = this.minuteSymbolCoverage.get(minuteTs) ?? new Set<string>();
    coverage.add(symbol);
    this.minuteSymbolCoverage.set(minuteTs, coverage);
    if (this.trackedSymbols.size > 0 && coverage.size >= this.trackedSymbols.size) {
      if (this.lastCompletedMinuteTs == null || minuteTs > this.lastCompletedMinuteTs) {
        this.lastCompletedMinuteTs = minuteTs;
        completedMinuteTs = minuteTs;
      }
      for (const [trackedMinuteTs] of this.minuteSymbolCoverage) {
        if (trackedMinuteTs <= minuteTs) this.minuteSymbolCoverage.delete(trackedMinuteTs);
      }
    }
    return { wrote: true, completedMinuteTs };
  }

  getStatus(): MinuteOiRecorderStatus {
    const isWaiting = this.state === "idle" && this.mode !== "off";
    return {
      state: isWaiting ? "waiting" : this.state,
      mode: this.mode,
      message: this.message,
      writes: this.writes,
      droppedBoundaryPoints: this.droppedBoundaryPoints,
      trackedSymbols: this.trackedSymbols.size,
      lastWriteAtMs: this.lastWriteAtMs,
    };
  }

  readSymbolRows(symbol: string): Map<number, RecorderMinuteOiRow> {
    const result = new Map<number, RecorderMinuteOiRow>();
    for (const filePath of this.getSymbolReadFiles(symbol)) {
      const raw = fs.readFileSync(filePath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as RecorderMinuteOiRow;
          const ts = Number(row?.ts);
          const oiv = Number(row?.openInterestValue);
          if (!Number.isFinite(ts) || !Number.isFinite(oiv) || oiv <= 0) continue;
          result.set(ts, { ...row, ts, openInterestValue: oiv, source: "bybit_ws" });
        } catch {
          continue;
        }
      }
    }
    return result;
  }

  private chunkFilePath(symbol: string, tsMs: number): string {
    return path.join(this.rootDir, symbol, `${toUtcDayKey(tsMs)}.jsonl`);
  }

  private getSymbolReadFiles(symbol: string): string[] {
    const files: string[] = [];
    const symbolDir = path.join(this.rootDir, symbol);
    if (fs.existsSync(symbolDir) && fs.statSync(symbolDir).isDirectory()) {
      const chunkFiles = fs.readdirSync(symbolDir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => path.join(symbolDir, name));
      files.push(...chunkFiles);
    }
    const legacyFile = path.join(this.rootDir, `${symbol}.jsonl`);
    if (fs.existsSync(legacyFile)) files.push(legacyFile);
    return files;
  }

  private readLastMinuteTsFromDisk(symbol: string): number | null {
    let maxTs: number | null = null;
    const files = this.getSymbolReadFiles(symbol);
    for (const filePath of files) {
      const lastLine = readLastNonEmptyLine(filePath);
      if (!lastLine) continue;
      try {
        const parsed = JSON.parse(lastLine) as RecorderMinuteOiRow;
        const ts = Number(parsed?.ts);
        if (!Number.isFinite(ts)) continue;
        if (maxTs == null || ts > maxTs) maxTs = ts;
      } catch {
        continue;
      }
    }
    return maxTs;
  }

  private appendRow(filePath: string, row: RecorderMinuteOiRow) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
  }
}

export function mergeMinuteOiByTimestamp<T extends { startMs: number; openInterestValue?: number | null }>(
  rows: T[],
  minuteOi: Map<number, RecorderMinuteOiRow>,
): T[] {
  return rows.map((row) => {
    const ts = Number(row.startMs);
    if (!Number.isFinite(ts)) return row;
    if (ts % FIVE_MIN_MS === 0) return row;
    if (row.openInterestValue != null && Number.isFinite(Number(row.openInterestValue))) return row;
    const recorder = minuteOi.get(ts);
    if (!recorder) return row;
    return { ...row, openInterestValue: recorder.openInterestValue };
  });
}
