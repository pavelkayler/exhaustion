import fs from "node:fs";
import path from "node:path";

export type MinuteMarketRecorderMode = "off" | "record_only" | "record_while_running";
export type MinuteMarketRecorderState = "idle" | "waiting" | "running" | "error";

export type MinuteMarketRecorderStatus = {
  state: MinuteMarketRecorderState;
  mode: MinuteMarketRecorderMode;
  message: string | null;
  writes: number;
  trackedSymbols: number;
  lastWriteAtMs: number | null;
};

export type RecorderMinuteMarketRow = {
  ts: number;
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
  openInterestValue: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  fundingIntervalHour: number | null;
  turnover24hUsd: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;
  source: "bybit_ws";
  recordedAtMs: number;
};

type IngestArgs = {
  symbol: string;
  kline: Record<string, any>;
  market: {
    markPrice: number | null;
    lastPrice: number | null;
    bid1: number | null;
    ask1: number | null;
    openInterestValue: number | null;
    fundingRate: number | null;
    nextFundingTime: number | null;
    fundingIntervalHour: number | null;
    turnover24hUsd: number | null;
    highPrice24h: number | null;
    lowPrice24h: number | null;
  } | null;
};

function toUtcDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
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

function numOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readConfirmedMinuteTs(kline: Record<string, any>): number | null {
  const startTs = numOrNull(kline?.start ?? kline?.startTime ?? kline?.timestamp ?? null);
  if (!Number.isFinite(startTs as number) || Number(startTs) <= 0) return null;
  return Math.floor(Number(startTs) / 60_000) * 60_000;
}

export class MinuteMarketRecorder {
  private readonly rootDir: string;
  private mode: MinuteMarketRecorderMode = "off";
  private activeMode: MinuteMarketRecorderMode = "off";
  private state: MinuteMarketRecorderState = "idle";
  private message: string | null = "Market recorder is waiting for runtime session.";
  private writes = 0;
  private trackedSymbols = new Set<string>();
  private symbolLastMinuteTs = new Map<string, number>();
  private lastWriteAtMs: number | null = null;

  constructor(rootDir = path.resolve(process.cwd(), "data", "recorder", "bybit", "market_1m")) {
    this.rootDir = rootDir;
  }

  setMode(mode: MinuteMarketRecorderMode) {
    this.mode = mode;
    if (mode === "off") {
      this.state = "idle";
      this.activeMode = "off";
      this.message = "Market recorder is not started.";
      this.trackedSymbols.clear();
      return;
    }
    if (this.state !== "running") {
      this.activeMode = "off";
      this.message = mode === "record_only"
        ? "Market recorder is waiting for record-only stream."
        : "Market recorder is waiting for runtime session.";
    }
  }

