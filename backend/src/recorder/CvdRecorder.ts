import fs from "node:fs";
import path from "node:path";
import { fetchBybitRecentLinearTrades } from "../bybit/recentTrade.js";

export type CvdRecorderMode = "off" | "record_only" | "record_while_running";
export type CvdRecorderState = "idle" | "waiting" | "running" | "error";

export type Cvd1sBucket = {
  ts: number;
  buyAggVolume: number;
  sellAggVolume: number;
  delta: number;
  buyAggNotional: number;
  sellAggNotional: number;
  deltaNotional: number;
  tradesCount: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type Cvd1mBar = {
  ts: number;
  buyAggVolume: number;
  sellAggVolume: number;
  delta: number;
  cvd: number;
  buyAggNotional: number;
  sellAggNotional: number;
  deltaNotional: number;
  tradesCount: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type CvdTradeInput = {
  symbol: string;
  side: "Buy" | "Sell";
  price: number;
  size: number;
  ts: number;
  tradesCount?: number;
};

type SymbolState = {
  lastSeenTradeTs: number;
  lastCvd: number;
};
type SymbolDerivedCache = {
  n10: DerivedFeatures;
  n20: DerivedFeatures;
};

export type CvdRecorderStatus = {
  state: CvdRecorderState;
  mode: CvdRecorderMode;
  message: string | null;
  writes1s: number;
  writes1m: number;
  trackedSymbols: number;
  lastWriteAtMs: number | null;
  lastSeenTradeTs: number | null;
};

type DerivedFeatures = {
  rollingDeltaN: number;
  cvdSlopeN: number;
  imbalanceRatio: number;
  divergencePriceUpCvdDown: boolean;
  divergencePriceDownCvdUp: boolean;
};

type SymbolDebug = {
  symbol: string;
  current: {
    cvd1m: number;
    cvd5m: number;
    cvd15m: number;
    cvd1h: number;
    buyAggVolume: number;
    sellAggVolume: number;
    delta: number;
  };
  last10Bars1m: Cvd1mBar[];
  derived: {
    n10: DerivedFeatures;
    n20: DerivedFeatures;
  };
};

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const FIVE_MIN_MS = 5 * MINUTE_MS;
const FIFTEEN_MIN_MS = 15 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_DEDUPE_KEYS = 100_000;
const MAX_RECENT_BARS_PER_SYMBOL = 180;
const STATE_PERSIST_INTERVAL_MS = 30_000;

function floorToSecond(ts: number): number {
  return Math.floor(ts / SECOND_MS) * SECOND_MS;
}
function floorToMinute(ts: number): number {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}
function toUtcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function writeJsonl(filePath: string, row: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const out: any[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

function aggregateBars(source: Cvd1mBar[], tfMs: number): Cvd1mBar[] {
  const grouped = new Map<number, Cvd1mBar>();
  for (const bar of source) {
    const bucketTs = Math.floor(bar.ts / tfMs) * tfMs;
    const prev = grouped.get(bucketTs);
    if (!prev) {
      grouped.set(bucketTs, {
        ...bar,
        ts: bucketTs,
      });
      continue;
    }
    prev.buyAggVolume += bar.buyAggVolume;
    prev.sellAggVolume += bar.sellAggVolume;
    prev.delta += bar.delta;
    prev.buyAggNotional += bar.buyAggNotional;
    prev.sellAggNotional += bar.sellAggNotional;
    prev.deltaNotional += bar.deltaNotional;
    prev.tradesCount += bar.tradesCount;
    prev.high = Math.max(prev.high, bar.high);
    prev.low = Math.min(prev.low, bar.low);
    prev.close = bar.close;
  }
  const rows = Array.from(grouped.values()).sort((a, b) => a.ts - b.ts);
  let cvd = 0;
  for (const bar of rows) {
    cvd += bar.delta;
    bar.cvd = cvd;
  }
  return rows;
}

function computeDerived(source: Cvd1mBar[], n: number): DerivedFeatures {
  const rows = source.slice(-Math.max(2, n));
  if (rows.length < 2) {
    return {
      rollingDeltaN: 0,
      cvdSlopeN: 0,
      imbalanceRatio: 0,
      divergencePriceUpCvdDown: false,
      divergencePriceDownCvdUp: false,
    };
  }
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const rollingDeltaN = rows.reduce((sum, row) => sum + row.delta, 0);
  const cvdSlopeN = (last.cvd - first.cvd) / (rows.length - 1);
  const totalBuy = rows.reduce((sum, row) => sum + row.buyAggVolume, 0);
  const totalSell = rows.reduce((sum, row) => sum + row.sellAggVolume, 0);
  const denominator = totalBuy + totalSell;
  const imbalanceRatio = denominator > 0 ? (totalBuy - totalSell) / denominator : 0;
  const priceChange = last.close - first.close;
  const cvdChange = last.cvd - first.cvd;
  return {
    rollingDeltaN,
    cvdSlopeN,
    imbalanceRatio,
    divergencePriceUpCvdDown: priceChange > 0 && cvdChange < 0,
    divergencePriceDownCvdUp: priceChange < 0 && cvdChange > 0,
  };
}

export class CvdRecorder {
  private readonly rootDir: string;
  private mode: CvdRecorderMode = "off";
  private activeMode: CvdRecorderMode = "off";
  private state: CvdRecorderState = "idle";
  private message: string | null = "CVD recorder is waiting for runtime session.";
  private writes1s = 0;
  private writes1m = 0;
  private trackedSymbols = new Set<string>();
  private lastWriteAtMs: number | null = null;
  private symbolState = new Map<string, SymbolState>();
  private secondBuckets = new Map<string, Map<number, Cvd1sBucket>>();
  private minuteBarsWork = new Map<string, Map<number, Omit<Cvd1mBar, "cvd">>>();
  private dedupe = new Set<string>();
  private dedupeQueue: string[] = [];
  private derivedBySymbol = new Map<string, SymbolDerivedCache>();
  private recentBarsBySymbol = new Map<string, Cvd1mBar[]>();
  private lastStatePersistAtBySymbol = new Map<string, number>();

  constructor(rootDir = path.resolve(process.cwd(), "data", "recorder", "bybit", "cvd")) {
    this.rootDir = rootDir;
  }

  setMode(mode: CvdRecorderMode) {
    this.mode = mode;
    if (mode === "off") {
      this.activeMode = "off";
      this.state = "idle";
      this.message = "CVD recorder is not started.";
      this.trackedSymbols.clear();
      return;
    }
    if (this.state !== "running") {
      this.activeMode = "off";
      this.message = mode === "record_only"
        ? "CVD recorder is waiting for record-only stream."
        : "CVD recorder is waiting for runtime session.";
    }
  }

  activate(symbols: string[]) {
    if (this.mode === "off") return;
    this.activeMode = this.mode;
    this.state = "running";
    this.message = this.mode === "record_only"
      ? "Recording CVD from Bybit public trades (record-only mode)."
      : "Recording CVD from Bybit public trades (record-while-running mode).";
    this.trackedSymbols = new Set((Array.isArray(symbols) ? symbols : []).map((s) => String(s ?? "").trim()).filter(Boolean));
    for (const symbol of this.trackedSymbols) this.ensureSymbolState(symbol);
  }

  deactivate() {
    this.flushAll();
    this.flushAllSymbolStates();
    if (this.mode === "off") {
      this.state = "idle";
      this.activeMode = "off";
      this.message = "CVD recorder is not started.";
      this.trackedSymbols.clear();
      return;
    }
    this.state = "idle";
    this.activeMode = "off";
    this.message = this.mode === "record_only"
      ? "CVD recorder is waiting for record-only stream."
      : "CVD recorder is waiting for runtime session.";
    this.trackedSymbols.clear();
  }

  getStatus(): CvdRecorderStatus {
    const lastSeenTradeTs = Math.max(0, ...Array.from(this.symbolState.values()).map((row) => row.lastSeenTradeTs));
    const isWaiting = this.state === "idle" && this.mode !== "off";
    return {
      state: isWaiting ? "waiting" : this.state,
      mode: this.mode,
      message: this.message,
      writes1s: this.writes1s,
      writes1m: this.writes1m,
      trackedSymbols: this.trackedSymbols.size,
      lastWriteAtMs: this.lastWriteAtMs,
      lastSeenTradeTs: lastSeenTradeTs > 0 ? lastSeenTradeTs : null,
    };
  }

  async bootstrapFromRest(symbols: string[]) {
    if (this.activeMode === "off" || this.state !== "running") return;
    for (const symbol of symbols) {
      if (!symbol) continue;
      try {
        const rows = await fetchBybitRecentLinearTrades({ symbol, limit: 1000 });
        for (const row of rows) {
          this.ingestTrade({ symbol, side: row.side, price: row.price, size: row.size, ts: row.ts });
        }
      } catch {
        continue;
      }
    }
    this.flushAll();
  }

  ingestTrade(input: CvdTradeInput): boolean {
    if (this.activeMode === "off" || this.state !== "running") return false;
    const symbol = String(input.symbol ?? "").trim();
    if (!symbol) return false;
    if (this.trackedSymbols.size > 0 && !this.trackedSymbols.has(symbol)) return false;
    const side = input.side === "Buy" ? "Buy" : input.side === "Sell" ? "Sell" : null;
    const price = Number(input.price);
    const size = Number(input.size);
    const ts = Number(input.ts);
    const tradesCount = Math.max(1, Math.floor(Number(input.tradesCount) || 1));
    if (!side || !Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0 || !Number.isFinite(ts) || ts <= 0) return false;

    if (tradesCount === 1) {
      const dedupeKey = `${symbol}|${ts}|${price}|${size}|${side}`;
      if (this.dedupe.has(dedupeKey)) return false;
      this.dedupe.add(dedupeKey);
      this.dedupeQueue.push(dedupeKey);
      if (this.dedupeQueue.length > MAX_DEDUPE_KEYS) {
        const old = this.dedupeQueue.shift();
        if (old) this.dedupe.delete(old);
      }
    }

    const state = this.ensureSymbolState(symbol);
    if (ts < state.lastSeenTradeTs - 60_000) return false;
    state.lastSeenTradeTs = Math.max(state.lastSeenTradeTs, ts);
    this.maybePersistSymbolState(symbol, state, ts);

    const secTs = floorToSecond(ts);
    const symbolSeconds = this.secondBuckets.get(symbol) ?? new Map<number, Cvd1sBucket>();
    this.secondBuckets.set(symbol, symbolSeconds);
    const prev = symbolSeconds.get(secTs);
    const delta = side === "Buy" ? size : -size;
    const notional = size * price;
    if (!prev) {
      symbolSeconds.set(secTs, {
        ts: secTs,
        buyAggVolume: side === "Buy" ? size : 0,
        sellAggVolume: side === "Sell" ? size : 0,
        delta,
        buyAggNotional: side === "Buy" ? notional : 0,
        sellAggNotional: side === "Sell" ? notional : 0,
        deltaNotional: side === "Buy" ? notional : -notional,
        tradesCount,
        open: price,
        high: price,
        low: price,
        close: price,
      });
    } else {
      prev.buyAggVolume += side === "Buy" ? size : 0;
      prev.sellAggVolume += side === "Sell" ? size : 0;
      prev.delta += delta;
      prev.buyAggNotional += side === "Buy" ? notional : 0;
      prev.sellAggNotional += side === "Sell" ? notional : 0;
      prev.deltaNotional += side === "Buy" ? notional : -notional;
      prev.tradesCount += tradesCount;
      prev.high = Math.max(prev.high, price);
      prev.low = Math.min(prev.low, price);
      prev.close = price;
    }

    this.flushOldSecondBuckets(symbol, secTs);
    return true;
  }

  getDebugSnapshot(args?: { symbols?: string[] }) {
    const symbols = (args?.symbols && args.symbols.length > 0 ? args.symbols : Array.from(this.trackedSymbols)).slice(0, 50);
    const rows: SymbolDebug[] = [];
    for (const symbol of symbols) {
      const bars1m = this.readBars1m(symbol);
      const last = bars1m[bars1m.length - 1] ?? null;
      const bars5m = aggregateBars(bars1m, FIVE_MIN_MS);
      const bars15m = aggregateBars(bars1m, FIFTEEN_MIN_MS);
      const bars1h = aggregateBars(bars1m, HOUR_MS);
      rows.push({
        symbol,
        current: {
          cvd1m: last?.cvd ?? 0,
          cvd5m: bars5m[bars5m.length - 1]?.cvd ?? 0,
          cvd15m: bars15m[bars15m.length - 1]?.cvd ?? 0,
          cvd1h: bars1h[bars1h.length - 1]?.cvd ?? 0,
          buyAggVolume: last?.buyAggVolume ?? 0,
          sellAggVolume: last?.sellAggVolume ?? 0,
          delta: last?.delta ?? 0,
        },
        last10Bars1m: bars1m.slice(-10),
        derived: {
          n10: computeDerived(bars1m, 10),
          n20: computeDerived(bars1m, 20),
        },
      });
    }
    return { status: this.getStatus(), symbols: rows };
  }

  getSignalFeatures(symbol: string): {
    cvdDelta: number | null;
    cvdImbalanceRatio: number | null;
    divergencePriceUpCvdDown: boolean;
    divergencePriceDownCvdUp: boolean;
  } {
    const key = String(symbol ?? "").trim();
    if (!key) {
      return {
        cvdDelta: null,
        cvdImbalanceRatio: null,
        divergencePriceUpCvdDown: false,
        divergencePriceDownCvdUp: false,
      };
    }
    const fromCache = this.derivedBySymbol.get(key);
    if (fromCache) {
      return {
        cvdDelta: fromCache.n10.rollingDeltaN,
        cvdImbalanceRatio: fromCache.n10.imbalanceRatio,
        divergencePriceUpCvdDown: fromCache.n10.divergencePriceUpCvdDown,
        divergencePriceDownCvdUp: fromCache.n10.divergencePriceDownCvdUp,
      };
    }
    this.refreshDerivedForSymbol(key);
    const loaded = this.derivedBySymbol.get(key);
    return {
      cvdDelta: loaded?.n10.rollingDeltaN ?? null,
      cvdImbalanceRatio: loaded?.n10.imbalanceRatio ?? null,
      divergencePriceUpCvdDown: loaded?.n10.divergencePriceUpCvdDown ?? false,
      divergencePriceDownCvdUp: loaded?.n10.divergencePriceDownCvdUp ?? false,
    };
  }

  private ensureSymbolState(symbol: string): SymbolState {
    const known = this.symbolState.get(symbol);
    if (known) return known;
    const fromDisk = this.readSymbolState(symbol);
    this.symbolState.set(symbol, fromDisk);
    return fromDisk;
  }

  private symbolStatePath(symbol: string): string {
    return path.join(this.rootDir, "state", `${symbol}.json`);
  }

  private readSymbolState(symbol: string): SymbolState {
    const fp = this.symbolStatePath(symbol);
    if (!fs.existsSync(fp)) return { lastSeenTradeTs: 0, lastCvd: 0 };
    try {
      const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
      const lastSeenTradeTs = Number(raw?.lastSeenTradeTs ?? 0);
      const lastCvd = Number(raw?.lastCvd ?? 0);
      return {
        lastSeenTradeTs: Number.isFinite(lastSeenTradeTs) ? Math.max(0, lastSeenTradeTs) : 0,
        lastCvd: Number.isFinite(lastCvd) ? lastCvd : 0,
      };
    } catch {
      return { lastSeenTradeTs: 0, lastCvd: 0 };
    }
  }

  private persistSymbolState(symbol: string, state: SymbolState) {
    const fp = this.symbolStatePath(symbol);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(state), "utf8");
    this.lastStatePersistAtBySymbol.set(symbol, Date.now());
  }

  private maybePersistSymbolState(symbol: string, state: SymbolState, nowMs: number, force = false) {
    const lastPersistAt = this.lastStatePersistAtBySymbol.get(symbol) ?? 0;
    if (!force && nowMs - lastPersistAt < STATE_PERSIST_INTERVAL_MS) return;
    this.persistSymbolState(symbol, state);
  }

  private flushAllSymbolStates() {
    const now = Date.now();
    for (const [symbol, state] of this.symbolState.entries()) {
      this.maybePersistSymbolState(symbol, state, now, true);
    }
  }

  private bar1mPath(symbol: string, ts: number): string {
    return path.join(this.rootDir, "1m", symbol, `${toUtcDayKey(ts)}.jsonl`);
  }

  private flushOldSecondBuckets(symbol: string, latestSecTs: number) {
    const symbolSeconds = this.secondBuckets.get(symbol);
    if (!symbolSeconds) return;
    const threshold = latestSecTs - 5_000;
    const toFlush = Array.from(symbolSeconds.keys()).filter((ts) => ts <= threshold).sort((a, b) => a - b);
    for (const ts of toFlush) {
      const bucket = symbolSeconds.get(ts);
      if (!bucket) continue;
      symbolSeconds.delete(ts);
      this.flushSecondBucket(symbol, bucket);
    }
  }

  private flushSecondBucket(symbol: string, bucket: Cvd1sBucket) {
    const minuteTs = floorToMinute(bucket.ts);
    const symbolMinutes = this.minuteBarsWork.get(symbol) ?? new Map<number, Omit<Cvd1mBar, "cvd">>();
    this.minuteBarsWork.set(symbol, symbolMinutes);
    const prev = symbolMinutes.get(minuteTs);
    if (!prev) {
      symbolMinutes.set(minuteTs, {
        ts: minuteTs,
        buyAggVolume: bucket.buyAggVolume,
        sellAggVolume: bucket.sellAggVolume,
        delta: bucket.delta,
        buyAggNotional: bucket.buyAggNotional,
        sellAggNotional: bucket.sellAggNotional,
        deltaNotional: bucket.deltaNotional,
        tradesCount: bucket.tradesCount,
        open: bucket.open,
        high: bucket.high,
        low: bucket.low,
        close: bucket.close,
      });
    } else {
      prev.buyAggVolume += bucket.buyAggVolume;
      prev.sellAggVolume += bucket.sellAggVolume;
      prev.delta += bucket.delta;
      prev.buyAggNotional += bucket.buyAggNotional;
      prev.sellAggNotional += bucket.sellAggNotional;
      prev.deltaNotional += bucket.deltaNotional;
      prev.tradesCount += bucket.tradesCount;
      prev.high = Math.max(prev.high, bucket.high);
      prev.low = Math.min(prev.low, bucket.low);
      prev.close = bucket.close;
    }

    const flushBeforeMinute = minuteTs - MINUTE_MS;
    const toFlush = Array.from(symbolMinutes.keys()).filter((ts) => ts <= flushBeforeMinute).sort((a, b) => a - b);
    for (const ts of toFlush) {
      const bar = symbolMinutes.get(ts);
      if (!bar) continue;
      symbolMinutes.delete(ts);
      this.flushMinuteBar(symbol, bar);
    }
  }

  private flushMinuteBar(symbol: string, bar: Omit<Cvd1mBar, "cvd">) {
    const state = this.ensureSymbolState(symbol);
    const full: Cvd1mBar = { ...bar, cvd: state.lastCvd + bar.delta };
    state.lastCvd = full.cvd;
    this.persistSymbolState(symbol, state);
    writeJsonl(this.bar1mPath(symbol, full.ts), full);
    this.writes1m += 1;
    this.lastWriteAtMs = Date.now();
    this.pushRecentBar(symbol, full);
    this.refreshDerivedForSymbol(symbol);
  }

  private flushAll() {
    for (const [symbol, seconds] of this.secondBuckets) {
      const secKeys = Array.from(seconds.keys()).sort((a, b) => a - b);
      for (const ts of secKeys) {
        const bucket = seconds.get(ts);
        if (!bucket) continue;
        seconds.delete(ts);
        this.flushSecondBucket(symbol, bucket);
      }
    }
    for (const [symbol, minutes] of this.minuteBarsWork) {
      const minKeys = Array.from(minutes.keys()).sort((a, b) => a - b);
      for (const ts of minKeys) {
        const bar = minutes.get(ts);
        if (!bar) continue;
        minutes.delete(ts);
        this.flushMinuteBar(symbol, bar);
      }
    }
  }

  private readBars1m(symbol: string): Cvd1mBar[] {
    const dir = path.join(this.rootDir, "1m", symbol);
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
    const rows: Cvd1mBar[] = [];
    for (const file of files) {
      const parsed = readJsonl(path.join(dir, file));
      for (const row of parsed) {
        const ts = Number(row?.ts);
        if (!Number.isFinite(ts)) continue;
        rows.push({
          ts,
          buyAggVolume: Number(row?.buyAggVolume ?? 0) || 0,
          sellAggVolume: Number(row?.sellAggVolume ?? 0) || 0,
          delta: Number(row?.delta ?? 0) || 0,
          cvd: Number(row?.cvd ?? 0) || 0,
          buyAggNotional: Number(row?.buyAggNotional ?? 0) || 0,
          sellAggNotional: Number(row?.sellAggNotional ?? 0) || 0,
          deltaNotional: Number(row?.deltaNotional ?? 0) || 0,
          tradesCount: Number(row?.tradesCount ?? 0) || 0,
          open: Number(row?.open ?? 0) || 0,
          high: Number(row?.high ?? 0) || 0,
          low: Number(row?.low ?? 0) || 0,
          close: Number(row?.close ?? 0) || 0,
        });
      }
    }
    rows.sort((a, b) => a.ts - b.ts);
    return rows;
  }

  private pushRecentBar(symbol: string, bar: Cvd1mBar) {
    const current = this.recentBarsBySymbol.get(symbol) ?? [];
    const next = current.filter((row) => row.ts !== bar.ts);
    next.push(bar);
    next.sort((a, b) => a.ts - b.ts);
    if (next.length > MAX_RECENT_BARS_PER_SYMBOL) {
      next.splice(0, next.length - MAX_RECENT_BARS_PER_SYMBOL);
    }
    this.recentBarsBySymbol.set(symbol, next);
  }

  private refreshDerivedForSymbol(symbol: string) {
    let rows = this.recentBarsBySymbol.get(symbol) ?? [];
    if (!rows.length) {
      rows = this.readBars1m(symbol);
      if (rows.length > MAX_RECENT_BARS_PER_SYMBOL) {
        rows = rows.slice(-MAX_RECENT_BARS_PER_SYMBOL);
      }
      if (rows.length) {
        this.recentBarsBySymbol.set(symbol, rows);
      }
    }
    this.derivedBySymbol.set(symbol, {
      n10: computeDerived(rows, 10),
      n20: computeDerived(rows, 20),
    });
  }
}
