import fs from "node:fs";
import path from "node:path";
import type { LogEvent } from "../../logging/EventLogger.js";
import type { BybitLongShortRatioSnapshot } from "../../engine/BybitLongShortRatioStore.js";
import type { BybitOrderbookSummary } from "../../engine/BybitOrderbookStore.js";
import type { LiquidationWindowSnapshot } from "../../engine/LiquidationWindowStore.js";
import type { ShortExhaustionSignalSnapshot } from "../../engine/ShortExhaustionSignalEngine.js";
import type { ShortSignalReferenceMarketSnapshot } from "../../analytics/shortSignalOutcomeTypes.js";
import type { ShortRuntimeContext, ShortRuntimeCvdFeatures } from "../shared/shortRuntimeCore.js";

export type ShortResearchMinuteRow = {
  source: "live";
  symbol: string;
  minuteStartMs: number;
  minuteCloseTs: number;
  evaluationTs: number;
  universeSelectedId: string | null;
  universeSize: number;
  signalVersion: string;
  featureSchemaVersion: string;
  context: ShortRuntimeContext;
  market: {
    markPrice: number | null;
    lastPrice: number | null;
    bid1: number | null;
    ask1: number | null;
    midPrice: number | null;
    spreadBps: number | null;
    turnover24hUsd: number | null;
    openInterestValue: number | null;
    fundingRate: number | null;
    highPrice24h: number | null;
    lowPrice24h: number | null;
    updatedAt: number | null;
  };
  bar?: {
    startMs: number;
    endMs: number;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    turnover: number | null;
  } | null;
  referenceMarket: ShortSignalReferenceMarketSnapshot | null;
  cvd: ShortRuntimeCvdFeatures;
  liquidation: LiquidationWindowSnapshot;
  orderbook: BybitOrderbookSummary;
  longShortRatio: BybitLongShortRatioSnapshot;
  snapshot: ShortExhaustionSignalSnapshot;
};

function toUtcDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function normalizeSymbol(symbolRaw: string): string {
  return String(symbolRaw ?? "").trim().toUpperCase();
}

export class ShortResearchRecorder {
  private readonly rootDir: string;
  private readonly lastMinuteBySymbol = new Map<string, number>();
  private readonly lastTransitionKeyBySymbol = new Map<string, string>();

  constructor(rootDir = path.resolve(process.cwd(), "data", "short_research")) {
    this.rootDir = rootDir;
  }

  noteMinuteEvaluation(row: ShortResearchMinuteRow): boolean {
    const symbol = normalizeSymbol(row.symbol);
    if (!symbol || !Number.isFinite(row.minuteStartMs) || row.minuteStartMs <= 0) return false;
    const lastMinute = this.lastMinuteBySymbol.get(symbol) ?? null;
    if (lastMinute != null && row.minuteStartMs <= lastMinute) return false;
    const filePath = path.join(this.rootDir, "minutes", symbol, `${toUtcDayKey(row.minuteStartMs)}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify({ ...row, symbol })}\n`, "utf8");
    this.lastMinuteBySymbol.set(symbol, row.minuteStartMs);
    return true;
  }

  noteTransition(event: LogEvent): boolean {
    const eventType = String(event?.type ?? "");
    if (eventType !== "SHORT_SIGNAL_TRANSITION" && eventType !== "SHORT_SIGNAL_TRIGGER") return false;
    const symbol = normalizeSymbol(String(event?.symbol ?? ""));
    const ts = Number(event?.ts ?? 0);
    if (!symbol || !Number.isFinite(ts) || ts <= 0) return false;
    const key = `${eventType}:${ts}:${JSON.stringify(event?.payload ?? null)}`;
    const prev = this.lastTransitionKeyBySymbol.get(symbol);
    if (prev === key) return false;
    const filePath = path.join(this.rootDir, "transitions", `${toUtcDayKey(ts)}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
    this.lastTransitionKeyBySymbol.set(symbol, key);
    return true;
  }
}

export const shortResearchRecorder = new ShortResearchRecorder();
