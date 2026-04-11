import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { CONFIG } from "../config.js";
import { BybitWsClient } from "../bybit/BybitWsClient.js";
import { BybitMarketCache } from "../engine/BybitMarketCache.js";
import { BybitLongShortRatioStore } from "../engine/BybitLongShortRatioStore.js";
import { MarketWindowStore } from "../engine/MarketWindowStore.js";
import { BybitOrderbookStore } from "../engine/BybitOrderbookStore.js";
import { CandleTracker } from "../engine/CandleTracker.js";
import { FundingCooldownGate } from "../engine/FundingCooldownGate.js";
import { LiquidationWindowStore } from "../engine/LiquidationWindowStore.js";
import {
  ShortExhaustionSignalEngine,
  type ShortExhaustionAdvisoryVerdict,
  type ShortExhaustionBiasLabel,
  type ShortExhaustionSignalStage,
  type ShortExhaustionSignalState,
} from "../engine/ShortExhaustionSignalEngine.js";
import { TradeActivityWindowStore } from "../engine/TradeActivityWindowStore.js";
import { runtime } from "../runtime/runtime.js";
import { runtimeDiagnostics } from "../runtime/runtimeDiagnostics.js";
import { setMarketStreamsRuntimeStatus } from "../runtime/marketStreamsStatus.js";
import type { LogEvent } from "../logging/EventLogger.js";
import { configStore, type RuntimeConfig } from "../runtime/configStore.js";
import { LiveUpdateAggregator } from "./liveUpdateAggregator.js";
import { cvdRecorder, minuteMarketRecorder, minuteOiRecorder } from "../recorder/recorderStore.js";
import { resolveRecorderSymbols, setAutoRecorderUniverseSymbols } from "../recorder/recorderUniverseStore.js";
import {
  SHORT_EXHAUSTION_BOT_ID,
  getBotDefinition,
  type ShortExhaustionBotConfig,
} from "../bots/registry.js";
import { readResolvedRecorderSettings } from "../recorder/recorderSettingsStore.js";
import { touchDatasetHistoryTail } from "../dataset/datasetHistoryStore.js";
import {
  applyShortRuntimeUniverseRanks,
  buildShortRuntimeContextEntry,
  buildShortSignalInput,
  buildShortSignalReferenceMarket,
  createEmptyShortRuntimeContext,
  type ShortRuntimeContext,
  type ShortRuntimeRankingRow,
} from "../shortResearch/shared/shortRuntimeCore.js";
import { buildShortSetupLifecycle } from "../shortResearch/shared/shortSetupRefinement.js";
import type { ShortLiveSetupRecord, ShortReplaySetupRevisionRecord, ShortReplaySignalRecord } from "../shortResearch/replay/shortReplayTypes.js";
import { shortResearchRecorder } from "../shortResearch/storage/ShortResearchRecorder.js";
import { shortBybitOiSeedStore } from "../shortResearch/storage/ShortBybitOiSeedStore.js";
import { shortLiveSetupStore } from "../shortResearch/storage/ShortLiveSetupStore.js";
import { appendBybitWsIncident } from "./bybitWsIncidentStore.js";

type AwaitAllStreamsConnectedArgs = {
  timeoutMs: number;
  signal?: AbortSignal;
};

type AwaitStreamsProvider = (args: AwaitAllStreamsConnectedArgs) => Promise<void>;

type SignalSide = "LONG" | "SHORT";

type ShortSignalReferenceMarketSnapshot = {
  capturedAtMs: number;
  bid1: number | null;
  ask1: number | null;
  midPrice: number | null;
  lastPrice: number | null;
  markPrice: number | null;
};

type ShortSignalMinuteBar = {
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

let awaitStreamsProvider: AwaitStreamsProvider | null = null;
let streamLifecycleSyncProvider: (() => void) | null = null;
let manualTestOrderProvider: ((args: { symbol: string; side: "LONG" | "SHORT"; executionMode?: "demo" | "real"; entryPrice?: number; tpPrice?: number; slPrice?: number; marginUSDT?: number; leverage?: number }) => Promise<any>) | null = null;
const wsProbeBotIds = new Set<string>();

type WsStreamProbeCounter = {
  lastMessageAtMs: number | null;
  messages: number;
  symbols: Set<string>;
};

type LiquidationProbeEvent = {
  ts: number;
  symbol: string;
  liquidationSide: "LONG" | "SHORT" | null;
  price: number | null;
  size: number | null;
};

function createWsStreamProbeCounter(): WsStreamProbeCounter {
  return {
    lastMessageAtMs: null,
    messages: 0,
    symbols: new Set<string>(),
  };
}

const wsProbeState = {
  streamsEnabled: false,
  bybitConnected: false,
  ticker: createWsStreamProbeCounter(),
  kline: createWsStreamProbeCounter(),
  publicTrade: createWsStreamProbeCounter(),
  liquidation: createWsStreamProbeCounter(),
  recentLiquidations: [] as LiquidationProbeEvent[],
};

const GLOBAL_RECORDER_SYMBOL_SEED_TTL_MS = 6 * 60 * 60 * 1000;

let recorderSeededSymbols: string[] = normalizeSymbols(resolveRecorderSymbols());
let recorderSeededAtMs = 0;
let recorderSeedPromise: Promise<string[]> | null = null;

function resetWsProbeCounters() {
  wsProbeState.ticker = createWsStreamProbeCounter();
  wsProbeState.kline = createWsStreamProbeCounter();
  wsProbeState.publicTrade = createWsStreamProbeCounter();
  wsProbeState.liquidation = createWsStreamProbeCounter();
  wsProbeState.recentLiquidations = [];
}

function noteWsProbeMessage(kind: "ticker" | "kline" | "publicTrade" | "liquidation", symbol: string) {
  const target = wsProbeState[kind];
  target.lastMessageAtMs = Date.now();
  target.messages += 1;
  if (symbol) target.symbols.add(symbol);
}

function pushWsProbeLiquidation(event: LiquidationProbeEvent) {
  wsProbeState.recentLiquidations.push(event);
  if (wsProbeState.recentLiquidations.length > 50) {
    wsProbeState.recentLiquidations.splice(0, wsProbeState.recentLiquidations.length - 50);
  }
}

export function setWsProbeEnabled(botId: string, enabled: boolean) {
  const normalized = String(botId ?? "").trim();
  if (!normalized) return;
  if (enabled) {
    wsProbeBotIds.add(normalized);
    resetWsProbeCounters();
  } else {
    wsProbeBotIds.delete(normalized);
  }
}

export function getWsProbeDiagnostics() {
  return {
    streamsEnabled: wsProbeState.streamsEnabled,
    bybitConnected: wsProbeState.bybitConnected,
    probeBots: Array.from(wsProbeBotIds),
    ticker: {
      lastMessageAtMs: wsProbeState.ticker.lastMessageAtMs,
      messages: wsProbeState.ticker.messages,
      symbolsCount: wsProbeState.ticker.symbols.size,
    },
    kline: {
      lastMessageAtMs: wsProbeState.kline.lastMessageAtMs,
      messages: wsProbeState.kline.messages,
      symbolsCount: wsProbeState.kline.symbols.size,
    },
    publicTrade: {
      lastMessageAtMs: wsProbeState.publicTrade.lastMessageAtMs,
      messages: wsProbeState.publicTrade.messages,
      symbolsCount: wsProbeState.publicTrade.symbols.size,
    },
    liquidation: {
      lastMessageAtMs: wsProbeState.liquidation.lastMessageAtMs,
      messages: wsProbeState.liquidation.messages,
      symbolsCount: wsProbeState.liquidation.symbols.size,
    },
    recentLiquidations: wsProbeState.recentLiquidations.slice(-10),
  };
}

export async function awaitAllStreamsConnected(args: AwaitAllStreamsConnectedArgs): Promise<void> {
  if (!awaitStreamsProvider) {
    throw new Error("ws_hub_not_ready");
  }
  return await awaitStreamsProvider(args);
}

export function requestStreamLifecycleSync() {
  streamLifecycleSyncProvider?.();
}

export async function submitManualTestOrder(args: { symbol: string; side: "LONG" | "SHORT"; executionMode?: "demo" | "real"; entryPrice?: number; tpPrice?: number; slPrice?: number; marginUSDT?: number; leverage?: number }) {
  if (!manualTestOrderProvider) {
    throw new Error("ws_hub_not_ready");
  }
  return await manualTestOrderProvider(args);
}

type SymbolRowBase = {
  symbol: string;
  markPrice: number;
  lastPrice: number | null;
  bid1: number | null;
  ask1: number | null;
  midPrice: number | null;
  openInterestValue: number;
  fundingRate: number;
  nextFundingTime: number;
  fundingIntervalHour: number | null;
  turnover24hUsd: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;
  updatedAt: number;

  prevCandleClose: number | null;
  prevCandleOivClose: number | null;
  candleConfirmedAt: number | null;
  priceMovePct: number | null;
  oivMovePct: number | null;
  shortOiMove5mPct: number | null;
  shortOiMove15mPct: number | null;
  shortOiMove1hPct: number | null;

  cooldownActive: boolean;
  cooldownWindowStartMs: number | null;
  cooldownWindowEndMs: number | null;

  signal: SignalSide | null;
  signalReason: string;

  liquidationState: "IDLE" | "TRACKING_CLUSTER" | "WAITING_CONFIRMATION" | "COOLDOWN";
  liquidationDominantSide: "LONG" | "SHORT" | "MIXED" | null;
  liquidationClusterUsd: number | null;
  liquidationImbalance: number | null;
  liquidationEventsCount: number | null;
  liquidationPriceShockPct: number | null;
  liquidationBouncePct: number | null;
  liquidationOiDeltaPct: number | null;
  liquidationTradeDeltaPct: number | null;
  liquidationScore: number | null;
  liquidationLastEventAt: number | null;
  liquidationConfirmDeadlineMs: number | null;
  liquidationFlushLow: number | null;
  liquidationFlushHigh: number | null;
  liquidationCooldownEndMs: number | null;
  liquidationRejectionReason: string | null;

  shortSignalStage: ShortExhaustionSignalStage | null;
  shortSignalState: ShortExhaustionSignalState | null;
  shortCandidateScore: number | null;
  shortDerivativesScore: number | null;
  shortExhaustionScore: number | null;
  shortMicrostructureScore: number | null;
  shortTotalScore: number | null;
  shortObserveOnly: boolean;
  shortAdvisoryVerdict: ShortExhaustionAdvisoryVerdict | null;
  shortAdvisoryReason: string | null;
  shortBiasLabel: ShortExhaustionBiasLabel | null;
  shortReversalBiasScore: number | null;
  shortSqueezeRiskScore: number | null;
  shortSummaryReason: string | null;
  shortReasons: string[];
  shortHardRejectReasons: string[];
  shortSuppressionReasons: string[];
  shortLongShortRatio: number | null;
  shortOrderbookImbalance: number | null;
  shortAskToBidDepthRatio: number | null;
  shortShortLiquidationUsd60s: number | null;
  shortLongLiquidationUsd60s: number | null;
  shortSetupPreview: ShortLiveSetupRecord | null;
  shortSetupPreviewLastRevision: ShortReplaySetupRevisionRecord | null;
};

type SymbolRow = SymbolRowBase & ReturnType<typeof runtime.getPaperView>;

type StreamsState = {
  streamsEnabled: boolean;
  bybitConnected: boolean;
};

type BotStats = ReturnType<typeof runtime.getBotStats> & {
  unrealizedPnl: number;
};

type BybitWsShardState = {
  key: string;
  topics: string[];
  chars: number;
  client: BybitWsClient;
  connected: boolean;
  lastMessageAtMs: number | null;
};

type ServerWsMessage =
  | { type: "hello"; serverTime: number }
  | { type: "snapshot"; payload: { sessionState: string; sessionId: string | null; runningSinceMs: number | null; rows: SymbolRow[]; botStats: BotStats; universeSelectedId: string; universeSymbolsCount: number; availableWsSymbols: string[]; availableWsRows: Array<{ symbol: string; markPrice: number; lastPrice: number | null; updatedAt: number }>; optimizer?: OptimizerSnapshot } & StreamsState }
  | { type: "tick"; payload: { serverTime: number; rows: SymbolRow[]; botStats: BotStats; universeSelectedId: string; universeSymbolsCount: number; availableWsSymbols: string[]; availableWsRows: Array<{ symbol: string; markPrice: number; lastPrice: number | null; updatedAt: number }> } }
  | { type: "streams_state"; payload: StreamsState }
  | { type: "events_tail"; payload: { limit: number; count: number; events: LogEvent[] } }
  | { type: "events_append"; payload: { event: LogEvent } }
  | { type: "optimizer_rows_append"; payload: { jobId: string; rows: any[] } }
  | { type: "error"; message: string };

type OptimizerSnapshot = {
  jobId: string | null;
  rows: any[];
};

let optimizerSnapshotProvider: (() => OptimizerSnapshot) | null = null;
const optimizerWsClients = new Set<WebSocket>();
let shortSignalsRowsSnapshotProvider: (() => SymbolRow[]) | null = null;
const shortSignalEventCountBySymbol = new Map<string, number>();
let shortSignalEventCountSessionId: string | null = null;

export function setOptimizerSnapshotProvider(provider: (() => OptimizerSnapshot) | null) {
  optimizerSnapshotProvider = provider;
}

export function broadcastOptimizerRowsAppend(jobId: string, rows: any[]) {
  if (!jobId || !Array.isArray(rows) || rows.length === 0) return;
  const msg: ServerWsMessage = { type: "optimizer_rows_append", payload: { jobId, rows } };
  for (const client of optimizerWsClients) safeSend(client, msg);
}

export function getShortSignalsRowsSnapshot(): SymbolRow[] {
  try {
    return shortSignalsRowsSnapshotProvider?.() ?? [];
  } catch {
    return [];
  }
}

export function getShortSignalEventCountBySymbolSnapshot(): Record<string, number> {
  return Object.fromEntries(shortSignalEventCountBySymbol.entries());
}

type ClientWsMessage =
  | { type: "events_tail_request"; payload: { limit: number } }
  | { type: "rows_refresh_request"; payload?: { mode?: "tick" | "snapshot"; detail?: "full" | "preview" } }
  | { type: "streams_toggle_request" }
  | { type: "streams_apply_subscriptions_request" };

function nowMs() {
  return Date.now();
}

function getUniverseInfo(cfg: RuntimeConfig = configStore.get()) {
  const id = String((cfg as any)?.universe?.selectedId ?? "");
  const symbols = Array.isArray((cfg as any)?.universe?.symbols) ? (cfg as any).universe.symbols : [];
  return { universeSelectedId: id, universeSymbolsCount: symbols.length };
}

function getOptimizerSnapshot(): OptimizerSnapshot {
  try {
    const snapshot = optimizerSnapshotProvider?.();
    if (!snapshot) return { jobId: null, rows: [] };
    const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    return {
      jobId: snapshot.jobId ? String(snapshot.jobId) : null,
      rows,
    };
  } catch {
    return { jobId: null, rows: [] };
  }
}

function safeSend(ws: WebSocket, msg: ServerWsMessage) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  } catch {
    // ignore
  }
}

function safeParseClientMsg(raw: string): ClientWsMessage | null {
  try {
    const obj = JSON.parse(raw);

    if (obj?.type === "events_tail_request" && typeof obj?.payload?.limit !== "undefined") {
      const limit = Number(obj.payload.limit);
      if (Number.isFinite(limit)) return { type: "events_tail_request", payload: { limit } };
      return null;
    }

    if (obj?.type === "rows_refresh_request") {
      const modeRaw = obj?.payload?.mode;
      const mode = modeRaw === "snapshot" ? "snapshot" : "tick";
      const detailRaw = obj?.payload?.detail;
      const detail = detailRaw === "full" ? "full" : "preview";
      return { type: "rows_refresh_request", payload: { mode, detail } };
    }

    if (obj?.type === "streams_toggle_request") {
      return { type: "streams_toggle_request" };
    }

    if (obj?.type === "streams_apply_subscriptions_request") {
      return { type: "streams_apply_subscriptions_request" };
    }

    return null;
  } catch {
    return null;
  }
}

function isShortSignalEventType(value: unknown): boolean {
  const type = String(value ?? "").trim().toUpperCase();
  return type === "SHORT_SIGNAL_TRANSITION" || type === "SHORT_SIGNAL_TRIGGER";
}

const BYBIT_PUBLIC_ARGS_CHAR_LIMIT = 18_000;
const BYBIT_MAX_TOPICS_PER_CONNECTION = 160;
const BYBIT_WS_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
const BYBIT_WS_STALE_MS = 45_000;
const MARKET_WS_PROCESS_INTERVAL_MS = 1_000;
const LIVE_UPDATE_FLUSH_INTERVAL_MS = 5_000;
const SHORT_RUNTIME_CONTEXT_CACHE_MS = 60_000;
const CLIENT_ROWS_CACHE_MAX_AGE_MS = 1_500;
const BASE_ROWS_CACHE_MAX_AGE_MS = 60_000;
const STREAM_GUARD_INTERVAL_MS = 5_000;
const EVENT_LOOP_LAG_STALE_GRACE_CAP_MS = 30_000;
const SHORT_CANDIDATE_CLUSTER_WINDOW_MS = 10 * 60_000;
const SHORT_CANDIDATE_REPEAT_MIN_SCORE_DELTA = 0.35;