  activate(symbols: string[]) {
    if (this.mode === "off") return;
    this.activeMode = this.mode;
    this.state = "running";
    this.message = this.mode === "record_only"
      ? "Recording 1m market candles from Bybit WS (record-only mode)."
      : "Recording 1m market candles from Bybit WS (record-while-running mode).";
    this.trackedSymbols = new Set((Array.isArray(symbols) ? symbols : []).map((s) => String(s ?? "").trim()).filter(Boolean));
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  deactivate() {
    if (this.mode === "off") {
      this.state = "idle";
      this.activeMode = "off";
      this.message = "Market recorder is not started.";
      this.trackedSymbols.clear();
      return;
    }
    this.state = "idle";
    this.activeMode = "off";
    this.message = this.mode === "record_only"
      ? "Market recorder is waiting for record-only stream."
      : "Market recorder is waiting for runtime session.";
    this.trackedSymbols.clear();
  }

  ingestKline(args: IngestArgs): boolean {
    if (this.activeMode === "off" || this.state !== "running") return false;
    const symbol = String(args.symbol ?? "").trim();
    if (!symbol) return false;
    if (this.trackedSymbols.size > 0 && !this.trackedSymbols.has(symbol)) return false;

    const minuteTs = readConfirmedMinuteTs(args.kline);
    if (minuteTs == null) return false;

    const open = numOrNull(args.kline?.open ?? args.kline?.o);
    const high = numOrNull(args.kline?.high ?? args.kline?.h);
    const low = numOrNull(args.kline?.low ?? args.kline?.l);
    const close = numOrNull(args.kline?.close ?? args.kline?.c);
    if (open == null || high == null || low == null || close == null || close <= 0) return false;

    const lastMinuteTs = this.symbolLastMinuteTs.get(symbol) ?? this.readLastMinuteTsFromDisk(symbol);
    if (lastMinuteTs != null) this.symbolLastMinuteTs.set(symbol, lastMinuteTs);
    if (lastMinuteTs != null && minuteTs <= lastMinuteTs) return false;

    const row: RecorderMinuteMarketRow = {
      ts: minuteTs,
      open,
      high,
      low,
      close,
      volume: numOrNull(args.kline?.volume ?? args.kline?.vol),
      turnover: numOrNull(args.kline?.turnover),
      markPrice: numOrNull(args.market?.markPrice),
      lastPrice: numOrNull(args.market?.lastPrice),
      bid1: numOrNull(args.market?.bid1),
      ask1: numOrNull(args.market?.ask1),
      openInterestValue: numOrNull(args.market?.openInterestValue),
      fundingRate: numOrNull(args.market?.fundingRate),
      nextFundingTime: numOrNull(args.market?.nextFundingTime),
      fundingIntervalHour: numOrNull(args.market?.fundingIntervalHour),
      turnover24hUsd: numOrNull(args.market?.turnover24hUsd),
      highPrice24h: numOrNull(args.market?.highPrice24h),
      lowPrice24h: numOrNull(args.market?.lowPrice24h),
      source: "bybit_ws",
      recordedAtMs: Date.now(),
    };

    const filePath = this.chunkFilePath(symbol, minuteTs);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
    this.symbolLastMinuteTs.set(symbol, minuteTs);
    this.writes += 1;
    this.lastWriteAtMs = row.recordedAtMs;
    return true;
  }

  getStatus(): MinuteMarketRecorderStatus {
    const isWaiting = this.state === "idle" && this.mode !== "off";
    return {
      state: isWaiting ? "waiting" : this.state,
      mode: this.mode,
      message: this.message,
      writes: this.writes,
      trackedSymbols: this.trackedSymbols.size,
      lastWriteAtMs: this.lastWriteAtMs,
    };
  }

  readSymbolRows(symbol: string): Map<number, RecorderMinuteMarketRow> {
    const result = new Map<number, RecorderMinuteMarketRow>();
    for (const filePath of this.getSymbolReadFiles(symbol)) {
      const raw = fs.readFileSync(filePath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as RecorderMinuteMarketRow;
          const ts = numOrNull(row?.ts);
          const close = numOrNull(row?.close);
          if (ts == null || close == null || close <= 0) continue;
          result.set(ts, { ...row, ts, close, source: "bybit_ws" });
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
    const symbolDir = path.join(this.rootDir, symbol);
    if (!fs.existsSync(symbolDir) || !fs.statSync(symbolDir).isDirectory()) return [];
    return fs.readdirSync(symbolDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => path.join(symbolDir, name));
  }

  private readLastMinuteTsFromDisk(symbol: string): number | null {
    let maxTs: number | null = null;
    for (const filePath of this.getSymbolReadFiles(symbol)) {
      const lastLine = readLastNonEmptyLine(filePath);
      if (!lastLine) continue;
      try {
        const parsed = JSON.parse(lastLine) as RecorderMinuteMarketRow;
        const ts = numOrNull(parsed?.ts);
        if (ts == null) continue;
        if (maxTs == null || ts > maxTs) maxTs = ts;
      } catch {
        continue;
      }
    }
    return maxTs;
  }
}