type ReconnectTarget = {
  reason: string;
  shardKey?: string | null;
  staleMs?: number | null;
  eventLoopLagMs?: number | null;
};

type PendingTickerUpdate = {
  symbol: string;
  data: Record<string, unknown>;
  receivedAtMs: number;
};

type PendingOrderbookUpdate = {
  symbol: string;
  mode: "snapshot" | "delta";
  bids: Map<number, number>;
  asks: Map<number, number>;
  sourceTs: number | null;
  seq: number | null;
};

type PendingTradeUpdate = {
  symbol: string;
  side: "Buy" | "Sell";
  totalSize: number;
  totalNotional: number;
  tradesCount: number;
  lastTs: number;
};

type PendingLiquidationUpdate = {
  symbol: string;
  liquidationSide: "LONG" | "SHORT";
  totalSizeUsd: number;
  eventsCount: number;
  lastTs: number;
  lastPrice: number;
};

function chunkTopicsByCharLimit(
  topics: string[],
  maxChars = BYBIT_PUBLIC_ARGS_CHAR_LIMIT,
  maxTopicsPerChunk = BYBIT_MAX_TOPICS_PER_CONNECTION,
): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let curLen = 0;

  for (const t of topics) {
    const addLen = (cur.length === 0 ? 0 : 1) + t.length;
    if (cur.length > 0 && (curLen + addLen > maxChars || cur.length >= maxTopicsPerChunk)) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(t);
    curLen += addLen;
  }

  if (cur.length) chunks.push(cur);
  return chunks;
}

function sumTopicChars(topics: string[]): number {
  return topics.reduce((acc, topic, index) => acc + topic.length + (index > 0 ? 1 : 0), 0);
}

function normalizeSymbols(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const item of raw) {
    const symbol = String(item ?? "").trim();
    if (symbol) unique.add(symbol);
  }
  return Array.from(unique);
}

function resolveTradingSymbols(cfg: RuntimeConfig): string[] {
  return normalizeSymbols(cfg.universe?.symbols ?? []);
}

function readShortExhaustionConfig(cfg: RuntimeConfig): ShortExhaustionBotConfig {
  return cfg.botConfig as ShortExhaustionBotConfig;
}

function parseOrderbookTopic(topic: string): string | null {
  const parts = topic.split(".");
  if (parts.length < 3) return null;
  const symbol = String(parts[2] ?? "").trim().toUpperCase();
  return symbol || null;
}

function parseOrderbookLevels(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const levels: Array<[number, number]> = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const price = Number(item[0]);
    const size = Number(item[1]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) continue;
    levels.push([price, size]);
  }
  return levels;
}

function buildSymbolScopeKey(cfg: RuntimeConfig): string {
  return JSON.stringify({
    botId: cfg.selectedBotId,
    presetId: cfg.selectedBotPresetId,
    universe: cfg.universe,
  });
}

function getRecorderSymbols(): string[] {
  return recorderSeededSymbols.length > 0
    ? normalizeSymbols(recorderSeededSymbols)
    : normalizeSymbols(resolveRecorderSymbols());
}

async function ensureRecorderSeededSymbols(force = false): Promise<string[]> {
  const stale = Date.now() - recorderSeededAtMs >= GLOBAL_RECORDER_SYMBOL_SEED_TTL_MS;
  if (!force && recorderSeededSymbols.length > 0 && recorderSeededAtMs > 0 && !stale) {
    return recorderSeededSymbols;
  }
  if (recorderSeedPromise) return recorderSeedPromise;
  recorderSeedPromise = (async () => {
    try {
      const configuredUniverseSymbols = normalizeSymbols(configStore.get().universe?.symbols ?? []);
      const seeded = configuredUniverseSymbols.length > 0
        ? configuredUniverseSymbols
        : normalizeSymbols(resolveRecorderSymbols());
      if (seeded.length > 0) {
        const normalized = normalizeSymbols(seeded);
        const changed = JSON.stringify(normalized) !== JSON.stringify(recorderSeededSymbols);
        recorderSeededSymbols = normalized;
        recorderSeededAtMs = Date.now();
        setAutoRecorderUniverseSymbols(normalized);
        if (changed) {
          streamLifecycleSyncProvider?.();
        }
      }
    } catch {
      if (recorderSeededAtMs <= 0) recorderSeededAtMs = Date.now();
    } finally {
      recorderSeedPromise = null;
    }
    return recorderSeededSymbols;
  })();
  return recorderSeedPromise;
}

type SubscriptionTargets = {
  tradingSymbols: string[];
  recorderSymbols: string[];
  tickerSymbols: string[];
  publicTradeSymbols: string[];
  liquidationSymbols: string[];
  orderbookSymbols: string[];
  tradingKlineTf: number;
};

function resolveSubscriptionTargets(
  cfg: RuntimeConfig,
  runtimeActive: boolean,
  recorderMode: "off" | "record_only" | "record_while_running",
  cvdMode: "off" | "record_only" | "record_while_running",
  marketMode: "off" | "record_only" | "record_while_running",
): SubscriptionTargets {
  const shortObserveScope = cfg.selectedBotId === SHORT_EXHAUSTION_BOT_ID;
  const tradingSymbols = runtimeActive || shortObserveScope
    ? normalizeSymbols(resolveTradingSymbols(cfg))
    : [];
  const recorderActive = recorderMode === "record_only"
    || (runtimeActive && recorderMode !== "off")
    || cvdMode === "record_only"
    || (runtimeActive && cvdMode !== "off")
    || marketMode === "record_only"
    || (runtimeActive && marketMode !== "off");
  const recorderSymbols = recorderActive ? getRecorderSymbols() : [];
  return {
    tradingSymbols,
    recorderSymbols,
    tickerSymbols: normalizeSymbols([...tradingSymbols, ...recorderSymbols]),
    publicTradeSymbols: tradingSymbols,
    liquidationSymbols: tradingSymbols,
    orderbookSymbols: tradingSymbols,
    tradingKlineTf: Math.max(1, Math.floor(Number(cfg.universe?.klineTfMin) || 1)),
  };
}

function buildBybitTopics(cfg: RuntimeConfig, targets: SubscriptionTargets): string[] {
  const topics: string[] = [];
  const klineTopics = new Set<string>();
  const shortObserveScope = cfg.selectedBotId === SHORT_EXHAUSTION_BOT_ID;
  const includePublicTrade = shortObserveScope
    || cvdRecorder.getStatus().mode !== "off";
  const includeLiquidations = shortObserveScope;
  const includeOrderbook = shortObserveScope;
  for (const s of targets.tickerSymbols) {
    topics.push(`tickers.${s}`);
  }
  for (const s of targets.tradingSymbols) {
    klineTopics.add(`kline.${targets.tradingKlineTf}.${s}`);
  }
  for (const s of targets.recorderSymbols) {
    klineTopics.add(`kline.1.${s}`);
  }
  topics.push(...klineTopics);
  if (includePublicTrade) {
    const symbols = shortObserveScope
      ? normalizeSymbols([
        ...targets.tradingSymbols,
        ...(cvdRecorder.getStatus().mode !== "off" ? targets.recorderSymbols : []),
      ])
      : targets.publicTradeSymbols;
    for (const s of symbols) topics.push(`publicTrade.${s}`);
  }
  if (includeLiquidations) {
    const symbols = shortObserveScope ? targets.tradingSymbols : targets.liquidationSymbols;
    for (const s of symbols) topics.push(`allLiquidation.${s}`);
  }
  if (includeOrderbook) {
    const symbols = shortObserveScope ? targets.tradingSymbols : targets.orderbookSymbols;
    for (const s of symbols) topics.push(`orderbook.50.${s}`);
  }
  return topics;
}

function parseKlineTopic(topic: string): { symbol: string; tfMin: number } | null {
  const parts = topic.split(".");
  if (parts.length < 3) return null;
  const symbol = parts[2] ?? "";
  const tfMin = Number(parts[1] ?? "");
  if (!symbol || !Number.isFinite(tfMin) || tfMin <= 0) return null;
  return { symbol, tfMin: Math.max(1, Math.floor(tfMin)) };
}


type LiveCadenceState = {
  confirmedPriceHistory: number[];
  confirmedOiHistory: number[];
  lastConfirmedAt: number | null;
  observationStep: number;
};

type ShortSignalGateState = {
  lastTriggeredCandleId: number | null;
  lastState: ShortExhaustionSignalState | null;
  lastTransitionAtMs: number;
  lastLogAtMs: number;
  lastCandidateClusterAtMs: number;
  lastCandidateScore: number | null;
  lastCandidateSignature: string | null;
  clusterStartAtMs: number;
  clusterFirstPriceMove1mPct: number | null;
  clusterMinPriceMove1mPct: number | null;
  clusterMaxPriceMove1mPct: number | null;
  clusterFirstOiAccelerationPct: number | null;
  clusterMinOiAccelerationPct: number | null;
  clusterMaxOiAccelerationPct: number | null;
  clusterMaxDerivativesScore: number;
  clusterMaxExhaustionScore: number;
  clusterMaxTotalScore: number;
  clusterMaxReversalBiasScore: number;
  clusterMaxSqueezeRiskScore: number;
  clusterSawLiquidityFloor: boolean;
  clusterSawDerivativesWeak: boolean;
};

function pctChange(now: number | null | undefined, ref: number | null | undefined): number | null {
  if (!Number.isFinite(now as number) || !Number.isFinite(ref as number) || Number(ref) === 0) return null;
  return ((Number(now) - Number(ref)) / Number(ref)) * 100;
}

function readSpreadBps(bid1: number | null, ask1: number | null, markPrice: number | null): number | null {
  if (bid1 == null || ask1 == null || markPrice == null) return null;
  if (!Number.isFinite(bid1) || !Number.isFinite(ask1) || !Number.isFinite(markPrice) || bid1 <= 0 || ask1 <= 0 || markPrice <= 0) return null;
  return ((ask1 - bid1) / markPrice) * 10_000;
}

function finiteOr<T extends number | null>(value: T | undefined, fallback: number | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function resolveComparableOpenInterest(args: {
  openInterest: number | null | undefined;
  openInterestValue: number | null | undefined;
  markPrice: number | null | undefined;
}): number | null {
  const openInterest = finiteOr(args.openInterest ?? null, null);
  if (openInterest != null && openInterest > 0) return openInterest;
  const openInterestValue = finiteOr(args.openInterestValue ?? null, null);
  const markPrice = finiteOr(args.markPrice ?? null, null);
  if (openInterestValue != null && openInterestValue > 0 && markPrice != null && markPrice > 0) {
    return openInterestValue / markPrice;
  }
  return null;
}

function getLookbackRef(history: number[], lookbackCandles: number): number | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const lookback = Math.max(1, Math.floor(Number(lookbackCandles) || 1));
  if (history.length >= lookback) {
    const value = history[history.length - lookback] ?? null;
    return Number.isFinite(value as number) ? Number(value) : null;
  }
  const fallback = history[history.length - 1] ?? null;
  return Number.isFinite(fallback as number) ? Number(fallback) : null;
}

function readJsonlTail(filePath: string, limit: number): LogEvent[] {
  const max = Math.max(1, Math.min(100, Math.floor(limit)));
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const tail = lines.slice(Math.max(0, lines.length - max));
  const out: LogEvent[] = [];

  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore
    }
  }
  return out;
}

export function createWsHub(app: FastifyInstance) {
  const clients = new Set<WebSocket>();
  const clientEventsLimit = new Map<WebSocket, number>();
  const clientRowsDetail = new Map<WebSocket, "full" | "preview">();

  const cache = new BybitMarketCache();
  const candles = new CandleTracker(cache);
  const orderbooks = new BybitOrderbookStore();
  const marketWindows = new MarketWindowStore();
  const liquidationWindows = new LiquidationWindowStore();
  const longShortRatios = new BybitLongShortRatioStore();
  const tradeWindows = new TradeActivityWindowStore();
  const liveCadenceBySymbol = new Map<string, LiveCadenceState>();
  const liveShortBarsBySymbol = new Map<string, ShortSignalMinuteBar[]>();
  const liveShortSetupSeedBySymbol = new Map<string, ShortReplaySignalRecord>();
  type AvailableWsRow = { symbol: string; markPrice: number; lastPrice: number | null; updatedAt: number };
  let shortRuntimeContextsCache: {
    cacheKey: string;
    builtAtMs: number;
    contexts: Map<string, ShortRuntimeContext>;
    rankingRows: Map<string, ShortRuntimeRankingRow>;
  } | null = null;
  const shortRuntimeContextDirtySymbols = new Set<string>();
  let baseRowsCache: {
    key: string;
    builtAtMs: number;
    rowsBySymbol: Map<string, SymbolRowBase>;
  } | null = null;
  const clientRowDirtySymbols = new Set<string>();
  let clientRowsRevision = 0;
  let clientRowsCache: {
    key: string;
    builtAtMs: number;
    rows: SymbolRow[];
    botStats: BotStats;
  } | null = null;
  let availableWsSnapshotCache: {
    revision: number;
    rows: AvailableWsRow[];
    symbols: string[];
  } | null = null;
  const shortSignalGateBySymbol = new Map<string, ShortSignalGateState>();
  let sessionConfigSnapshot: RuntimeConfig | null = null;
  const pendingTickerBySymbol = new Map<string, PendingTickerUpdate>();
  const pendingOrderbookBySymbol = new Map<string, PendingOrderbookUpdate>();
  const pendingTradesByKey = new Map<string, PendingTradeUpdate>();
  const pendingLiquidationsByKey = new Map<string, PendingLiquidationUpdate>();
  let marketProcessTimer: NodeJS.Timeout | null = null;

  function isSessionPinned(state = runtime.getStatus().sessionState) {
    return state === "RUNNING" || state === "RESUMING" || state === "PAUSED" || state === "PAUSING" || state === "STOPPING";
  }

  function getEffectiveConfig(): RuntimeConfig {
    return sessionConfigSnapshot ?? configStore.get();
  }

  function markClientRowsDirty(symbols: Iterable<string>): void {
    for (const value of symbols) {
      const symbol = String(value ?? "").trim().toUpperCase();
      if (!symbol) continue;
      clientRowDirtySymbols.add(symbol);
    }
  }

  function invalidateClientRowCaches(symbols?: Iterable<string>): void {
    clientRowsRevision += 1;
    clientRowsCache = null;
    availableWsSnapshotCache = null;
    if (symbols) {
      markClientRowsDirty(symbols);
      return;
    }
    baseRowsCache = null;
    clientRowDirtySymbols.clear();
  }

  function enqueueLiveUpdate(key: string): void {
    if (clients.size === 0) return;
    liveUpdateAggregator.upsert(key);
  }

  function notePendingOrderbookUpdate(symbol: string, type: "snapshot" | "delta", data: Record<string, unknown>): void {
    const existing = pendingOrderbookBySymbol.get(symbol) ?? {
      symbol,
      mode: type,
      bids: new Map<number, number>(),
      asks: new Map<number, number>(),
      sourceTs: null,
      seq: null,
    };
    if (type === "snapshot") {
      existing.mode = "snapshot";
      existing.bids.clear();
      existing.asks.clear();
    }
    for (const [price, size] of parseOrderbookLevels(data.b)) {
      existing.bids.set(price, size);
    }
    for (const [price, size] of parseOrderbookLevels(data.a)) {
      existing.asks.set(price, size);
    }
    const sourceTs = Number(data.cts ?? data.ts);
    existing.sourceTs = Number.isFinite(sourceTs) && sourceTs > 0 ? Math.floor(sourceTs) : existing.sourceTs;
    const seq = Number(data.seq ?? data.u);
    existing.seq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : existing.seq;
    pendingOrderbookBySymbol.set(symbol, existing);
  }

  function flushPendingMarketData(): void {
    const totalItems = pendingTickerBySymbol.size
      + pendingOrderbookBySymbol.size
      + pendingTradesByKey.size
      + pendingLiquidationsByKey.size;
    const totalMeasure = runtimeDiagnostics.start("market.flush.total");
    const now = Date.now();
    let rowsDirty = false;
    const dirtySymbols = new Set<string>();
    const tickerKeys: string[] = [];
    const orderbookKeys: string[] = [];
    const tradeKeys: string[] = [];
    const liquidationKeys: string[] = [];
    const shortCfgSelected = getEffectiveConfig().selectedBotId === SHORT_EXHAUSTION_BOT_ID;
    const tradingSymbols = new Set(resolveTradingSymbols(getEffectiveConfig()));

    try {
      const tickerMeasure = runtimeDiagnostics.start("market.flush.ticker");
      try {
        for (const pending of pendingTickerBySymbol.values()) {
          const { symbol, data, receivedAtMs } = pending;
          cache.upsertFromTicker(symbol, data);
          marketWindows.note({
            ts: Number.isFinite(Number((data as { ts?: unknown }).ts)) && Number((data as { ts?: unknown }).ts) > 0
              ? Number((data as { ts?: unknown }).ts)
              : receivedAtMs,
            symbol,
            markPrice: finiteOr(Number((data as { markPrice?: unknown }).markPrice), null),
            openInterest: resolveComparableOpenInterest({
              openInterest: finiteOr(Number((data as { openInterest?: unknown }).openInterest), null),
              openInterestValue: finiteOr(Number((data as { openInterestValue?: unknown }).openInterestValue), null),
              markPrice: finiteOr(Number((data as { markPrice?: unknown }).markPrice), null),
            }),
          });
          markShortRuntimeContextDirty(symbol);
          const row = cache.getRawRow(symbol);
          const openInterestValue = Number(row?.openInterestValue);
          const tickerTsMs = Number((data as { ts?: unknown }).ts);
          const ingest = minuteOiRecorder.ingestTicker({
            symbol,
            openInterestValue,
            tsMs: Number.isFinite(tickerTsMs) && tickerTsMs > 0 ? tickerTsMs : receivedAtMs,
          });
          if (ingest.completedMinuteTs != null) {
            const recorderSettings = readResolvedRecorderSettings();
            if (recorderSettings.mode === "record_only" && recorderSettings.historyId) {
              touchDatasetHistoryTail(recorderSettings.historyId, ingest.completedMinuteTs, now);
            }
          }
          rowsDirty = true;
          dirtySymbols.add(symbol);
          tickerKeys.push(`ticker:${symbol}`);
        }
        tickerMeasure.end({ items: pendingTickerBySymbol.size });
      } catch (error) {
        tickerMeasure.end({ items: pendingTickerBySymbol.size, failed: true });
        throw error;
      }
      pendingTickerBySymbol.clear();

      const orderbookMeasure = runtimeDiagnostics.start("market.flush.orderbook");
      try {
        for (const pending of pendingOrderbookBySymbol.values()) {
          const payload = {
            b: Array.from(pending.bids.entries()).sort((left, right) => right[0] - left[0]),
            a: Array.from(pending.asks.entries()).sort((left, right) => left[0] - right[0]),
            cts: pending.sourceTs ?? undefined,
            ts: pending.sourceTs ?? undefined,
            seq: pending.seq ?? undefined,
            u: pending.seq ?? undefined,
          };
          orderbooks.upsert(pending.symbol, pending.mode, payload);
          if (shortCfgSelected) {
            rowsDirty = true;
            dirtySymbols.add(pending.symbol);
            orderbookKeys.push(`orderbook:${pending.symbol}`);
          }
        }
        orderbookMeasure.end({ items: pendingOrderbookBySymbol.size });
      } catch (error) {
        orderbookMeasure.end({ items: pendingOrderbookBySymbol.size, failed: true });
        throw error;
      }
      pendingOrderbookBySymbol.clear();

      const tradeMeasure = runtimeDiagnostics.start("market.flush.trade");
      try {
        for (const pending of pendingTradesByKey.values()) {
          const avgPrice = pending.totalSize > 0 ? pending.totalNotional / pending.totalSize : 0;
          if (!(avgPrice > 0)) continue;
          const isTradingSymbol = tradingSymbols.has(pending.symbol);
          if (isTradingSymbol) {
            tradeWindows.note({
              ts: pending.lastTs,
              symbol: pending.symbol,
              side: pending.side,
              price: avgPrice,
              size: pending.totalSize,
              count: pending.tradesCount,
            });
            markShortRuntimeContextDirty(pending.symbol);
          }
          cvdRecorder.ingestTrade({
            symbol: pending.symbol,
            side: pending.side,
            price: avgPrice,
            size: pending.totalSize,
            ts: pending.lastTs,
            tradesCount: pending.tradesCount,
          });
          if (shortCfgSelected && isTradingSymbol) {
            rowsDirty = true;
            dirtySymbols.add(pending.symbol);
            tradeKeys.push(`trade:${pending.symbol}`);
          }
        }
        tradeMeasure.end({ items: pendingTradesByKey.size });
      } catch (error) {
        tradeMeasure.end({ items: pendingTradesByKey.size, failed: true });
        throw error;
      }
      pendingTradesByKey.clear();

      const liquidationMeasure = runtimeDiagnostics.start("market.flush.liquidation");
      try {
        for (const pending of pendingLiquidationsByKey.values()) {
          if (!(pending.lastPrice > 0) || !(pending.totalSizeUsd > 0)) continue;
          liquidationWindows.note({
            ts: pending.lastTs,
            symbol: pending.symbol,
            liquidationSide: pending.liquidationSide,
            price: pending.lastPrice,
            sizeUsd: pending.totalSizeUsd,
            count: pending.eventsCount,
          });
          rowsDirty = true;
          dirtySymbols.add(pending.symbol);
          if (shortCfgSelected) {
            liquidationKeys.push(`short-liquidation:${pending.symbol}`);
          }
        }
        liquidationMeasure.end({ items: pendingLiquidationsByKey.size });
      } catch (error) {
        liquidationMeasure.end({ items: pendingLiquidationsByKey.size, failed: true });
        throw error;
      }
      pendingLiquidationsByKey.clear();

      if (rowsDirty) {
        invalidateClientRowCaches(dirtySymbols);
        if (shortCfgSelected && rowsAllowed()) {
          // Keep live short-signal transitions/outcomes flowing even when no page
          // requests full ws rows (for example, when only /execution is open).
          computeBaseRows(now, { consumeSignals: true });
        }
      }
      for (const key of tickerKeys) enqueueLiveUpdate(key);
      for (const key of orderbookKeys) enqueueLiveUpdate(key);
      for (const key of tradeKeys) enqueueLiveUpdate(key);
      for (const key of liquidationKeys) enqueueLiveUpdate(key);
    } catch (error) {
      totalMeasure.end({ items: totalItems, failed: true });
      throw error;
    }
    totalMeasure.end({ items: totalItems });
  }

  // dynamic engines from configStore
  let lastKey = "";
  let fundingGate = new FundingCooldownGate(CONFIG.fundingCooldown.beforeMin, CONFIG.fundingCooldown.afterMin);
  let shortSignals = new ShortExhaustionSignalEngine(getBotDefinition(SHORT_EXHAUSTION_BOT_ID).defaults as ShortExhaustionBotConfig);

  function ensureEngines() {
    const cfg = getEffectiveConfig();
    const key = JSON.stringify({
      fundingCooldown: cfg.fundingCooldown,
      shortBotConfig: cfg.selectedBotId === SHORT_EXHAUSTION_BOT_ID ? cfg.botConfig : null,
      paper: { directionMode: cfg.paper.directionMode },
    });

    if (key !== lastKey) {
      lastKey = key;
      fundingGate = new FundingCooldownGate(cfg.fundingCooldown.beforeMin, cfg.fundingCooldown.afterMin);
      if (cfg.selectedBotId === SHORT_EXHAUSTION_BOT_ID) {
        shortSignals.applyConfig(readShortExhaustionConfig(cfg));
      }
      app.log.info(
        { cfg: { fundingCooldown: cfg.fundingCooldown, shortBotConfig: cfg.botConfig, paper: { directionMode: cfg.paper.directionMode } } },
        "runtime config applied (wsHub)"
      );
    }
  }

  runtime.attachMarkPriceProvider((symbol) => cache.getMarkPrice(symbol));

  let wss: WebSocketServer | null = null;
  const liveUpdateAggregator = new LiveUpdateAggregator({
    flushIntervalMs: LIVE_UPDATE_FLUSH_INTERVAL_MS,
    maxKeys: 5_000,
    onFlush: () => {
      if (clients.size === 0) return;
      const now = nowMs();
      const { rows: availableWsRows, symbols: availableWsSymbols } = buildAvailableWsSnapshot();
      for (const c of clients) {
        const detail = clientRowsDetail.get(c) ?? "preview";
        const rows = computeRowsForClient(now, detail);
        if (!rows.length && !(streamsEnabled || bybitConnected || rowsAllowed())) continue;
        const botStats = clientRowsCache?.rows === rows ? clientRowsCache.botStats : computeBotStats(rows);
        const msg: ServerWsMessage = { type: "tick", payload: { serverTime: now, rows, botStats, ...getUniverseInfo(getEffectiveConfig()), availableWsSymbols, availableWsRows } };
        safeSend(c, msg);
      }
    },
    onDropKey: (key, size) => {
      app.log.warn({ key, size }, "live update aggregator capacity reached; dropping new keys");
    },
  });

  // Bybit upstream
  let streamsEnabled = runtime.getStatus().sessionState === "RUNNING";
  let desiredStreams = streamsEnabled;
  let bybitConnected = false;

  let bybitShards = new Map<string, BybitWsShardState>();
  let connectInFlight = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const shardReconnectTimers = new Map<string, NodeJS.Timeout>();
  const shardReconnectAttempts = new Map<string, number>();
  let streamGuardTimer: NodeJS.Timeout | null = null;
  let lastStreamGuardTickAt = Date.now();
  let lastEventLoopLagMs = 0;
  let lastLagGraceIncidentAt = 0;
  let reconnectAttempt = 0;
  let reconnectReason = "startup";
  const streamWaiters = new Set<{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();

  function resolveStreamWaitersIfReady() {
    if (!(streamsEnabled && bybitConnected)) return;
    for (const waiter of streamWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    streamWaiters.clear();
  }

  function rejectStreamWaiters(message: string) {
    for (const waiter of streamWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    streamWaiters.clear();
  }

  function recomputeBybitConnectedState() {
    bybitConnected = bybitShards.size > 0 && Array.from(bybitShards.values()).every((shard) => shard.connected);
  }

  function noteBybitShardMessage(shardKey: string) {
    const shard = bybitShards.get(shardKey);
    if (!shard) return;
    shard.lastMessageAtMs = Date.now();
  }

  function closeBybitShards(hard = false) {
    flushPendingMarketData();
    for (const shard of bybitShards.values()) {
      try {
        if (hard) shard.client.hardClose();
        else shard.client.close();
      } catch {
        // ignore
      }
    }
    bybitShards.clear();
    bybitConnected = false;
  }

  function closeBybitShard(shardKey: string, hard = false) {
    flushPendingMarketData();
    const shard = bybitShards.get(shardKey);
    if (!shard) return;
    try {
      if (hard) shard.client.hardClose();
      else shard.client.close();
    } catch {
      // ignore
    }
    bybitShards.delete(shardKey);
    recomputeBybitConnectedState();
  }

  function computeReconnectDelayMs(attempt: number): number {
    if (attempt <= 1) return BYBIT_WS_RECONNECT_DELAYS_MS[0];
    if (attempt === 2) return BYBIT_WS_RECONNECT_DELAYS_MS[1];
    if (attempt === 3) return BYBIT_WS_RECONNECT_DELAYS_MS[2];
    if (attempt === 4) return BYBIT_WS_RECONNECT_DELAYS_MS[3];
    return BYBIT_WS_RECONNECT_DELAYS_MS[4];
  }

  function buildBybitTopicShards(cfg: RuntimeConfig, runtimeActive: boolean, recorderMode: "off" | "record_only" | "record_while_running", cvdMode: "off" | "record_only" | "record_while_running", marketMode: "off" | "record_only" | "record_while_running") {
    const targets = resolveSubscriptionTargets(cfg, runtimeActive, recorderMode, cvdMode, marketMode);
    const topics = buildBybitTopics(cfg, targets);
    const shards = chunkTopicsByCharLimit(topics).map((shardTopics, index) => ({
      key: `linear-${index + 1}`,
      topics: shardTopics,
      chars: sumTopicChars(shardTopics),
    }));
    return { targets, topics, shards };
  }

  function getStaleShard(nowMsValue: number, staleThresholdMs: number): BybitWsShardState | null {
    for (const shard of bybitShards.values()) {
      if (!shard.connected || shard.lastMessageAtMs == null) continue;
      if (nowMsValue - shard.lastMessageAtMs > staleThresholdMs) {
        return shard;
      }
    }
    return null;
  }

  // Universe tracking (auto-apply via reconnect when changed)
  let lastUniverseKey = buildSymbolScopeKey(getEffectiveConfig());
  let lastSubscriptionKey = "";
  let universeApplyTimer: NodeJS.Timeout | null = null;
  let longShortRatioTimer: NodeJS.Timeout | null = null;
  let lastShortSignalSessionId: string | null = runtime.getStatus().sessionId;

  function computeSubscriptionKey(
    runtimeActive: boolean,
    recorderMode: "off" | "record_only" | "record_while_running",
    cvdMode: "off" | "record_only" | "record_while_running",
    marketMode: "off" | "record_only" | "record_while_running",
  ): string {
    const cfg = getEffectiveConfig();
    const targets = resolveSubscriptionTargets(cfg, runtimeActive, recorderMode, cvdMode, marketMode);
    return JSON.stringify({
      tradingTf: targets.tradingKlineTf,
      tradingSymbols: targets.tradingSymbols,
      recorderSymbols: targets.recorderSymbols,
      tickerSymbols: targets.tickerSymbols,
      publicTradeSymbols: targets.publicTradeSymbols,
      liquidationSymbols: targets.liquidationSymbols,
      orderbookSymbols: targets.orderbookSymbols,
      botId: cfg.selectedBotId,
      minuteMode: recorderMode,
      cvdMode,
      marketMode,
      wsProbeEnabled: wsProbeBotIds.size > 0,
    });
  }

  function shouldKeepStreamsAlive(
    runtimeActive: boolean,
    recorderMode: "off" | "record_only" | "record_while_running",
    cvdMode: "off" | "record_only" | "record_while_running",
    marketMode: "off" | "record_only" | "record_while_running",
  ): boolean {
    return runtimeActive
      || recorderMode === "record_only"
      || cvdMode === "record_only"
      || marketMode === "record_only";
  }

  function readCurrentStreamRequirement() {
    const st = runtime.getStatus();
    const runtimeActive = st.sessionState === "RUNNING" || st.sessionState === "RESUMING";
    const recorderMode = minuteOiRecorder.getStatus().mode;
    const cvdMode = cvdRecorder.getStatus().mode;
    const marketMode = minuteMarketRecorder.getStatus().mode;
    return {
      runtimeActive,
      recorderMode,
      cvdMode,
      marketMode,
      shouldEnableStreams: shouldKeepStreamsAlive(runtimeActive, recorderMode, cvdMode, marketMode),
    };
  }

  function broadcastStreamsState() {
    wsProbeState.streamsEnabled = streamsEnabled;
    wsProbeState.bybitConnected = bybitConnected;
    setMarketStreamsRuntimeStatus({ streamsEnabled, bybitConnected });
    const msg: ServerWsMessage = { type: "streams_state", payload: { streamsEnabled, bybitConnected } };
    for (const c of clients) safeSend(c, msg);
  }

  function rowsAllowed() {
    const st = runtime.getStatus();
    return st.sessionState === "RUNNING";
  }

  function readShortSignalGate(symbol: string): ShortSignalGateState {
    const current = shortSignalGateBySymbol.get(symbol);
    if (current) return current;
    const next: ShortSignalGateState = {
      lastTriggeredCandleId: null,
      lastState: null,
      lastTransitionAtMs: 0,
      lastLogAtMs: 0,
      lastCandidateClusterAtMs: 0,
      lastCandidateScore: null,
      lastCandidateSignature: null,
      clusterStartAtMs: 0,
      clusterFirstPriceMove1mPct: null,
      clusterMinPriceMove1mPct: null,
      clusterMaxPriceMove1mPct: null,
      clusterFirstOiAccelerationPct: null,
      clusterMinOiAccelerationPct: null,
      clusterMaxOiAccelerationPct: null,
      clusterMaxDerivativesScore: 0,
      clusterMaxExhaustionScore: 0,
      clusterMaxTotalScore: 0,
      clusterMaxReversalBiasScore: 0,
      clusterMaxSqueezeRiskScore: 0,
      clusterSawLiquidityFloor: false,
      clusterSawDerivativesWeak: false,
    };
    shortSignalGateBySymbol.set(symbol, next);
    return next;
  }

  function buildShortCandidateSignature(snapshot: ReturnType<ShortExhaustionSignalEngine["evaluate"]>): string {
    const reasons = [...snapshot.reasons].sort().join("|");
    const suppressions = [...snapshot.suppressionReasons].sort().join("|");
    return `${snapshot.summaryReason}::${reasons}::${suppressions}`;
  }

  function shouldSuppressRepeatedCandidateCluster(snapshot: ReturnType<ShortExhaustionSignalEngine["evaluate"]>, gate: ShortSignalGateState): boolean {
    if (snapshot.state !== "CANDIDATE") return false;
    if (!(gate.lastCandidateClusterAtMs > 0) || !gate.lastCandidateSignature) return false;
    const elapsedMs = snapshot.ts - gate.lastCandidateClusterAtMs;
    if (elapsedMs > SHORT_CANDIDATE_CLUSTER_WINDOW_MS) return false;
    const signature = buildShortCandidateSignature(snapshot);
    const scoreDelta = Number(snapshot.totalScore) - Number(gate.lastCandidateScore ?? 0);
    return signature === gate.lastCandidateSignature && scoreDelta < SHORT_CANDIDATE_REPEAT_MIN_SCORE_DELTA;
  }

  function resetShortCandidateCluster(gate: ShortSignalGateState) {
    gate.clusterStartAtMs = 0;
    gate.clusterFirstPriceMove1mPct = null;
    gate.clusterMinPriceMove1mPct = null;
    gate.clusterMaxPriceMove1mPct = null;
    gate.clusterFirstOiAccelerationPct = null;
    gate.clusterMinOiAccelerationPct = null;
    gate.clusterMaxOiAccelerationPct = null;
    gate.clusterMaxDerivativesScore = 0;
    gate.clusterMaxExhaustionScore = 0;
    gate.clusterMaxTotalScore = 0;
    gate.clusterMaxReversalBiasScore = 0;
    gate.clusterMaxSqueezeRiskScore = 0;
    gate.clusterSawLiquidityFloor = false;
    gate.clusterSawDerivativesWeak = false;
  }

  function readSnapshotMetricNumber(snapshot: ReturnType<ShortExhaustionSignalEngine["evaluate"]>, key: string): number | null {
    const value = snapshot.metrics?.[key];
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function refreshShortCandidateCluster(snapshot: ReturnType<ShortExhaustionSignalEngine["evaluate"]>, gate: ShortSignalGateState) {
    const active = snapshot.state === "CANDIDATE" || snapshot.state === "WATCHLIST" || snapshot.state === "CONFIRMED" || snapshot.state === "SOFT_FINAL" || snapshot.state === "FINAL";
    if (!active) {
      if (gate.clusterStartAtMs > 0) resetShortCandidateCluster(gate);
      return;
    }

    const startNewCluster =
      gate.clusterStartAtMs <= 0
      || !isShortActiveState(gate.lastState)
      || snapshot.ts - gate.clusterStartAtMs > SHORT_CANDIDATE_CLUSTER_WINDOW_MS;

    const priceMove1mPct = readSnapshotMetricNumber(snapshot, "priceMove1mPct");
    const oiAccelerationPct = readSnapshotMetricNumber(snapshot, "oiAccelerationPct");

    if (startNewCluster) {
      gate.clusterStartAtMs = snapshot.ts;
      gate.clusterFirstPriceMove1mPct = priceMove1mPct;
      gate.clusterMinPriceMove1mPct = priceMove1mPct;
      gate.clusterMaxPriceMove1mPct = priceMove1mPct;
      gate.clusterFirstOiAccelerationPct = oiAccelerationPct;
      gate.clusterMinOiAccelerationPct = oiAccelerationPct;
      gate.clusterMaxOiAccelerationPct = oiAccelerationPct;
      gate.clusterMaxDerivativesScore = snapshot.derivativesScore;
      gate.clusterMaxExhaustionScore = snapshot.exhaustionScore;
      gate.clusterMaxTotalScore = snapshot.totalScore;
      gate.clusterMaxReversalBiasScore = snapshot.reversalBiasScore;
      gate.clusterMaxSqueezeRiskScore = snapshot.squeezeRiskScore;
      gate.clusterSawLiquidityFloor = snapshot.reasons.includes("candidate:liquidity_floor");
      gate.clusterSawDerivativesWeak =
        snapshot.summaryReason === "derivatives_oi_1m_weak"
        || snapshot.suppressionReasons.some((value) => String(value ?? "").startsWith("derivatives_oi_"));
      return;
    }

    if (priceMove1mPct != null) {
      gate.clusterMinPriceMove1mPct = gate.clusterMinPriceMove1mPct == null ? priceMove1mPct : Math.min(gate.clusterMinPriceMove1mPct, priceMove1mPct);
      gate.clusterMaxPriceMove1mPct = gate.clusterMaxPriceMove1mPct == null ? priceMove1mPct : Math.max(gate.clusterMaxPriceMove1mPct, priceMove1mPct);
    }
    if (oiAccelerationPct != null) {
      gate.clusterMinOiAccelerationPct = gate.clusterMinOiAccelerationPct == null ? oiAccelerationPct : Math.min(gate.clusterMinOiAccelerationPct, oiAccelerationPct);
      gate.clusterMaxOiAccelerationPct = gate.clusterMaxOiAccelerationPct == null ? oiAccelerationPct : Math.max(gate.clusterMaxOiAccelerationPct, oiAccelerationPct);
    }
    gate.clusterMaxDerivativesScore = Math.max(gate.clusterMaxDerivativesScore, snapshot.derivativesScore);
    gate.clusterMaxExhaustionScore = Math.max(gate.clusterMaxExhaustionScore, snapshot.exhaustionScore);
    gate.clusterMaxTotalScore = Math.max(gate.clusterMaxTotalScore, snapshot.totalScore);
    gate.clusterMaxReversalBiasScore = Math.max(gate.clusterMaxReversalBiasScore, snapshot.reversalBiasScore);
    gate.clusterMaxSqueezeRiskScore = Math.max(gate.clusterMaxSqueezeRiskScore, snapshot.squeezeRiskScore);
    gate.clusterSawLiquidityFloor ||= snapshot.reasons.includes("candidate:liquidity_floor");
    gate.clusterSawDerivativesWeak ||= snapshot.summaryReason === "derivatives_oi_1m_weak"
      || snapshot.suppressionReasons.some((value) => String(value ?? "").startsWith("derivatives_oi_"));
  }

  function applyLiveShortAdvisoryClassifier(
    snapshot: ReturnType<ShortExhaustionSignalEngine["evaluate"]>,
    gate: ShortSignalGateState,
  ): ReturnType<ShortExhaustionSignalEngine["evaluate"]> {
    refreshShortCandidateCluster(snapshot, gate);
    if (snapshot.state !== "CANDIDATE" || gate.clusterStartAtMs <= 0) return snapshot;

    const clusterAgeSec = Math.max(0, Math.floor((snapshot.ts - gate.clusterStartAtMs) / 1000));
    const firstPriceMove1mPct = gate.clusterFirstPriceMove1mPct;
    const minPriceMove1mPct = gate.clusterMinPriceMove1mPct;
    const firstOiAccelerationPct = gate.clusterFirstOiAccelerationPct;
    const minOiAccelerationPct = gate.clusterMinOiAccelerationPct;
    const askToBidDepthRatio = readSnapshotMetricNumber(snapshot, "askToBidDepthRatio");
    const orderbookImbalanceRatio = readSnapshotMetricNumber(snapshot, "orderbookImbalanceRatio");
    const longShortRatio = readSnapshotMetricNumber(snapshot, "longShortRatio");

    const priceFade =
      firstPriceMove1mPct != null
      && minPriceMove1mPct != null
      && minPriceMove1mPct <= Math.max(0.15, firstPriceMove1mPct * 0.72);
    const oiAccelCooling =
      firstOiAccelerationPct != null
      && minOiAccelerationPct != null
      && minOiAccelerationPct <= firstOiAccelerationPct * 0.7;
    const continuationPressure =
      (gate.clusterMaxPriceMove1mPct ?? 0) >= Math.max(1.35, Number(firstPriceMove1mPct ?? 0) + 0.35)
      || (gate.clusterMaxOiAccelerationPct ?? 0) >= Math.max(0.1, Number(firstOiAccelerationPct ?? 0) + 0.05)
      || snapshot.biasLabel === "SQUEEZE_RISK"
      || gate.clusterMaxSqueezeRiskScore >= gate.clusterMaxReversalBiasScore + 0.2;
    const reversalWindowForming =
      clusterAgeSec >= 60
      && (priceFade || oiAccelCooling || gate.clusterMaxExhaustionScore >= 0.18)
      && (askToBidDepthRatio == null || askToBidDepthRatio >= 0.9)
      && (orderbookImbalanceRatio == null || orderbookImbalanceRatio <= 0.2);

    let advisoryVerdict = snapshot.advisoryVerdict;
    let advisoryReason = snapshot.advisoryReason;

    if (continuationPressure) {
      advisoryVerdict = "NO_TRADE";
      advisoryReason = "candidate_continuation_risk";
    } else if (gate.clusterSawLiquidityFloor && reversalWindowForming && gate.clusterMaxDerivativesScore >= 0.2 && (longShortRatio == null || longShortRatio >= 1.15)) {
      advisoryVerdict = "OBSERVE_ONLY";
      advisoryReason = "reversal_window_forming";
    } else if (gate.clusterSawDerivativesWeak && !reversalWindowForming) {
      advisoryVerdict = "NO_TRADE";
      advisoryReason = "weak_derivatives_no_reversal_window";
    } else if (snapshot.totalScore < 1.35) {
      advisoryVerdict = "NO_TRADE";
      advisoryReason = "candidate_score_too_low";
    }

    return {
      ...snapshot,
      advisoryVerdict,
      advisoryReason,
      metrics: {
        ...snapshot.metrics,
        advisoryVerdict,
        advisoryReason,
        candidateClusterAgeSec: clusterAgeSec,
        candidatePriceFade: priceFade,
        candidateOiAccelCooling: oiAccelCooling,
        candidateContinuationPressure: continuationPressure,
        candidateReversalWindowForming: reversalWindowForming,
      },
    };
  }

  function isShortActiveState(state: ShortExhaustionSignalState | null | undefined): boolean {
    return state === "CANDIDATE" || state === "WATCHLIST" || state === "CONFIRMED" || state === "SOFT_FINAL" || state === "FINAL";
  }

  function shouldLogShortTransition(state: ShortExhaustionSignalState, cfg: ShortExhaustionBotConfig): boolean {
    if (state === "CANDIDATE") return cfg.observe.logCandidateTransitions;
    if (state === "WATCHLIST" || state === "CONFIRMED" || state === "SUPPRESSED") return cfg.observe.logWatchlistTransitions;
    if (state === "SOFT_FINAL") return cfg.observe.logFinalSignals;
    if (state === "FINAL") return cfg.observe.logFinalSignals;
    if (state === "REJECTED" || state === "EXPIRED") return true;
    return false;
  }

  function maybeLogShortSnapshot(snapshot: ReturnType<ShortExhaustionSignalEngine["evaluate"]>, gate: ShortSignalGateState, emittedSignal: boolean) {
    const cfg = getEffectiveConfig();
    if (cfg.selectedBotId !== SHORT_EXHAUSTION_BOT_ID) return;
    const shortCfg = readShortExhaustionConfig(cfg);
    const minLogIntervalMs = Math.max(1_000, shortCfg.observe.minLogIntervalSec * 1000);
    const now = snapshot.ts;
    const prevState = gate.lastState;
    const stateChanged = snapshot.state !== prevState;
    const canLogState = now - gate.lastLogAtMs >= minLogIntervalMs;
    const transitionState = snapshot.state === "IDLE" && isShortActiveState(prevState) ? "EXPIRED" : snapshot.state;
    const suppressRepeatedCandidate = shouldSuppressRepeatedCandidateCluster(snapshot, gate);
    const priceContext = buildShortSignalReferenceMarket({
      marketRow: cache.getRawRow(snapshot.symbol),
      orderbook: orderbooks.getSummary(snapshot.symbol),
      capturedAtMs: Date.now(),
    });
    const runtimeStatus = runtime.getStatus();

    if (transitionState === "CANDIDATE" && !suppressRepeatedCandidate) {
      gate.lastCandidateClusterAtMs = now;
      gate.lastCandidateScore = snapshot.totalScore;
      gate.lastCandidateSignature = buildShortCandidateSignature(snapshot);
    }

    if (stateChanged && canLogState && !suppressRepeatedCandidate && shouldLogShortTransition(transitionState, shortCfg)) {
      const transitionEvent: LogEvent = {
        ts: now,
        type: "SHORT_SIGNAL_TRANSITION",
        symbol: snapshot.symbol,
        payload: {
          prevState,
          nextState: transitionState,
          transitionReason: snapshot.summaryReason,
          snapshot,
          ...(priceContext ? { priceContext } : {}),
        },
      };
      runtime.logEvent(transitionEvent);
      shortResearchRecorder.noteTransition(transitionEvent);
      gate.lastLogAtMs = now;
      gate.lastTransitionAtMs = now;
    }
    gate.lastState = snapshot.state;

    if (emittedSignal && shortCfg.observe.logFinalSignals) {
      const triggerEvent: LogEvent = {
        ts: now,
        type: "SHORT_SIGNAL_TRIGGER",
        symbol: snapshot.symbol,
        payload: {
          snapshot,
          ...(priceContext ? { priceContext } : {}),
        },
      };
      runtime.logEvent(triggerEvent);
      shortResearchRecorder.noteTransition(triggerEvent);
      gate.lastLogAtMs = now;
      gate.lastTransitionAtMs = now;
      gate.lastState = snapshot.state;
    }
  }

  function evaluateShortSignalBundle(args: {
    symbol: string;
    now: number;
    symbols: string[];
    shortCfg: ShortExhaustionBotConfig;
    contexts: Map<string, ShortRuntimeContext> | null;
  }) {
    const measure = runtimeDiagnostics.start("short.signal.evaluate_bundle");
    try {
      const context = args.contexts?.get(args.symbol) ?? createEmptyShortRuntimeContext(args.symbols.length);
      const liquidationSnapshot = liquidationWindows.getSnapshot(args.symbol, args.now);
      const orderbookSnapshot = orderbooks.getSummary(args.symbol);
      const longShortRatioSnapshot = longShortRatios.getSnapshot(args.symbol);
      const marketRow = cache.getRawRow(args.symbol);
      const cvdFeatures = cvdRecorder.getSignalFeatures(args.symbol);
      const snapshot = shortSignals.evaluate(buildShortSignalInput({
        now: args.now,
        symbol: args.symbol,
        marketRow,
        context,
        cvd: {
          cvdDelta: cvdFeatures.cvdDelta,
          cvdImbalanceRatio: cvdFeatures.cvdImbalanceRatio,
          divergencePriceUpCvdDown: cvdFeatures.divergencePriceUpCvdDown,
          divergencePriceDownCvdUp: cvdFeatures.divergencePriceDownCvdUp,
        },
        liquidation: liquidationSnapshot,
        orderbook: orderbookSnapshot,
        longShortRatio: longShortRatioSnapshot,
      }));
      const referenceMarket = buildShortSignalReferenceMarket({
        marketRow,
        orderbook: orderbookSnapshot,
        capturedAtMs: args.now,
      });
      measure.end({ items: 1 });
      return {
        context,
        snapshot,
        referenceMarket,
        liquidationSnapshot,
        orderbookSnapshot,
        longShortRatioSnapshot,
        cvdFeatures,
        marketRow,
      };
    } catch (error) {
      measure.end({ items: 1, failed: true });
      throw error;
    }
  }

  function maybeRecordShortResearchMinute(args: {
    symbol: string;
    minuteStartMs: number;
    evaluationTs: number;
    symbols: string[];
    shortCfg: ShortExhaustionBotConfig;
    contexts: Map<string, ShortRuntimeContext> | null;
    kline: Record<string, unknown> | null;
  }) {
    const bundle = evaluateShortSignalBundle({
      symbol: args.symbol,
      now: args.evaluationTs,
      symbols: args.symbols,
      shortCfg: args.shortCfg,
      contexts: args.contexts,
    });
    const market = bundle.marketRow;
    shortResearchRecorder.noteMinuteEvaluation({
      source: "live",
      symbol: args.symbol,
      minuteStartMs: args.minuteStartMs,
      minuteCloseTs: args.minuteStartMs + 60_000,
      evaluationTs: args.evaluationTs,
      universeSelectedId: String(getEffectiveConfig().universe?.selectedId ?? "") || null,
      universeSize: args.symbols.length,
      signalVersion: bundle.snapshot.signalVersion,
      featureSchemaVersion: bundle.snapshot.featureSchemaVersion,
      context: bundle.context,
      market: {
        markPrice: finiteOr(market?.markPrice, null),
        lastPrice: finiteOr(market?.lastPrice, null),
        bid1: finiteOr(market?.bid1, null),
        ask1: finiteOr(market?.ask1, null),
        midPrice: bundle.referenceMarket?.midPrice ?? null,
        spreadBps: readSpreadBps(
          finiteOr(market?.bid1, null),
          finiteOr(market?.ask1, null),
          finiteOr(market?.markPrice, null),
        ),
        turnover24hUsd: finiteOr(market?.turnover24hUsd, null),
        openInterestValue: finiteOr(market?.openInterestValue, null),
        fundingRate: finiteOr(market?.fundingRate, null),
        highPrice24h: finiteOr(market?.highPrice24h, null),
        lowPrice24h: finiteOr(market?.lowPrice24h, null),
        updatedAt: finiteOr(market?.updatedAt, null),
      },
      bar: args.kline ? {
        startMs: args.minuteStartMs,
        endMs: args.minuteStartMs + 60_000,
        open: finiteOr(Number(args.kline.open ?? args.kline.o), null),
        high: finiteOr(Number(args.kline.high ?? args.kline.h), null),
        low: finiteOr(Number(args.kline.low ?? args.kline.l), null),
        close: finiteOr(Number(args.kline.close ?? args.kline.c), null),
        volume: finiteOr(Number(args.kline.volume ?? args.kline.vol), null),
        turnover: finiteOr(Number(args.kline.turnover), null),
      } : null,
      referenceMarket: bundle.referenceMarket,
      cvd: {
        cvdDelta: bundle.cvdFeatures.cvdDelta,
        cvdImbalanceRatio: bundle.cvdFeatures.cvdImbalanceRatio,
        divergencePriceUpCvdDown: bundle.cvdFeatures.divergencePriceUpCvdDown,
        divergencePriceDownCvdUp: bundle.cvdFeatures.divergencePriceDownCvdUp,
      },
      liquidation: bundle.liquidationSnapshot,
      orderbook: bundle.orderbookSnapshot,
      longShortRatio: bundle.longShortRatioSnapshot,
      snapshot: bundle.snapshot,
    });
  }

  function buildShortRuntimeContextsCacheKey(symbols: string[], shortCfg: ShortExhaustionBotConfig): string {
    return `${symbols.join(",")}::${JSON.stringify(shortCfg)}`;
  }

  function clearShortRuntimeContextsCache(): void {
    shortRuntimeContextsCache = null;
    shortRuntimeContextDirtySymbols.clear();
  }

  function markShortRuntimeContextDirty(symbolRaw: string): void {
    const symbol = String(symbolRaw ?? "").trim().toUpperCase();
    if (!symbol) return;
    shortRuntimeContextDirtySymbols.add(symbol);
  }

  function getShortRuntimeContextsCached(args: {
    symbols: string[];
    now: number;
    shortCfg: ShortExhaustionBotConfig;
  }): Map<string, ShortRuntimeContext> {
    const buildEntry = (symbol: string) => buildShortRuntimeContextEntry({
      symbol,
      universeSize: args.symbols.length,
      now: args.now,
      shortCfg: args.shortCfg,
      getMarketRow: (value) => cache.getRawRow(value),
      getCadence: (value) => liveCadenceBySymbol.get(value),
      getOiSeed: (value) => shortBybitOiSeedStore.read(value),
      getMarketSnapshot: (value, currentNow) => marketWindows.getSnapshot(value, currentNow),
      getTradeSnapshot: (value, currentNow) => tradeWindows.getSnapshot(value, currentNow),
    });
    const cacheKey = buildShortRuntimeContextsCacheKey(args.symbols, args.shortCfg);
    const cacheFresh = (
      shortRuntimeContextsCache
      && shortRuntimeContextsCache.cacheKey === cacheKey
      && args.now - shortRuntimeContextsCache.builtAtMs <= SHORT_RUNTIME_CONTEXT_CACHE_MS
    );
    if (cacheFresh && shortRuntimeContextDirtySymbols.size === 0) {
      return shortRuntimeContextsCache!.contexts;
    }

    if (!cacheFresh) {
      const rebuildMeasure = runtimeDiagnostics.start("short.runtime_contexts.rebuild");
      try {
        const contexts = new Map<string, ShortRuntimeContext>();
        const rankingRows = new Map<string, ShortRuntimeRankingRow>();
        for (const symbol of args.symbols) {
          const entry = buildEntry(symbol);
          contexts.set(symbol, entry.context);
          rankingRows.set(symbol, entry.rankingRow);
        }
        applyShortRuntimeUniverseRanks(contexts, rankingRows.values());
        shortRuntimeContextsCache = {
          cacheKey,
          builtAtMs: args.now,
          contexts,
          rankingRows,
        };
        shortRuntimeContextDirtySymbols.clear();
        rebuildMeasure.end({ items: args.symbols.length });
        return shortRuntimeContextsCache.contexts;
      } catch (error) {
        rebuildMeasure.end({ items: args.symbols.length, failed: true });
        throw error;
      }
    }

    const dirtySymbols = args.symbols.filter((symbol) => (
      shortRuntimeContextDirtySymbols.has(symbol)
      || !shortRuntimeContextsCache!.contexts.has(symbol)
      || !shortRuntimeContextsCache!.rankingRows.has(symbol)
    ));
    if (dirtySymbols.length === 0) {
      return shortRuntimeContextsCache!.contexts;
    }

    const refreshMeasure = runtimeDiagnostics.start("short.runtime_contexts.refresh_dirty");
    try {
      for (const symbol of dirtySymbols) {
        const entry = buildEntry(symbol);
        shortRuntimeContextsCache!.contexts.set(symbol, entry.context);
        shortRuntimeContextsCache!.rankingRows.set(symbol, entry.rankingRow);
        shortRuntimeContextDirtySymbols.delete(symbol);
      }

      shortRuntimeContextsCache!.builtAtMs = args.now;
      applyShortRuntimeUniverseRanks(shortRuntimeContextsCache!.contexts, shortRuntimeContextsCache!.rankingRows.values());
      refreshMeasure.end({ items: dirtySymbols.length });
      return shortRuntimeContextsCache!.contexts;
    } catch (error) {
      refreshMeasure.end({ items: dirtySymbols.length, failed: true });
      throw error;
    }
  }

  function noteLiveShortBar(symbol: string, kline: Record<string, unknown>, market: ReturnType<typeof cache.getRawRow> | null) {
    const startMs = Math.floor(Number(kline.start ?? kline.startTime ?? Date.now()) / 60_000) * 60_000;
    const open = finiteOr(Number(kline.open ?? kline.o), null);
    const high = finiteOr(Number(kline.high ?? kline.h), null);
    const low = finiteOr(Number(kline.low ?? kline.l), null);
    const close = finiteOr(Number(kline.close ?? kline.c), null);
    if (open == null || high == null || low == null || close == null) return;
    const nextBar: ShortSignalMinuteBar = {
      symbol,
      startMs,
      endMs: startMs + 60_000,
      open,
      high,
      low,
      close,
      volume: finiteOr(Number(kline.volume ?? kline.v), null),
      turnover: finiteOr(Number(kline.turnover ?? kline.q), null),
      markPrice: finiteOr(market?.markPrice, null),
      lastPrice: finiteOr(market?.lastPrice, null),
      bid1: finiteOr(market?.bid1, null),
      ask1: finiteOr(market?.ask1, null),
      source: "recorder",
      loadedAtMs: Date.now(),
    };
    const current = liveShortBarsBySymbol.get(symbol) ?? [];
    const deduped = current.filter((bar) => bar.startMs !== nextBar.startMs);
    deduped.push(nextBar);
    deduped.sort((left, right) => left.startMs - right.startMs);
    if (deduped.length > 32) deduped.splice(0, deduped.length - 32);
    liveShortBarsBySymbol.set(symbol, deduped);
  }

  function buildLiveShortSetupPreview(args: {
    symbol: string;
    snapshot: ReturnType<ShortExhaustionSignalEngine["evaluate"]>;
    shortCfg: ShortExhaustionBotConfig;
    referenceMarket: ShortSignalReferenceMarketSnapshot | null;
  }): {
    setup: ShortLiveSetupRecord | null;
    lastRevision: ShortReplaySetupRevisionRecord | null;
  } {
    type LiveSetupSignalState = Extract<ShortExhaustionSignalState, "CANDIDATE" | "CONFIRMED" | "SOFT_FINAL" | "FINAL" | "SUPPRESSED">;
    const candidateTradeable = args.snapshot.state === "CANDIDATE" && args.snapshot.advisoryVerdict === "TRADEABLE";
    if (!candidateTradeable && args.snapshot.state !== "CONFIRMED" && args.snapshot.state !== "SOFT_FINAL" && args.snapshot.state !== "FINAL" && args.snapshot.state !== "SUPPRESSED") {
      liveShortSetupSeedBySymbol.delete(args.symbol);
      shortLiveSetupStore.reconcileExpiry(Number(args.snapshot.ts));
      return { setup: null, lastRevision: null };
    }
    const nextSignalFromSnapshot = (
      signalTs: number,
      terminalState: ShortReplaySignalRecord["terminalState"],
      overrides?: Partial<Pick<ShortReplaySignalRecord, "finalTriggerEmitted" | "summaryReason" | "reasonsSummary">>,
    ): ShortReplaySignalRecord => ({
      id: `live:${args.symbol}:${signalTs}`,
      runId: "live",
      symbol: args.symbol,
      signalTs,
      startedAtTs: signalTs,
      terminalTs: Number(args.snapshot.ts),
      firstState: terminalState,
      terminalState,
      transitionCount: 0,
      transitionIds: [],
      totalScore: Number(args.snapshot.totalScore ?? 0),
      reasonsSummary: String(overrides?.reasonsSummary ?? args.snapshot.summaryReason ?? ""),
      summaryReason: String(overrides?.summaryReason ?? args.snapshot.summaryReason ?? ""),
      signalVersion: String(args.snapshot.signalVersion ?? ""),
      featureSchemaVersion: String(args.snapshot.featureSchemaVersion ?? ""),
      compactSnapshot: {
        ts: Number(args.snapshot.ts),
        symbol: args.symbol,
        stage: args.snapshot.stage,
        state: args.snapshot.state,
        candidateScore: Number(args.snapshot.candidateScore ?? 0),
        derivativesScore: Number(args.snapshot.derivativesScore ?? 0),
        exhaustionScore: Number(args.snapshot.exhaustionScore ?? 0),
        microstructureScore: Number(args.snapshot.microstructureScore ?? 0),
        totalScore: Number(args.snapshot.totalScore ?? 0),
        reasons: [...(args.snapshot.reasons ?? [])],
        hardRejectReasons: [...(args.snapshot.hardRejectReasons ?? [])],
        suppressionReasons: [...(args.snapshot.suppressionReasons ?? [])],
        summaryReason: String(args.snapshot.summaryReason ?? ""),
        signalVersion: String(args.snapshot.signalVersion ?? ""),
        featureSchemaVersion: String(args.snapshot.featureSchemaVersion ?? ""),
        metrics: { ...(args.snapshot.metrics ?? {}) },
      },
      previousActiveSignalId: null,
      overlapGroupId: `live:${args.symbol}`,
      isOverlapping: false,
      finalTriggerEmitted: overrides?.finalTriggerEmitted ?? Boolean(args.snapshot.isFinalShortSignal),
      outcomeId: null,
      createdAtMs: signalTs,
    });
    const existingSeed = liveShortSetupSeedBySymbol.get(args.symbol) ?? null;
    const shouldResetSeed = existingSeed == null
      || (existingSeed.terminalState === "CANDIDATE" && args.snapshot.state !== "CANDIDATE")
      || (existingSeed.terminalState !== "CANDIDATE" && args.snapshot.state === "CANDIDATE")
      || (existingSeed.terminalState === "SUPPRESSED" && args.snapshot.state !== "SUPPRESSED")
      || ((existingSeed.terminalState === "FINAL" || existingSeed.terminalState === "SOFT_FINAL") && args.snapshot.state === "CONFIRMED");
    const seedSignal = shouldResetSeed
      ? nextSignalFromSnapshot(Number(args.snapshot.ts), args.snapshot.state as LiveSetupSignalState)
      : existingSeed;
    liveShortSetupSeedBySymbol.set(args.symbol, seedSignal);
    const promotedSignal = seedSignal.terminalState === "CONFIRMED" && (args.snapshot.state === "FINAL" || args.snapshot.state === "SOFT_FINAL")
      ? nextSignalFromSnapshot(
          Number(args.snapshot.ts),
          args.snapshot.state,
          args.snapshot.state === "SOFT_FINAL"
            ? {
                finalTriggerEmitted: false,
                summaryReason: String(args.snapshot.metrics?.softFinalReason ?? args.snapshot.summaryReason ?? "soft_final_signal"),
                reasonsSummary: String(args.snapshot.metrics?.softFinalReason ?? args.snapshot.summaryReason ?? "soft_final_signal"),
              }
            : undefined,
        )
      : null;
    const bars = liveShortBarsBySymbol.get(args.symbol) ?? [];
    const lifecycle = buildShortSetupLifecycle({
      runId: "live",
      setupId: `live:setup:${args.symbol}:${seedSignal.signalTs}`,
      signal: seedSignal,
      outcome: { referencePrice: args.referenceMarket?.midPrice ?? args.referenceMarket?.lastPrice ?? args.referenceMarket?.markPrice ?? null },
      bars,
      shortCfg: args.shortCfg,
      promotedSignal,
      nowMs: Date.now(),
    });
    if (!lifecycle) return { setup: null, lastRevision: null };
    const synced = shortLiveSetupStore.syncLifecycle({
      setup: lifecycle.current,
      revisions: lifecycle.revisions,
      signalState: args.snapshot.state as LiveSetupSignalState,
    });
    return {
      setup: synced.record,
      lastRevision: synced.latestRevision ?? lifecycle.revisions[lifecycle.revisions.length - 1] ?? null,
    };
  }

  async function refreshShortLongShortRatios() {
    const cfg = getEffectiveConfig();
    if (cfg.selectedBotId !== SHORT_EXHAUSTION_BOT_ID) return;
    const symbols = resolveTradingSymbols(cfg);
    if (!symbols.length) return;
    await longShortRatios.refreshSymbols(symbols);
    invalidateClientRowCaches(symbols);
  }

  function syncShortLongShortRatioPolling() {
    const cfg = getEffectiveConfig();
    const shouldRun = cfg.selectedBotId === SHORT_EXHAUSTION_BOT_ID
      && desiredStreams;
    if (!shouldRun) {
      if (longShortRatioTimer) {
        clearInterval(longShortRatioTimer);
        longShortRatioTimer = null;
      }
      return;
    }
    if (longShortRatioTimer) return;
    longShortRatioTimer = setInterval(() => {
      void refreshShortLongShortRatios();
    }, 60_000);
    void refreshShortLongShortRatios();
  }

  function computeBaseRows(now: number, options?: { consumeSignals?: boolean }): SymbolRowBase[] {
    const rowsMeasure = runtimeDiagnostics.start("short.runtime.rows");
    try {
      ensureEngines();
      shortLiveSetupStore.reconcileExpiry(now);

      const cfg = getEffectiveConfig();
      const consumeSignals = options?.consumeSignals ?? true;
      const symbols = resolveTradingSymbols(cfg);
      const sessionId = runtime.getStatus().sessionId;
      if (sessionId !== lastShortSignalSessionId) {
        shortSignalGateBySymbol.clear();
        liveShortSetupSeedBySymbol.clear();
        clearShortRuntimeContextsCache();
        lastShortSignalSessionId = sessionId;
      }

      const shortCfg = cfg.selectedBotId === SHORT_EXHAUSTION_BOT_ID ? readShortExhaustionConfig(cfg) : null;
      const baseCacheKey = JSON.stringify({
        sessionId: sessionId ?? null,
        scope: buildSymbolScopeKey(cfg),
        selectedBotId: cfg.selectedBotId,
        consumeSignals,
      });
      const canReuseBaseRows = Boolean(
        baseRowsCache
        && baseRowsCache.key === baseCacheKey
        && (now - baseRowsCache.builtAtMs) <= BASE_ROWS_CACHE_MAX_AGE_MS,
      );
      const dirtySymbols = new Set(clientRowDirtySymbols);
      const shortRuntimeContexts = shortCfg
        ? getShortRuntimeContextsCached({
          symbols,
          now,
          shortCfg,
        })
        : null;
      const out: SymbolRowBase[] = [];
      const nextRowsBySymbol = new Map<string, SymbolRowBase>();

      for (const symbol of symbols) {
      const cachedRow = canReuseBaseRows && !dirtySymbols.has(symbol)
        ? baseRowsCache?.rowsBySymbol.get(symbol) ?? null
        : null;
      if (cachedRow) {
        out.push(cachedRow);
        nextRowsBySymbol.set(symbol, cachedRow);
        continue;
      }
      const raw = cache.getRawRow(symbol);

      const markPrice = finiteOr(raw?.markPrice, 0) ?? 0;
      const lastPrice = finiteOr(raw?.lastPrice, null);
      const bid1 = finiteOr(raw?.bid1, null);
      const ask1 = finiteOr(raw?.ask1, null);
      const midPrice = bid1 != null && ask1 != null ? (bid1 + ask1) / 2 : null;
      const openInterestValue = finiteOr(raw?.openInterestValue, 0) ?? 0;
      const openInterest = resolveComparableOpenInterest({
        openInterest: finiteOr(raw?.openInterest, null),
        openInterestValue,
        markPrice,
      });
      const fundingRate = finiteOr(raw?.fundingRate, 0) ?? 0;
      const nextFundingTime = finiteOr(raw?.nextFundingTime, 0) ?? 0;
      const fundingIntervalHour = finiteOr(raw?.fundingIntervalHour, null);
      const turnover24hUsd = finiteOr(raw?.turnover24hUsd, null);
      const highPrice24h = finiteOr(raw?.highPrice24h, null);
      const lowPrice24h = finiteOr(raw?.lowPrice24h, null);
      const updatedAt = finiteOr(raw?.updatedAt, 0) ?? 0;

      const refs = candles.getRefs(symbol);
      const lookbackCandles = 1;
      const cadence = liveCadenceBySymbol.get(symbol);
      const confirmedPriceHistory = cadence?.confirmedPriceHistory ?? [];
      const confirmedOiHistory = cadence?.confirmedOiHistory ?? [];
      const refPrice = getLookbackRef(confirmedPriceHistory, lookbackCandles);
      const refOi = getLookbackRef(confirmedOiHistory, lookbackCandles);
      const freshRefPrice = confirmedPriceHistory.length > 0
        ? Number(confirmedPriceHistory[confirmedPriceHistory.length - 1] ?? null)
        : null;
      const freshRefOi = confirmedOiHistory.length > 0
        ? Number(confirmedOiHistory[confirmedOiHistory.length - 1] ?? null)
        : null;
      const spreadBps = readSpreadBps(bid1, ask1, markPrice);

      const priceMovePct =
        refPrice == null || markPrice <= 0 ? null : pctChange(markPrice, refPrice);
      const freshPriceMovePct =
        freshRefPrice == null || markPrice <= 0 ? null : pctChange(markPrice, freshRefPrice);

      const oivMovePct =
        refOi == null || openInterest == null || openInterest <= 0
          ? null
          : pctChange(openInterest, refOi);
      const freshOiMovePct =
        freshRefOi == null || openInterest == null || openInterest <= 0
          ? null
          : pctChange(openInterest, freshRefOi);
      const cvdFeatures = cvdRecorder.getSignalFeatures(symbol);

      const cooldown = fundingGate.state(nextFundingTime || null, now);
      const fundingCooldownActive = cooldown?.active ?? false;

      let signal: SignalSide | null = null;
      let signalReason = "";
      let cooldownActive = fundingCooldownActive;
      let liquidationState: SymbolRowBase["liquidationState"] = "IDLE";
      let liquidationDominantSide: SymbolRowBase["liquidationDominantSide"] = null;
      let liquidationClusterUsd: number | null = null;
      let liquidationImbalance: number | null = null;
      let liquidationEventsCount: number | null = null;
      let liquidationPriceShockPct: number | null = null;
      let liquidationBouncePct: number | null = null;
      let liquidationOiDeltaPct: number | null = null;
      let liquidationTradeDeltaPct: number | null = null;
      let liquidationScore: number | null = null;
      let liquidationLastEventAt: number | null = null;
      let liquidationConfirmDeadlineMs: number | null = null;
      let liquidationFlushLow: number | null = null;
      let liquidationFlushHigh: number | null = null;
      let liquidationCooldownEndMs: number | null = null;
      let liquidationRejectionReason: string | null = null;
      let shortSignalStage: ShortExhaustionSignalStage | null = null;
      let shortSignalState: ShortExhaustionSignalState | null = null;
      let shortCandidateScore: number | null = null;
      let shortDerivativesScore: number | null = null;
      let shortExhaustionScore: number | null = null;
      let shortMicrostructureScore: number | null = null;
      let shortTotalScore: number | null = null;
      let shortObserveOnly = false;
      let shortAdvisoryVerdict: ShortExhaustionAdvisoryVerdict | null = null;
      let shortAdvisoryReason: string | null = null;
      let shortBiasLabel: ShortExhaustionBiasLabel | null = null;
      let shortReversalBiasScore: number | null = null;
      let shortSqueezeRiskScore: number | null = null;
      let shortSummaryReason: string | null = null;
      let shortReasons: string[] = [];
      let shortHardRejectReasons: string[] = [];
      let shortSuppressionReasons: string[] = [];
      let shortLongShortRatio: number | null = null;
      let shortOrderbookImbalance: number | null = null;
      let shortAskToBidDepthRatio: number | null = null;
      let shortShortLiquidationUsd60s: number | null = null;
      let shortLongLiquidationUsd60s: number | null = null;
      let shortOiMove5mPct: number | null = null;
      let shortOiMove15mPct: number | null = null;
      let shortOiMove1hPct: number | null = null;
      let shortSetupPreview: ShortLiveSetupRecord | null = null;
      let shortSetupPreviewLastRevision: ShortReplaySetupRevisionRecord | null = null;

      if (cfg.selectedBotId === SHORT_EXHAUSTION_BOT_ID) {
        const activeShortCfg = shortCfg ?? readShortExhaustionConfig(cfg);
        const shortBundle = evaluateShortSignalBundle({
          symbol,
          now,
          symbols,
          shortCfg: activeShortCfg,
          contexts: shortRuntimeContexts,
        });
        const context = shortBundle.context;
        const liquidationSnapshot = shortBundle.liquidationSnapshot;
        const orderbookSnapshot = shortBundle.orderbookSnapshot;
        const longShortRatioSnapshot = shortBundle.longShortRatioSnapshot;
        const gate = readShortSignalGate(symbol);
        const snapshot = applyLiveShortAdvisoryClassifier(shortBundle.snapshot, gate);
        const liveSetupPreview = buildLiveShortSetupPreview({
          symbol,
          snapshot,
          shortCfg: activeShortCfg,
          referenceMarket: shortBundle.referenceMarket,
        });

        shortSignalStage = snapshot.stage;
        shortSignalState = snapshot.state;
        shortCandidateScore = snapshot.candidateScore;
        shortDerivativesScore = snapshot.derivativesScore;
        shortExhaustionScore = snapshot.exhaustionScore;
        shortMicrostructureScore = snapshot.microstructureScore;
        shortTotalScore = snapshot.totalScore;
        shortObserveOnly = activeShortCfg.observe.observeOnly;
        shortAdvisoryVerdict = snapshot.advisoryVerdict;
        shortAdvisoryReason = snapshot.advisoryReason;
        shortBiasLabel = snapshot.biasLabel;
        shortReversalBiasScore = snapshot.reversalBiasScore;
        shortSqueezeRiskScore = snapshot.squeezeRiskScore;
        shortSummaryReason = snapshot.summaryReason;
        shortReasons = snapshot.reasons;
        shortHardRejectReasons = snapshot.hardRejectReasons;
        shortSuppressionReasons = snapshot.suppressionReasons;
        shortLongShortRatio = longShortRatioSnapshot.longShortRatio;
        shortOrderbookImbalance = orderbookSnapshot.imbalanceRatio;
        shortAskToBidDepthRatio = orderbookSnapshot.askToBidDepthRatio;
        shortShortLiquidationUsd60s = liquidationSnapshot.shortLiquidationUsd60s;
        shortLongLiquidationUsd60s = liquidationSnapshot.longLiquidationUsd60s;
        shortOiMove5mPct = context.oiMove5mPct;
        shortOiMove15mPct = context.oiMove15mPct ?? null;
        shortOiMove1hPct = context.oiMove1hPct ?? null;
        shortSetupPreview = liveSetupPreview.setup;
        shortSetupPreviewLastRevision = liveSetupPreview.lastRevision;
        const tfMs = Math.max(1, Number(activeShortCfg.strategy.signalTfMin || cfg.universe.klineTfMin || 1)) * 60_000;
        const candleId = Math.floor(now / tfMs);
        const barsSinceLast = gate.lastTriggeredCandleId == null ? Number.POSITIVE_INFINITY : candleId - gate.lastTriggeredCandleId;
        const cooldownOk = barsSinceLast >= Math.max(activeShortCfg.strategy.minBarsBetweenSignals, activeShortCfg.strategy.cooldownCandles);
        const emittedSignal = snapshot.isFinalShortSignal && consumeSignals && cooldownOk;

        signal = emittedSignal ? "SHORT" : null;
        signalReason = emittedSignal ? snapshot.summaryReason : "";
        cooldownActive = fundingCooldownActive || !cooldownOk;
        if (emittedSignal) {
          gate.lastTriggeredCandleId = candleId;
        }
        if (consumeSignals) {
          maybeLogShortSnapshot(snapshot, gate, emittedSignal);
        }
      }

        const nextRow: SymbolRowBase = {
        symbol,
        markPrice,
        lastPrice,
        bid1,
        ask1,
        midPrice,
        openInterestValue,
        fundingRate,
        nextFundingTime,
        fundingIntervalHour,
        turnover24hUsd,
        highPrice24h,
        lowPrice24h,
        updatedAt,

        prevCandleClose: refPrice,
        prevCandleOivClose: refOi,
        candleConfirmedAt: cadence?.lastConfirmedAt ?? refs.confirmedAt,
        priceMovePct,
        oivMovePct,
        shortOiMove5mPct,
        shortOiMove15mPct,
        shortOiMove1hPct,

        cooldownActive,
        cooldownWindowStartMs: cooldown ? cooldown.windowStartMs : null,
        cooldownWindowEndMs: cooldown ? cooldown.windowEndMs : null,

        signal,
        signalReason,
        liquidationState,
        liquidationDominantSide,
        liquidationClusterUsd,
        liquidationImbalance,
        liquidationEventsCount,
        liquidationPriceShockPct,
        liquidationBouncePct,
        liquidationOiDeltaPct,
        liquidationTradeDeltaPct,
        liquidationScore,
        liquidationLastEventAt,
        liquidationConfirmDeadlineMs,
        liquidationFlushLow,
        liquidationFlushHigh,
        liquidationCooldownEndMs,
        liquidationRejectionReason,
        shortSignalStage,
        shortSignalState,
        shortCandidateScore,
        shortDerivativesScore,
        shortExhaustionScore,
        shortMicrostructureScore,
        shortTotalScore,
        shortObserveOnly,
        shortAdvisoryVerdict,
        shortAdvisoryReason,
        shortBiasLabel,
        shortReversalBiasScore,
        shortSqueezeRiskScore,
        shortSummaryReason,
        shortReasons,
        shortHardRejectReasons,
        shortSuppressionReasons,
        shortLongShortRatio,
        shortOrderbookImbalance,
        shortAskToBidDepthRatio,
        shortShortLiquidationUsd60s,
        shortLongLiquidationUsd60s,
        shortSetupPreview,
        shortSetupPreviewLastRevision,
      };
        out.push(nextRow);
        nextRowsBySymbol.set(symbol, nextRow);
      }

      baseRowsCache = {
        key: baseCacheKey,
        builtAtMs: now,
        rowsBySymbol: nextRowsBySymbol,
      };
      clientRowDirtySymbols.clear();
      rowsMeasure.end({ items: symbols.length });
      return out;
    } catch (error) {
      rowsMeasure.end({ failed: true });
      throw error;
    }
  }

  function attachPaper(baseRows: SymbolRowBase[], now: number): SymbolRow[] {
    return baseRows.map((r) => ({
      ...r,
      ...runtime.getPaperView(r.symbol, r.markPrice > 0 ? r.markPrice : null),
    }));
  }

  function buildPreviewRowFromRaw(raw: NonNullable<ReturnType<typeof cache.getRawRow>>): SymbolRow {
    return {
      symbol: raw.symbol,
      markPrice: Number(raw.markPrice ?? 0) || 0,
      lastPrice: raw.lastPrice ?? null,
      bid1: raw.bid1 ?? null,
      ask1: raw.ask1 ?? null,
      midPrice: raw.bid1 != null && raw.ask1 != null ? (raw.bid1 + raw.ask1) / 2 : null,
      openInterestValue: Number(raw.openInterestValue ?? 0) || 0,
      fundingRate: Number(raw.fundingRate ?? 0) || 0,
      nextFundingTime: Number(raw.nextFundingTime ?? 0) || 0,
      fundingIntervalHour: raw.fundingIntervalHour ?? null,
      turnover24hUsd: raw.turnover24hUsd ?? null,
      highPrice24h: raw.highPrice24h ?? null,
      lowPrice24h: raw.lowPrice24h ?? null,
      updatedAt: Number(raw.updatedAt ?? Date.now()) || Date.now(),
      signal: null,
      signalReason: "",
      prevCandleClose: null,
      prevCandleOivClose: null,
      candleConfirmedAt: null,
      priceMovePct: null,
      oivMovePct: null,
      shortOiMove5mPct: null,
      shortOiMove15mPct: null,
      shortOiMove1hPct: null,
      cooldownActive: false,
      cooldownWindowStartMs: null,
      cooldownWindowEndMs: null,
      liquidationState: "IDLE",
      liquidationDominantSide: null,
      liquidationClusterUsd: null,
      liquidationImbalance: null,
      liquidationEventsCount: null,
      liquidationPriceShockPct: null,
      liquidationBouncePct: null,
      liquidationOiDeltaPct: null,
      liquidationTradeDeltaPct: null,
      liquidationScore: null,
      liquidationLastEventAt: null,
      liquidationConfirmDeadlineMs: null,
      liquidationFlushLow: null,
        liquidationFlushHigh: null,
        liquidationCooldownEndMs: null,
        liquidationRejectionReason: null,
      shortSignalStage: null,
      shortSignalState: null,
      shortCandidateScore: null,
        shortDerivativesScore: null,
        shortExhaustionScore: null,
      shortMicrostructureScore: null,
      shortTotalScore: null,
      shortObserveOnly: false,
      shortAdvisoryVerdict: null,
      shortAdvisoryReason: null,
      shortBiasLabel: null,
      shortReversalBiasScore: null,
      shortSqueezeRiskScore: null,
      shortSummaryReason: null,
      shortReasons: [],
      shortHardRejectReasons: [],
        shortSuppressionReasons: [],
        shortLongShortRatio: null,
        shortOrderbookImbalance: null,
      shortAskToBidDepthRatio: null,
      shortShortLiquidationUsd60s: null,
      shortLongLiquidationUsd60s: null,
      shortSetupPreview: null,
      shortSetupPreviewLastRevision: null,
      ...runtime.getPaperView(raw.symbol, Number(raw.markPrice ?? 0) > 0 ? Number(raw.markPrice) : null),
    };
  }

  function computePreviewRows(): SymbolRow[] {
    return cache.getRowsForUi().map((raw) => buildPreviewRowFromRaw(raw));
  }

  function shouldServeLightweightClientRows(): boolean {
    return false;
  }

  manualTestOrderProvider = async ({ symbol: symbolRaw, side, executionMode, entryPrice, tpPrice, slPrice, marginUSDT, leverage }) => {
    const cfg = getEffectiveConfig();
    const symbol = String(symbolRaw ?? "").trim().toUpperCase();
    const availableWsSymbols = getAvailableWsSymbols();
    if (!symbol) {
      return { ok: false, accepted: false, message: "Symbol is required.", reason: "symbol_required" };
    }
    if (!availableWsSymbols.includes(symbol)) {
      return {
        ok: false,
        accepted: false,
        message: `Symbol ${symbol} does not have an active market WS snapshot yet.`,
        reason: "symbol_not_available_via_ws",
        symbol,
        side,
        availableSymbolsCount: availableWsSymbols.length,
      };
    }

    const raw = cache.getRawRow(symbol);
    if (!raw) {
      return {
        ok: false,
        accepted: false,
        message: `No market snapshot is available for ${symbol} yet.`,
        reason: "market_snapshot_missing",
        symbol,
        side,
      };
    }

    const midPrice = raw.bid1 != null && raw.ask1 != null ? (raw.bid1 + raw.ask1) / 2 : null;
    const markPrice = Number(raw.markPrice ?? raw.lastPrice ?? midPrice ?? 0);
    const manualExecutionOverride = {
      ...(Number.isFinite(Number(marginUSDT)) && Number(marginUSDT) > 0 ? { marginUSDT: Number(marginUSDT) } : {}),
      ...(Number.isFinite(Number(leverage)) && Number(leverage) >= 1 ? { leverage: Number(leverage) } : {}),
    };
    const result = await runtime.submitManualTestOrder({
      symbol,
      side,
      ...(executionMode ? { executionModeOverride: executionMode } : {}),
      nowMs: Date.now(),
      markPrice,
      fundingRate: Number(raw.fundingRate ?? 0) || 0,
      nextFundingTime: Number(raw.nextFundingTime ?? 0) || 0,
      ...(Number.isFinite(entryPrice as number) ? { entryPrice } : {}),
      ...(Number.isFinite(tpPrice as number) ? { tpPrice } : {}),
      ...(Number.isFinite(slPrice as number) ? { slPrice } : {}),
      maxTradesPerSymbol: 1,
      ...(Object.keys(manualExecutionOverride).length > 0 ? { configOverride: manualExecutionOverride } : {}),
    });
    const nextRaw = cache.getRawRow(symbol) ?? raw;
    return {
      ...result,
      tracked: true,
      row: buildPreviewRowFromRaw(nextRaw),
    };
  };

  function computeRowsForClientUncached(now: number, detail: "full" | "preview" = "full"): SymbolRow[] {
    if (detail === "preview") {
      return computePreviewRows();
    }
    if (rowsAllowed()) {
      if (shouldServeLightweightClientRows()) {
        return computePreviewRows();
      }
      return attachPaper(computeBaseRows(now), now);
    }
    if (streamsEnabled || bybitConnected) {
      return computePreviewRows();
    }
    return [];
  }

  function buildClientRowsCacheKey(detail: "full" | "preview" = "full"): string {
    const cfg = getEffectiveConfig();
    const st = runtime.getStatus();
    const rowsMode = detail === "preview"
      ? "preview_forced"
      : rowsAllowed()
        ? (shouldServeLightweightClientRows() ? "rows_lightweight" : "rows")
        : "preview";
    return [
      clientRowsRevision,
      st.sessionState,
      rowsMode,
      streamsEnabled ? "streams" : "no_streams",
      bybitConnected ? "bybit" : "no_bybit",
      buildSymbolScopeKey(cfg),
    ].join("::");
  }

  function computeRowsForClient(now: number, detail: "full" | "preview" = "full"): SymbolRow[] {
    const cacheKey = buildClientRowsCacheKey(detail);
    if (
      clientRowsCache
      && clientRowsCache.key === cacheKey
      && now - clientRowsCache.builtAtMs <= CLIENT_ROWS_CACHE_MAX_AGE_MS
    ) {
      return clientRowsCache.rows;
    }

    const rows = computeRowsForClientUncached(now, detail);
    clientRowsCache = {
      key: cacheKey,
      builtAtMs: now,
      rows,
      botStats: computeBotStats(rows),
    };
    return rows;
  }

  shortSignalsRowsSnapshotProvider = () => computeRowsForClient(nowMs(), "full");

  function computeBotStats(rows: SymbolRow[]): BotStats {
    const base = runtime.getBotStats();
    const unrealizedPnl = rows.reduce((sum, row) => {
      const value = row.paperUnrealizedPnl;
      return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0);

    return {
      ...base,
      unrealizedPnl,
    };
  }

  function buildAvailableWsSnapshot(): { rows: AvailableWsRow[]; symbols: string[] } {
    if (availableWsSnapshotCache && availableWsSnapshotCache.revision === clientRowsRevision) {
      return {
        rows: availableWsSnapshotCache.rows,
        symbols: availableWsSnapshotCache.symbols,
      };
    }

    const source = cache.getRowsForUi();
    const rows: AvailableWsRow[] = [];
    const symbols: string[] = [];
    for (const row of source) {
      rows.push({
        symbol: row.symbol,
        markPrice: row.markPrice,
        lastPrice: row.lastPrice ?? null,
        updatedAt: row.updatedAt,
      });
      symbols.push(row.symbol);
    }
    availableWsSnapshotCache = {
      revision: clientRowsRevision,
      rows,
      symbols,
    };
    return { rows, symbols };
  }

  function getAvailableWsRows(): AvailableWsRow[] {
    return buildAvailableWsSnapshot().rows;
  }

  function getAvailableWsSymbols(): string[] {
    return buildAvailableWsSnapshot().symbols;
  }

  function sendEventsTail(ws: WebSocket, limit: number) {
    const st = runtime.getStatus();
    const file = st.eventsFile;

    let events: LogEvent[] = [];
    if (file) {
      try {
        events = readJsonlTail(file, limit);
      } catch {
        events = [];
      }
    }

    safeSend(ws, {
      type: "events_tail",
      payload: { limit, count: events.length, events },
    });
  }

  function sendRowsToClient(ws: WebSocket, mode: "tick" | "snapshot", detail?: "full" | "preview") {
    const now = nowMs();
    const resolvedDetail = detail ?? clientRowsDetail.get(ws) ?? "preview";
    const rows = computeRowsForClient(now, resolvedDetail);
    const { rows: availableWsRows, symbols: availableWsSymbols } = buildAvailableWsSnapshot();
    const botStats = clientRowsCache?.rows === rows ? clientRowsCache.botStats : computeBotStats(rows);

    if (mode === "snapshot") {
      const st = runtime.getStatus();
      safeSend(ws, {
        type: "snapshot",
        payload: { sessionState: st.sessionState, sessionId: st.sessionId, runningSinceMs: st.runningSinceMs, rows, botStats, streamsEnabled, bybitConnected, ...getUniverseInfo(getEffectiveConfig()), availableWsSymbols, availableWsRows, optimizer: getOptimizerSnapshot() },
      });
      return;
    }

    safeSend(ws, { type: "tick", payload: { serverTime: now, rows, botStats, ...getUniverseInfo(getEffectiveConfig()), availableWsSymbols, availableWsRows } });
  }

  function broadcastSnapshot() {
    if (clients.size === 0) return;
    const now = nowMs();
    const st = runtime.getStatus();
    const { rows: availableWsRows, symbols: availableWsSymbols } = buildAvailableWsSnapshot();
    for (const c of clients) {
      const detail = clientRowsDetail.get(c) ?? "preview";
      const rows = computeRowsForClient(now, detail);
      const botStats = clientRowsCache?.rows === rows ? clientRowsCache.botStats : computeBotStats(rows);
      safeSend(c, {
        type: "snapshot",
        payload: { sessionState: st.sessionState, sessionId: st.sessionId, runningSinceMs: st.runningSinceMs, rows, botStats, streamsEnabled, bybitConnected, ...getUniverseInfo(getEffectiveConfig()), availableWsSymbols, availableWsRows, optimizer: getOptimizerSnapshot() },
      });
    }

    for (const c of clients) {
      const lim = clientEventsLimit.get(c) ?? 5;
      sendEventsTail(c, lim);
    }
  }

  function broadcastEventAppend(ev: LogEvent) {
    if (clients.size === 0) return;
    const msg: ServerWsMessage = { type: "events_append", payload: { event: ev } };
    for (const c of clients) safeSend(c, msg);
  }

  function startLiveUpdateAggregator() {
    liveUpdateAggregator.start();
  }

  function stopLiveUpdateAggregator() {
    liveUpdateAggregator.stop();
  }

  function syncLiveUpdateAggregator() {
    const st = runtime.getStatus();
    const runtimeActive = st.sessionState === "RUNNING" || st.sessionState === "RESUMING";
    if (runtimeActive && clients.size > 0) {
      startLiveUpdateAggregator();
      return;
    }
    stopLiveUpdateAggregator();
  }

  function syncRuntimeStreamLifecycle() {
    const cfg = getEffectiveConfig();
    const st = runtime.getStatus();
    const { runtimeActive, recorderMode, cvdMode, marketMode, shouldEnableStreams } = readCurrentStreamRequirement();
    const targets = resolveSubscriptionTargets(cfg, runtimeActive, recorderMode, cvdMode, marketMode);
    const nextSubscriptionKey = computeSubscriptionKey(runtimeActive, recorderMode, cvdMode, marketMode);

    if (shouldEnableStreams) {
      streamsEnabled = true;
      desiredStreams = true;
      const recorderTrackSymbols = runtimeActive
        ? normalizeSymbols([...targets.tradingSymbols, ...targets.recorderSymbols])
        : targets.recorderSymbols;
      if ((runtimeActive && recorderMode !== "off") || recorderMode === "record_only") {
        minuteOiRecorder.activate(recorderTrackSymbols);
      } else {
        minuteOiRecorder.deactivate();
      }
      if ((runtimeActive && cvdMode !== "off") || cvdMode === "record_only") {
        cvdRecorder.activate(recorderTrackSymbols);
      } else {
        cvdRecorder.deactivate();
      }
      if ((runtimeActive && marketMode !== "off") || marketMode === "record_only") {
        minuteMarketRecorder.activate(recorderTrackSymbols);
      } else {
        minuteMarketRecorder.deactivate();
      }
      if (bybitShards.size > 0 && bybitConnected && nextSubscriptionKey !== lastSubscriptionKey) {
        lastSubscriptionKey = nextSubscriptionKey;
        applySubscriptions("stream_target_change");
      } else {
        lastSubscriptionKey = nextSubscriptionKey;
        void startUpstreamIfNeeded();
      }
      syncLiveUpdateAggregator();
      syncShortLongShortRatioPolling();
      broadcastStreamsState();
      return;
    }

    streamsEnabled = false;
    desiredStreams = false;
    lastSubscriptionKey = "";
    minuteOiRecorder.deactivate();
    cvdRecorder.deactivate();
    minuteMarketRecorder.deactivate();
    stopUpstreamHard();
    syncLiveUpdateAggregator();
    syncShortLongShortRatioPolling();
    broadcastStreamsState();
  }

  const onRuntimeState = () => {
    const st = runtime.getStatus();
    clearShortRuntimeContextsCache();
    invalidateClientRowCaches();
    if (st.sessionId !== shortSignalEventCountSessionId) {
      shortSignalEventCountSessionId = st.sessionId ?? null;
      shortSignalEventCountBySymbol.clear();
    }
    if ((st.sessionState === "RESUMING" || st.sessionState === "RUNNING") && !sessionConfigSnapshot) {
      sessionConfigSnapshot = configStore.get();
    } else if (st.sessionState === "STOPPED") {
      sessionConfigSnapshot = null;
    }
    syncRuntimeStreamLifecycle();
    broadcastSnapshot();
  };
  const onRuntimeEvent = (ev: LogEvent) => {
    if (isShortSignalEventType((ev as any)?.type)) {
      const symbol = String((ev as any)?.symbol ?? "").trim().toUpperCase();
      if (symbol) {
        shortSignalEventCountBySymbol.set(symbol, (shortSignalEventCountBySymbol.get(symbol) ?? 0) + 1);
      }
    }
    broadcastEventAppend(ev);
  };

  runtime.on("state", onRuntimeState);
  runtime.on("event", onRuntimeEvent);

  function attachBybitShardClient(
    shard: Pick<BybitWsShardState, "key" | "topics" | "chars">,
    subscribeDelayMs: number,
  ) {
    const client = new BybitWsClient(CONFIG.bybit.wsUrl, {
      onOpen: () => {
        const current = bybitShards.get(shard.key);
        if (!current || current.client !== client) return;
        current.connected = true;
        current.lastMessageAtMs = Date.now();
        const state = runtime.getStatus();
        const nextRuntimeActive = state.sessionState === "RUNNING" || state.sessionState === "RESUMING";
        lastSubscriptionKey = computeSubscriptionKey(nextRuntimeActive, minuteOiRecorder.getStatus().mode, cvdRecorder.getStatus().mode, minuteMarketRecorder.getStatus().mode);
        app.log.info({ shardKey: shard.key, topics: shard.topics.length, chars: shard.chars }, "bybit ws shard: open");
        setTimeout(() => client.subscribe(shard.topics), subscribeDelayMs);
        recomputeBybitConnectedState();
        const shardAttempt = shardReconnectAttempts.get(shard.key) ?? 0;
        if (shardAttempt > 0) {
          appendBybitWsIncident({
            type: "recovered",
            reason: reconnectReason,
            shardKey: shard.key,
            staleMs: null,
            attempt: shardAttempt,
            recoveredAt: Date.now(),
            delayMs: null,
            topics: shard.topics.length,
            eventLoopLagMs: lastEventLoopLagMs,
            fullReconnect: false,
          });
          shardReconnectAttempts.delete(shard.key);
        }
        if (bybitConnected) {
          if (reconnectAttempt > 0) {
            appendBybitWsIncident({
              type: "recovered",
              reason: reconnectReason,
              shardKey: null,
              staleMs: null,
              attempt: reconnectAttempt,
              recoveredAt: Date.now(),
              delayMs: null,
              topics: Array.from(bybitShards.values()).reduce((acc, value) => acc + value.topics.length, 0),
              eventLoopLagMs: lastEventLoopLagMs,
              fullReconnect: true,
            });
          }
          reconnectAttempt = 0;
          reconnectReason = "connected";
        }
        broadcastStreamsState();
        resolveStreamWaitersIfReady();
      },
      onClose: () => {
        handleBybitShardFailure(shard.key, "disconnected", undefined, client);
      },
      onError: (err) => {
        handleBybitShardFailure(shard.key, "connection_error", err, client);
      },
      onTicker: (topic, _type, data) => {
        noteBybitShardMessage(shard.key);
        const symbol = topic.slice("tickers.".length);
        noteWsProbeMessage("ticker", symbol);
        pendingTickerBySymbol.set(symbol, {
          symbol,
          data,
          receivedAtMs: Date.now(),
        });
      },
      onKline: (topic, _type, data) => {
        noteBybitShardMessage(shard.key);
        const parsed = parseKlineTopic(topic);
        if (!parsed) return;
        const { symbol, tfMin } = parsed;
        noteWsProbeMessage("kline", symbol);
        const klineRow = Array.isArray(data) ? data[0] : data;
        if (!klineRow || typeof klineRow !== "object") return;
        const confirmRaw = (klineRow as any)?.confirm;
        const isConfirm = confirmRaw === true || confirmRaw === "true" || confirmRaw === 1 || confirmRaw === "1";
        if (isConfirm && tfMin === 1) {
          noteLiveShortBar(symbol, klineRow as Record<string, unknown>, cache.getRawRow(symbol));
          minuteMarketRecorder.ingestKline({
            symbol,
            kline: klineRow,
            market: cache.getRawRow(symbol),
          });
          const currentCfg = getEffectiveConfig();
          if (currentCfg.selectedBotId === SHORT_EXHAUSTION_BOT_ID) {
            const tradingSymbols = resolveTradingSymbols(currentCfg);
            if (tradingSymbols.includes(symbol)) {
              ensureEngines();
              const shortCfg = readShortExhaustionConfig(currentCfg);
              const minuteStartMs = Math.floor(Number((klineRow as any)?.start ?? (klineRow as any)?.startTime ?? Date.now()) / 60_000) * 60_000;
              const evaluationTs = Date.now();
              const contexts = getShortRuntimeContextsCached({
                symbols: tradingSymbols,
                now: evaluationTs,
                shortCfg,
              });
              maybeRecordShortResearchMinute({
                symbol,
                minuteStartMs,
                evaluationTs,
                symbols: tradingSymbols,
                shortCfg,
                contexts,
                kline: klineRow as Record<string, unknown>,
              });
            }
          }
        }
        const currentCfg = getEffectiveConfig();
        const runtimeTf = Math.max(1, Math.floor(Number(currentCfg.universe?.klineTfMin) || 1));
        const tradingSymbols = new Set(resolveTradingSymbols(currentCfg));
        if (tfMin !== runtimeTf || !tradingSymbols.has(symbol)) return;
        const refs = candles.ingestKline(symbol, klineRow);
        if (isConfirm && refs) {
          const state: LiveCadenceState = liveCadenceBySymbol.get(symbol) ?? {
            confirmedPriceHistory: [] as number[],
            confirmedOiHistory: [] as number[],
            lastConfirmedAt: null,
            observationStep: 0,
          };
          if (Number.isFinite(refs.prevCandleClose) && Number(refs.prevCandleClose) > 0) {
            state.confirmedPriceHistory.push(Number(refs.prevCandleClose));
            if (state.confirmedPriceHistory.length > 64) state.confirmedPriceHistory.shift();
          }
          if (Number.isFinite(refs.prevCandleOiClose) && Number(refs.prevCandleOiClose) > 0) {
            state.confirmedOiHistory.push(Number(refs.prevCandleOiClose));
            if (state.confirmedOiHistory.length > 64) state.confirmedOiHistory.shift();
          }
          state.lastConfirmedAt = refs.confirmedAt ?? Date.now();
          state.observationStep += 1;
          liveCadenceBySymbol.set(symbol, state);
        }
        if (isConfirm) {
          markShortRuntimeContextDirty(symbol);
          invalidateClientRowCaches([symbol]);
          enqueueLiveUpdate(`kline:${symbol}`);
        }
      },
      onOrderbook: (topic, type, data) => {
        noteBybitShardMessage(shard.key);
        const symbol = parseOrderbookTopic(topic);
        if (!symbol) return;
        notePendingOrderbookUpdate(symbol, type, data);
      },
      onPublicTrade: (topic, data) => {
        noteBybitShardMessage(shard.key);
        const symbol = topic.slice("publicTrade.".length);
        noteWsProbeMessage("publicTrade", symbol);
        const side = String((data as any)?.S ?? (data as any)?.side ?? "");
        const price = Number((data as any)?.p ?? (data as any)?.price);
        const size = Number((data as any)?.v ?? (data as any)?.size);
        const tsRaw = Number((data as any)?.T ?? (data as any)?.time);
        if (side !== "Buy" && side !== "Sell") return;
        const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : Date.now();
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) return;
        const key = `${symbol}:${side}`;
        const existing = pendingTradesByKey.get(key) ?? {
          symbol,
          side: side as "Buy" | "Sell",
          totalSize: 0,
          totalNotional: 0,
          tradesCount: 0,
          lastTs: ts,
        };
        existing.totalSize += size;
        existing.totalNotional += price * size;
        existing.tradesCount += 1;
        if (ts >= existing.lastTs) {
          existing.lastTs = ts;
        }
        pendingTradesByKey.set(key, existing);
      },
      onLiquidation: (topic, data) => {
        noteBybitShardMessage(shard.key);
        const topicSymbol = topic.slice("allLiquidation.".length);
        const symbol = String((data as any)?.s ?? (data as any)?.symbol ?? topicSymbol).trim();
        noteWsProbeMessage("liquidation", symbol);

        const sideRaw = String((data as any)?.S ?? (data as any)?.side ?? "").trim();
        const liquidationSide = sideRaw === "Buy"
          ? "LONG"
          : sideRaw === "Sell"
            ? "SHORT"
            : null;
        const price = Number((data as any)?.p ?? (data as any)?.price);
        const size = Number((data as any)?.v ?? (data as any)?.size);
        const tsRaw = Number((data as any)?.T ?? (data as any)?.ts ?? (data as any)?.time);
        const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : Date.now();
        const sizeUsd = Number.isFinite(price) && Number.isFinite(size) ? price * size : Number.NaN;

        pushWsProbeLiquidation({
          ts,
          symbol,
          liquidationSide,
          price: Number.isFinite(price) ? price : null,
          size: Number.isFinite(size) ? size : null,
        });
        if (liquidationSide && Number.isFinite(price) && price > 0 && Number.isFinite(sizeUsd) && sizeUsd > 0) {
          const key = `${symbol}:${liquidationSide}`;
          const existing = pendingLiquidationsByKey.get(key) ?? {
            symbol,
            liquidationSide,
            totalSizeUsd: 0,
            eventsCount: 0,
            lastTs: ts,
            lastPrice: price,
          };
          existing.totalSizeUsd += sizeUsd;
          existing.eventsCount += 1;
          if (ts >= existing.lastTs) {
            existing.lastTs = ts;
            existing.lastPrice = price;
          }
          pendingLiquidationsByKey.set(key, existing);
        }
      },
    });

    bybitShards.set(shard.key, {
      ...shard,
      client,
      connected: false,
      lastMessageAtMs: null,
    });
    return client;
  }

  function handleBybitShardFailure(shardKey: string, reason: string, err?: unknown, client?: BybitWsClient) {
    if (!bybitShards.has(shardKey)) return;
    const shard = bybitShards.get(shardKey)!;
    if (client && shard.client !== client) return;
    shard.connected = false;
    recomputeBybitConnectedState();
    appendBybitWsIncident({
      type: "failure",
      reason,
      shardKey,
      staleMs: shard.lastMessageAtMs == null ? null : Date.now() - shard.lastMessageAtMs,
      attempt: shardReconnectAttempts.get(shardKey) ?? 0,
      recoveredAt: null,
      delayMs: null,
      topics: shard.topics.length,
      eventLoopLagMs: lastEventLoopLagMs,
      fullReconnect: false,
    });
    if (err) {
      app.log.error({ err, shardKey, topics: shard.topics.length, reason }, "bybit ws shard: failure");
    } else {
      app.log.warn({ shardKey, topics: shard.topics.length, reason }, "bybit ws shard: failure");
    }
    broadcastStreamsState();
    rejectStreamWaiters(`streams_${reason}`);
    scheduleReconnect({ reason, shardKey });
  }

  function scheduleReconnect(target: ReconnectTarget) {
    if (!desiredStreams) return;
    const reason = target.reason || "reconnect_requested";
    const shardKey = target.shardKey ?? null;
    if (shardKey) {
      if (shardReconnectTimers.has(shardKey)) return;
      const attempt = (shardReconnectAttempts.get(shardKey) ?? 0) + 1;
      shardReconnectAttempts.set(shardKey, attempt);
      reconnectReason = reason;
      const delayMs = computeReconnectDelayMs(attempt);
      app.log.warn({ reason, shardKey, attempt, delayMs }, "bybit ws: shard reconnect scheduled");
      appendBybitWsIncident({
        type: "reconnect_scheduled",
        reason,
        shardKey,
        staleMs: target.staleMs ?? null,
        attempt,
        recoveredAt: null,
        delayMs,
        topics: bybitShards.get(shardKey)?.topics.length ?? null,
        eventLoopLagMs: target.eventLoopLagMs ?? lastEventLoopLagMs,
        fullReconnect: false,
      });
      const timer = setTimeout(async () => {
        shardReconnectTimers.delete(shardKey);
        if (!desiredStreams) return;
        await reconnectShard(shardKey, reason);
      }, delayMs);
      shardReconnectTimers.set(shardKey, timer);
      return;
    }
    if (reconnectTimer) return;
    reconnectReason = reason;
    reconnectAttempt += 1;
    const delayMs = computeReconnectDelayMs(reconnectAttempt);
    app.log.warn({ reason, attempt: reconnectAttempt, delayMs }, "bybit ws: reconnect scheduled");
    appendBybitWsIncident({
      type: "reconnect_scheduled",
      reason,
      shardKey: null,
      staleMs: target.staleMs ?? null,
      attempt: reconnectAttempt,
      recoveredAt: null,
      delayMs,
      topics: Array.from(bybitShards.values()).reduce((acc, value) => acc + value.topics.length, 0),
      eventLoopLagMs: target.eventLoopLagMs ?? lastEventLoopLagMs,
      fullReconnect: true,
    });
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (!desiredStreams) return;
      closeBybitShards(true);
      broadcastStreamsState();
      await startUpstreamIfNeeded();
    }, delayMs);
  }

  async function reconnectShard(shardKey: string, reason: string) {
    if (!desiredStreams) return;
    const existing = bybitShards.get(shardKey);
    if (!existing) {
      await startUpstreamIfNeeded();
      return;
    }
    const shard = { key: existing.key, topics: [...existing.topics], chars: existing.chars };
    closeBybitShard(shardKey, true);
    broadcastStreamsState();
    const client = attachBybitShardClient(shard, 0);
    try {
      await client.connect();
    } catch (err) {
      app.log.error({ err, shardKey, reason }, "bybit ws shard: reconnect failed");
      closeBybitShard(shardKey, true);
      scheduleReconnect({ reason: `${reason}_retry`, shardKey });
    }
  }

  async function startUpstreamIfNeeded() {
    if (!desiredStreams) return;
    if (connectInFlight) return;
    if (bybitShards.size > 0) return;

    if (minuteOiRecorder.getStatus().mode !== "off" || cvdRecorder.getStatus().mode !== "off" || minuteMarketRecorder.getStatus().mode !== "off") {
      await ensureRecorderSeededSymbols();
    }
    connectInFlight = true;

    const cfg = getEffectiveConfig();
    const st = runtime.getStatus();
    const runtimeActive = st.sessionState === "RUNNING" || st.sessionState === "RESUMING";
    const recorderMode = minuteOiRecorder.getStatus().mode;
    const cvdMode = cvdRecorder.getStatus().mode;
    const marketMode = minuteMarketRecorder.getStatus().mode;
    const { targets, topics, shards } = buildBybitTopicShards(cfg, runtimeActive, recorderMode, cvdMode, marketMode);
    const cvdStatus = cvdRecorder.getStatus();
    const bootstrapSymbols = runtimeActive ? targets.tradingSymbols.slice(0, 40) : [];
    if (cvdStatus.mode !== "off" && bootstrapSymbols.length > 0) {
      void cvdRecorder.bootstrapFromRest(bootstrapSymbols).catch(() => undefined);
    }

    if (shards.length === 0) {
      connectInFlight = false;
      bybitConnected = false;
      broadcastStreamsState();
      return;
    }

    app.log.info({
      topics: topics.length,
      shards: shards.length,
      totalChars: sumTopicChars(topics),
      maxCharsPerShard: Math.max(...shards.map((shard) => shard.chars)),
    }, "bybit ws: starting sharded public streams");

    for (const [index, shard] of shards.entries()) {
      attachBybitShardClient(shard, index * 150);
    }

    connectInFlight = false;
    recomputeBybitConnectedState();
    broadcastStreamsState();

    try {
      for (const shard of bybitShards.values()) {
        await shard.client.connect();
      }
    } catch (err) {
      connectInFlight = false;
      app.log.error({ err }, "bybit ws: connect failed");
      closeBybitShards(true);
      rejectStreamWaiters("streams_connect_failed");
      scheduleReconnect({ reason: "connect_failed", eventLoopLagMs: lastEventLoopLagMs });
    }
  }

  function stopUpstreamHard() {
    desiredStreams = false;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const timer of shardReconnectTimers.values()) {
      clearTimeout(timer);
    }
    shardReconnectTimers.clear();
    shardReconnectAttempts.clear();

    connectInFlight = false;
    reconnectAttempt = 0;
    reconnectReason = "stopped";

    closeBybitShards(true);
    rejectStreamWaiters("streams_stopped");
    broadcastStreamsState();
  }

  awaitStreamsProvider = ({ timeoutMs, signal }: AwaitAllStreamsConnectedArgs) => {
    streamsEnabled = true;
    desiredStreams = true;
    broadcastStreamsState();
    void startUpstreamIfNeeded();

    if (streamsEnabled && bybitConnected) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = Math.max(1_000, Math.floor(timeoutMs || 0));
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (err: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer: setTimeout(() => {
          streamWaiters.delete(waiter);
          waiter.reject(new Error("streams_connect_timeout"));
        }, timeout),
      };
      const onAbort = () => {
        streamWaiters.delete(waiter);
        waiter.reject(new Error("start_cancelled"));
      };
      if (signal?.aborted) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("start_cancelled"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      streamWaiters.add(waiter);
      resolveStreamWaitersIfReady();
    });
  };

  streamLifecycleSyncProvider = () => {
    syncRuntimeStreamLifecycle();
    broadcastSnapshot();
  };

  function applySubscriptions(reason: string) {
    if (!streamsEnabled) return;

    app.log.info({ reason, universe: getEffectiveConfig().universe }, "apply subscriptions (reconnect bybit)");
    stopUpstreamHard();
    desiredStreams = true;
    void startUpstreamIfNeeded();
  }

  function toggleStreams() {
    const requirement = readCurrentStreamRequirement();
    if (requirement.shouldEnableStreams) {
      app.log.info({
        runtimeActive: requirement.runtimeActive,
        recorderMode: requirement.recorderMode,
        cvdMode: requirement.cvdMode,
        marketMode: requirement.marketMode,
      }, "streams toggle ignored because recorder/runtime requires active streams");
      syncRuntimeStreamLifecycle();
      broadcastSnapshot();
      return;
    }

    streamsEnabled = !streamsEnabled;

    app.log.info({ streamsEnabled }, "streams toggle");

    if (!streamsEnabled) {
      stopLiveUpdateAggregator();
      stopUpstreamHard();
      return;
    }

    desiredStreams = true;
    startLiveUpdateAggregator();
    broadcastStreamsState();
    void startUpstreamIfNeeded();
  }

  function onConfigChange(cfg: RuntimeConfig, meta: any) {
    const runtimeState = runtime.getStatus().sessionState;
    const pinned = isSessionPinned(runtimeState) && sessionConfigSnapshot != null;
    const effectiveCfg = pinned ? sessionConfigSnapshot! : cfg;
    clearShortRuntimeContextsCache();
    invalidateClientRowCaches();
    syncShortLongShortRatioPolling();
    const key = buildSymbolScopeKey(effectiveCfg);
    const recorderMode = minuteOiRecorder.getStatus().mode;
    const cvdMode = cvdRecorder.getStatus().mode;
    const marketMode = minuteMarketRecorder.getStatus().mode;
    const runtimeActive = runtimeState === "RUNNING" || runtimeState === "RESUMING";
    const subscriptionKey = computeSubscriptionKey(runtimeActive, recorderMode, cvdMode, marketMode);
    const changed = key !== lastUniverseKey || (!pinned && Boolean(meta?.universeChanged)) || subscriptionKey !== lastSubscriptionKey;

    if (!changed) return;

    lastUniverseKey = key;
    lastSubscriptionKey = subscriptionKey;

    if (universeApplyTimer) clearTimeout(universeApplyTimer);
    universeApplyTimer = setTimeout(() => {
      universeApplyTimer = null;
      // Reconnect bybit to apply new topic set
      applySubscriptions("config_change");
    }, 250);
  }

  configStore.on("change", onConfigChange);

  app.addHook("onReady", async () => {
    wss = new WebSocketServer({ server: app.server, path: "/ws" });
    if (minuteOiRecorder.getStatus().mode !== "off" || cvdRecorder.getStatus().mode !== "off" || minuteMarketRecorder.getStatus().mode !== "off") {
      await ensureRecorderSeededSymbols();
    }
    syncRuntimeStreamLifecycle();
    lastStreamGuardTickAt = Date.now();
    marketProcessTimer = setInterval(() => {
      flushPendingMarketData();
    }, MARKET_WS_PROCESS_INTERVAL_MS);
    streamGuardTimer = setInterval(() => {
      const guardNow = Date.now();
      lastEventLoopLagMs = Math.max(0, guardNow - lastStreamGuardTickAt - STREAM_GUARD_INTERVAL_MS);
      lastStreamGuardTickAt = guardNow;
      const requirement = readCurrentStreamRequirement();
      if (!requirement.shouldEnableStreams) return;
      if (streamsEnabled && desiredStreams && bybitConnected) {
        const staleThresholdMs = BYBIT_WS_STALE_MS + Math.min(lastEventLoopLagMs, EVENT_LOOP_LAG_STALE_GRACE_CAP_MS);
        const staleShard = getStaleShard(guardNow, staleThresholdMs);
        if (staleShard) {
          const staleMs = guardNow - Number(staleShard.lastMessageAtMs ?? 0);
          app.log.warn({
            shardKey: staleShard.key,
            topics: staleShard.topics.length,
            staleMs,
            staleThresholdMs,
            eventLoopLagMs: lastEventLoopLagMs,
            reconnectReason,
          }, "bybit ws: shard stale, forcing reconnect");
          scheduleReconnect({
            reason: `stale_${staleShard.key}`,
            shardKey: staleShard.key,
            staleMs,
            eventLoopLagMs: lastEventLoopLagMs,
          });
        } else if (lastEventLoopLagMs > 2_000 && guardNow - lastLagGraceIncidentAt > 30_000) {
          lastLagGraceIncidentAt = guardNow;
          appendBybitWsIncident({
            type: "stale_guard_skipped",
            reason: "event_loop_lag_grace",
            shardKey: null,
            staleMs: null,
            attempt: null,
            recoveredAt: null,
            delayMs: null,
            topics: null,
            eventLoopLagMs: lastEventLoopLagMs,
            fullReconnect: false,
          });
        }
        return;
      }
      syncRuntimeStreamLifecycle();
    }, STREAM_GUARD_INTERVAL_MS);
    broadcastSnapshot();

    wss.on("connection", (ws) => {
      clients.add(ws);
      clientEventsLimit.set(ws, 5);
      clientRowsDetail.set(ws, "preview");
      syncLiveUpdateAggregator();

      const now = nowMs();
      const st = runtime.getStatus();
      const rows = computeRowsForClient(now, "preview");
      const botStats = clientRowsCache?.rows === rows ? clientRowsCache.botStats : computeBotStats(rows);
      const { rows: availableWsRows, symbols: availableWsSymbols } = buildAvailableWsSnapshot();

      safeSend(ws, { type: "hello", serverTime: now });
      safeSend(ws, {
        type: "snapshot",
        payload: { sessionState: st.sessionState, sessionId: st.sessionId, runningSinceMs: st.runningSinceMs, rows, botStats, streamsEnabled, bybitConnected, ...getUniverseInfo(getEffectiveConfig()), availableWsSymbols, availableWsRows, optimizer: getOptimizerSnapshot() },
      });
      safeSend(ws, { type: "streams_state", payload: { streamsEnabled, bybitConnected } });

      sendEventsTail(ws, 5);

      ws.on("message", (buf) => {
        const raw = typeof buf === "string" ? buf : buf.toString("utf8");
        const msg = safeParseClientMsg(raw);
        if (!msg) return;

        if (msg.type === "events_tail_request") {
          const lim = Math.max(1, Math.min(100, Math.floor(msg.payload.limit)));
          clientEventsLimit.set(ws, lim);
          sendEventsTail(ws, lim);
          return;
        }

        if (msg.type === "rows_refresh_request") {
          const mode = msg.payload?.mode === "snapshot" ? "snapshot" : "tick";
          const detail = msg.payload?.detail === "full" ? "full" : "preview";
          clientRowsDetail.set(ws, detail);
          sendRowsToClient(ws, mode, detail);
          return;
        }

        if (msg.type === "streams_toggle_request") {
          toggleStreams();
          return;
        }

        if (msg.type === "streams_apply_subscriptions_request") {
          applySubscriptions("ws_request");
          return;
        }
      });

      ws.on("close", () => {
        clients.delete(ws);
        clientEventsLimit.delete(ws);
        clientRowsDetail.delete(ws);
        optimizerWsClients.delete(ws);
        syncLiveUpdateAggregator();
      });
      ws.on("error", () => {
        clients.delete(ws);
        clientEventsLimit.delete(ws);
        clientRowsDetail.delete(ws);
        optimizerWsClients.delete(ws);
        syncLiveUpdateAggregator();
      });

      optimizerWsClients.add(ws);
    });

    syncRuntimeStreamLifecycle();

    app.log.info("wsHub: /ws ready (dynamic universe via runtime config)");
  });

  app.addHook("onClose", async () => {
    awaitStreamsProvider = null;
    streamLifecycleSyncProvider = null;
    shortSignalsRowsSnapshotProvider = null;
    shortSignalEventCountSessionId = null;
    shortSignalEventCountBySymbol.clear();
    runtime.off("state", onRuntimeState);
    runtime.off("event", onRuntimeEvent);

    configStore.off("change", onConfigChange);

    if (universeApplyTimer) clearTimeout(universeApplyTimer);
    universeApplyTimer = null;
    if (streamGuardTimer) clearInterval(streamGuardTimer);
    streamGuardTimer = null;
    if (marketProcessTimer) clearInterval(marketProcessTimer);
    marketProcessTimer = null;
    if (longShortRatioTimer) clearInterval(longShortRatioTimer);
    longShortRatioTimer = null;

    flushPendingMarketData();

    stopLiveUpdateAggregator();

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    for (const timer of shardReconnectTimers.values()) clearTimeout(timer);
    shardReconnectTimers.clear();
    shardReconnectAttempts.clear();

    connectInFlight = false;
    reconnectAttempt = 0;
    reconnectReason = "closed";
    closeBybitShards(true);

    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });
}
