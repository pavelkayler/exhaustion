import { useCallback, useEffect, useState } from "react";
import { getApiBase, getWsUrl } from "../../../shared/config/env";
import type {
  AvailableWsSymbol,
  BotStats,
  ConnStatus,
  LogEvent,
  SessionState,
  ShortSignalRowsFilter,
  StreamsState,
  SymbolRow,
  WsMessage,
  WsRpcAction,
} from "../../../shared/types/domain";
import { computeReconnectDelay } from "../utils/wsBackoff";
import { appendEventWithDedupe, dedupeEvents } from "../utils/eventDedupe";

type RowsDetail = "full" | "preview" | "signals";

type ClientWsMessage =
  | { type: "events_tail_request"; payload: { limit: number } }
  | {
      type: "rows_refresh_request";
      payload?: {
        mode?: "tick" | "snapshot";
        detail?: RowsDetail;
        shortSignalFilters?: ShortSignalRowsFilter;
      };
    }
  | { type: "streams_toggle_request" }
  | { type: "streams_apply_subscriptions_request" }
  | { type: "rpc_request"; id: string; action: WsRpcAction; payload?: unknown };

type PendingRpcRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: number;
};

type RpcSupportState = "unknown" | "supported" | "unsupported";

const EMPTY_BOT_STATS: BotStats = {
  openPositions: 0,
  pendingOrders: 0,
  unrealizedPnl: 0,
  closedTrades: 0,
  wins: 0,
  losses: 0,
  netRealized: 0,
  feesPaid: 0,
  fundingAccrued: 0,
  executionMode: "paper",
};

const EVENT_STREAM_MAX = 1000;
const RPC_TIMEOUT_MS = 15_000;
const RPC_PROBE_TIMEOUT_MS = 700;
const DEFAULT_SHORT_SIGNAL_ROWS_FILTER: ShortSignalRowsFilter = {
  showRejected: true,
  showCandidate: true,
  showWatchlist: true,
  showFinal: true,
};

type WsFeedState = {
  conn: ConnStatus;
  rows: SymbolRow[];
  lastServerTime: number | null;
  lastMsg: string;
  wsSessionState: SessionState;
  wsSessionId: string | null;
  wsRunningSinceMs: number | null;
  wsRuntimeMessage: string | null;
  wsRunningBotId: string | null;
  wsRunningBotName: string | null;
  wsEventsFile: string | null;
  streams: StreamsState;
  universeSelectedId: string;
  universeSymbolsCount: number;
  availableWsSymbols: string[];
  availableWsRows: AvailableWsSymbol[];
  botStats: BotStats;
  events: LogEvent[];
  eventStream: LogEvent[];
};

type SnapshotPayload = Extract<WsMessage, { type: "snapshot" }>["payload"];
type TickPayload = Extract<WsMessage, { type: "tick" }>["payload"];

const wsUrl = getWsUrl();
const apiBase = getApiBase();
const listeners = new Set<(state: WsFeedState) => void>();
const liteListeners = new Set<(state: WsFeedState) => void>();
const pendingRpcRequests = new Map<string, PendingRpcRequest>();
const openWaiters = new Set<() => void>();
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let started = false;
let eventsLimit = 5;
let fullEmitTimer: number | null = null;
let liteEmitTimer: number | null = null;
let nextRpcId = 1;
let rpcSupportState: RpcSupportState = "unknown";
let rpcProbePromise: Promise<boolean> | null = null;
let currentRowsRequest: {
  detail: RowsDetail;
  shortSignalFilters?: ShortSignalRowsFilter;
} = {
  detail: "full",
};

let state: WsFeedState = {
  conn: "CONNECTING",
  rows: [],
  lastServerTime: null,
  lastMsg: "",
  wsSessionState: "STOPPED",
  wsSessionId: null,
  wsRunningSinceMs: null,
  wsRuntimeMessage: null,
  wsRunningBotId: null,
  wsRunningBotName: null,
  wsEventsFile: null,
  streams: { streamsEnabled: true, bybitConnected: false },
  universeSelectedId: "",
  universeSymbolsCount: 0,
  availableWsSymbols: [],
  availableWsRows: [],
  botStats: EMPTY_BOT_STATS,
  events: [],
  eventStream: [],
};

function emitFull() {
  for (const listener of listeners) listener(state);
}

function emitLite() {
  for (const listener of liteListeners) listener(state);
}

function scheduleFullEmit() {
  if (fullEmitTimer != null) return;
  fullEmitTimer = window.setTimeout(() => {
    fullEmitTimer = null;
    emitFull();
  }, 180);
}

function scheduleLiteEmit() {
  if (liteEmitTimer != null) return;
  liteEmitTimer = window.setTimeout(() => {
    liteEmitTimer = null;
    emitLite();
  }, 250);
}

function patchState(patch: Partial<WsFeedState>) {
  const prev = state;
  state = { ...state, ...patch };

  const fullChanged =
    prev.conn !== state.conn ||
    prev.rows !== state.rows ||
    prev.lastServerTime !== state.lastServerTime ||
    prev.lastMsg !== state.lastMsg ||
    prev.wsSessionState !== state.wsSessionState ||
    prev.wsSessionId !== state.wsSessionId ||
    prev.wsRunningSinceMs !== state.wsRunningSinceMs ||
    prev.wsRuntimeMessage !== state.wsRuntimeMessage ||
    prev.wsRunningBotId !== state.wsRunningBotId ||
    prev.wsRunningBotName !== state.wsRunningBotName ||
    prev.wsEventsFile !== state.wsEventsFile ||
    prev.streams !== state.streams ||
    prev.universeSelectedId !== state.universeSelectedId ||
    prev.universeSymbolsCount !== state.universeSymbolsCount ||
    prev.availableWsSymbols !== state.availableWsSymbols ||
    prev.availableWsRows !== state.availableWsRows ||
    prev.botStats !== state.botStats ||
    prev.events !== state.events ||
    prev.eventStream !== state.eventStream;

  if (fullChanged) scheduleFullEmit();

  const liteChanged =
    prev.conn !== state.conn ||
    prev.lastServerTime !== state.lastServerTime ||
    prev.wsSessionState !== state.wsSessionState ||
    prev.wsSessionId !== state.wsSessionId ||
    prev.wsRunningSinceMs !== state.wsRunningSinceMs ||
    prev.wsRuntimeMessage !== state.wsRuntimeMessage ||
    prev.wsRunningBotId !== state.wsRunningBotId ||
    prev.wsRunningBotName !== state.wsRunningBotName ||
    prev.wsEventsFile !== state.wsEventsFile ||
    prev.streams !== state.streams ||
    prev.universeSelectedId !== state.universeSelectedId ||
    prev.universeSymbolsCount !== state.universeSymbolsCount ||
    prev.availableWsSymbols !== state.availableWsSymbols;

  if (liteChanged) scheduleLiteEmit();
}

function send(msg: ClientWsMessage) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  } catch {
    return;
  }
}

function setCurrentRowsRequest(args?: {
  detail?: RowsDetail;
  shortSignalFilters?: ShortSignalRowsFilter;
}) {
  const detail = args?.detail ?? currentRowsRequest.detail ?? "full";
  currentRowsRequest = {
    detail,
    ...(detail === "signals"
      ? {
          shortSignalFilters: {
            ...DEFAULT_SHORT_SIGNAL_ROWS_FILTER,
            ...(args?.shortSignalFilters ?? currentRowsRequest.shortSignalFilters ?? {}),
          },
        }
      : {}),
  };
}

function sendCurrentRowsRequest(mode: "tick" | "snapshot" = "snapshot") {
  send({
    type: "rows_refresh_request",
    payload: {
      mode,
      detail: currentRowsRequest.detail,
      ...(currentRowsRequest.detail === "signals" && currentRowsRequest.shortSignalFilters
        ? { shortSignalFilters: currentRowsRequest.shortSignalFilters }
        : {}),
    },
  });
}

function flushOpenWaiters() {
  if (openWaiters.size === 0) return;
  const queued = Array.from(openWaiters);
  openWaiters.clear();
  for (const callback of queued) {
    try {
      callback();
    } catch {
      continue;
    }
  }
}

function makeRpcId(): string {
  return `rpc_${Date.now()}_${nextRpcId++}`;
}

function sendRpcRequest<T>(
  action: WsRpcAction,
  payload?: unknown,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
  ensureStarted();
  return new Promise<T>((resolve, reject) => {
    const id = makeRpcId();

    const timer = window.setTimeout(() => {
      pendingRpcRequests.delete(id);
      openWaiters.delete(sendRequest);
      reject(new Error(`${action}_timeout`));
    }, timeoutMs);

    const sendRequest = () => {
      if (!pendingRpcRequests.has(id)) return;
      send({
        type: "rpc_request",
        id,
        action,
        ...(payload !== undefined ? { payload } : {}),
      });
    };

    pendingRpcRequests.set(id, { resolve, reject, timer });

    if (ws && ws.readyState === WebSocket.OPEN) {
      sendRequest();
      return;
    }

    openWaiters.add(sendRequest);
  });
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(
      String(
        (data as { error?: unknown; message?: unknown } | null)?.message ??
          (data as { error?: unknown } | null)?.error ??
          `${response.status} ${response.statusText}`,
      ),
    ) as Error & { payload?: unknown; status?: number };
    error.payload = data;
    error.status = response.status;
    throw error;
  }

  return data as T;
}

async function httpFallbackRpc<T>(
  action: WsRpcAction,
  payload?: unknown,
): Promise<T> {
  switch (action) {
    case "session.status":
      return httpJson<T>(`${apiBase}/api/session/status`);

    case "session.start":
      return httpJson<T>(`${apiBase}/api/session/start`, {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      });

    case "session.stop":
      return httpJson<T>(`${apiBase}/api/session/stop`, {
        method: "POST",
        body: JSON.stringify({}),
      });

    case "session.pause":
      return httpJson<T>(`${apiBase}/api/session/pause`, {
        method: "POST",
        body: JSON.stringify({}),
      });

    case "session.resume":
      return httpJson<T>(`${apiBase}/api/session/resume`, {
        method: "POST",
        body: JSON.stringify({}),
      });

    case "config.get":
      return httpJson<T>(`${apiBase}/api/config`);

    case "config.update":
      return httpJson<T>(`${apiBase}/api/config`, {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      });

    case "manual_order.submit":
      return httpJson<T>(`${apiBase}/api/manual-test-order`, {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      });

    default:
      throw new Error(`unsupported_rpc_action:${action}`);
  }
}

async function ensureRpcCapability(): Promise<boolean> {
  if (rpcSupportState === "supported") return true;
  if (rpcSupportState === "unsupported") return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (rpcProbePromise) return rpcProbePromise;

  rpcProbePromise = (async () => {
    try {
      await sendRpcRequest("session.status", undefined, RPC_PROBE_TIMEOUT_MS);
      rpcSupportState = "supported";
      return true;
    } catch {
      rpcSupportState = "unsupported";
      return false;
    } finally {
      rpcProbePromise = null;
    }
  })();

  return rpcProbePromise;
}

function connect(kind: "CONNECTING" | "RECONNECTING") {
  patchState({ conn: kind });
  const nextWs = new WebSocket(wsUrl);
  ws = nextWs;

  nextWs.onopen = () => {
    if (ws !== nextWs) return;
    reconnectAttempt = 0;
    rpcSupportState = "unknown";
    patchState({ conn: "CONNECTED" });
    send({ type: "events_tail_request", payload: { limit: eventsLimit } });
    if (listeners.size > 0) {
      sendCurrentRowsRequest("snapshot");
    }
    flushOpenWaiters();
  };

  nextWs.onmessage = (e) => {
    if (ws !== nextWs) return;
    const raw = String(e.data);
    patchState({ lastMsg: raw });

    try {
      const msg = JSON.parse(raw) as WsMessage;

      if (msg.type === "rpc_result") {
        rpcSupportState = "supported";
        const pending = pendingRpcRequests.get(msg.id);
        if (!pending) return;
        pendingRpcRequests.delete(msg.id);
        window.clearTimeout(pending.timer);
        if (!msg.ok) {
          const error = new Error(msg.error ?? `${msg.action}_failed`) as Error & {
            payload?: unknown;
            action?: string;
          };
          error.payload = msg.payload;
          error.action = msg.action;
          pending.reject(error);
          return;
        }
        pending.resolve(msg.payload);
        return;
      }

      if (msg.type === "hello") {
        patchState({ lastServerTime: msg.serverTime });
        return;
      }

      if (msg.type === "snapshot") {
        const snapshotPayload: SnapshotPayload = msg.payload;
        const snapshotRows = snapshotPayload.rows;
        patchState({
          wsSessionState: snapshotPayload.sessionState,
          wsSessionId: snapshotPayload.sessionId ?? null,
          wsRunningSinceMs:
            Number(snapshotPayload.runningSinceMs ?? 0) > 0
              ? Number(snapshotPayload.runningSinceMs)
              : null,
          wsRuntimeMessage: snapshotPayload.runtimeMessage ?? null,
          wsRunningBotId: snapshotPayload.runningBotId ?? null,
          wsRunningBotName: snapshotPayload.runningBotName ?? null,
          wsEventsFile: snapshotPayload.eventsFile ?? null,
          rows: Array.isArray(snapshotRows) ? snapshotRows : [],
          streams: {
            streamsEnabled: snapshotPayload.streamsEnabled,
            bybitConnected: snapshotPayload.bybitConnected,
          },
          universeSelectedId: snapshotPayload.universeSelectedId ?? "",
          universeSymbolsCount: Number(snapshotPayload.universeSymbolsCount ?? 0),
          availableWsSymbols: Array.isArray(snapshotPayload.availableWsSymbols)
            ? snapshotPayload.availableWsSymbols
            : [],
          availableWsRows: Array.isArray(snapshotPayload.availableWsRows)
            ? snapshotPayload.availableWsRows
            : [],
          botStats: snapshotPayload.botStats ?? EMPTY_BOT_STATS,
        });
        return;
      }

      if (msg.type === "tick") {
        const tickPayload: TickPayload = msg.payload;
        const tickRows = tickPayload.rows;
        patchState({
          lastServerTime: tickPayload.serverTime,
          rows: Array.isArray(tickRows) ? tickRows : [],
          universeSelectedId: tickPayload.universeSelectedId ?? "",
          universeSymbolsCount: Number(tickPayload.universeSymbolsCount ?? 0),
          availableWsSymbols: Array.isArray(tickPayload.availableWsSymbols)
            ? tickPayload.availableWsSymbols
            : [],
          availableWsRows: Array.isArray(tickPayload.availableWsRows)
            ? tickPayload.availableWsRows
            : [],
          botStats: tickPayload.botStats ?? EMPTY_BOT_STATS,
        });
        return;
      }

      if (msg.type === "streams_state") {
        patchState({ streams: msg.payload });
        return;
      }

      if (msg.type === "events_tail") {
        patchState({
          events: dedupeEvents(msg.payload.events ?? [], eventsLimit),
        });
        return;
      }

      if (msg.type === "events_append") {
        const ev = msg.payload.event;
        patchState({
          events: appendEventWithDedupe(state.events, ev, eventsLimit),
          eventStream: appendEventWithDedupe(
            state.eventStream,
            ev,
            EVENT_STREAM_MAX,
          ),
        });
        return;
      }

      if (msg.type === "error") {
        console.error("WS error:", msg.message);
      }
    } catch {
      return;
    }
  };

  nextWs.onclose = () => {
    if (ws !== nextWs) return;
    patchState({ conn: "DISCONNECTED" });
    rpcSupportState = "unknown";
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectAttempt += 1;
    const delay = computeReconnectDelay(reconnectAttempt);
    reconnectTimer = window.setTimeout(() => connect("RECONNECTING"), delay);
  };

  nextWs.onerror = () => {
    if (ws !== nextWs) return;
    try {
      nextWs.close();
    } catch {
      return;
    }
  };
}

function ensureStarted() {
  if (started) return;
  started = true;
  connect("CONNECTING");
}

export async function requestWsRpc<T>(
  action: WsRpcAction,
  payload?: unknown,
  options?: { timeoutMs?: number },
): Promise<T> {
  ensureStarted();

  const canUseNativeRpc =
    ws &&
    ws.readyState === WebSocket.OPEN &&
    (rpcSupportState === "supported" || (await ensureRpcCapability()));

  if (canUseNativeRpc) {
    return sendRpcRequest<T>(
      action,
      payload,
      Math.max(1_000, Math.floor(Number(options?.timeoutMs ?? RPC_TIMEOUT_MS))),
    );
  }

  return httpFallbackRpc<T>(action, payload);
}

export function useWsFeedLite() {
  const [localState, setLocalState] = useState<WsFeedState>(state);

  useEffect(() => {
    ensureStarted();
    liteListeners.add(setLocalState);
    setLocalState(state);
    return () => {
      liteListeners.delete(setLocalState);
    };
  }, []);

  return {
    conn: localState.conn,
    lastServerTime: localState.lastServerTime,
    wsSessionState: localState.wsSessionState,
    wsSessionId: localState.wsSessionId,
    wsRunningSinceMs: localState.wsRunningSinceMs,
    wsRuntimeMessage: localState.wsRuntimeMessage,
    wsRunningBotId: localState.wsRunningBotId,
    wsRunningBotName: localState.wsRunningBotName,
    wsEventsFile: localState.wsEventsFile,
    wsUrl,
    streams: localState.streams,
    universeSelectedId: localState.universeSelectedId,
    universeSymbolsCount: localState.universeSymbolsCount,
    availableWsSymbols: localState.availableWsSymbols,
  };
}

export function useWsFeed(options?: {
  initialRowsRequest?: {
    detail?: RowsDetail;
    shortSignalFilters?: ShortSignalRowsFilter;
  };
}) {
  const [localState, setLocalState] = useState<WsFeedState>(state);

  useEffect(() => {
    ensureStarted();
    listeners.add(setLocalState);
    setLocalState(state);
    setCurrentRowsRequest(options?.initialRowsRequest ?? { detail: "full" });
    sendCurrentRowsRequest("snapshot");
    return () => {
      listeners.delete(setLocalState);
      if (listeners.size === 0) {
        setCurrentRowsRequest({ detail: "preview" });
        sendCurrentRowsRequest("snapshot");
      }
    };
  }, []);

  const requestEventsTail = useCallback((limit: number) => {
    const lim = Math.max(1, Math.min(100, Math.floor(limit)));
    eventsLimit = lim;
    send({ type: "events_tail_request", payload: { limit: lim } });
  }, []);

  const requestRowsRefresh = useCallback(
    (
      mode: "tick" | "snapshot" = "tick",
      options?: {
        detail?: RowsDetail;
        shortSignalFilters?: ShortSignalRowsFilter;
      },
    ) => {
      if (options) {
        setCurrentRowsRequest(options);
      }
      sendCurrentRowsRequest(mode);
    },
    [],
  );

  const toggleStreams = useCallback(() => {
    send({ type: "streams_toggle_request" });
  }, []);

  const applySubscriptions = useCallback(() => {
    send({ type: "streams_apply_subscriptions_request" });
  }, []);

  return {
    conn: localState.conn,
    rows: localState.rows,
    lastServerTime: localState.lastServerTime,
    lastMsg: localState.lastMsg,
    wsSessionState: localState.wsSessionState,
    wsSessionId: localState.wsSessionId,
    wsRunningSinceMs: localState.wsRunningSinceMs,
    wsRuntimeMessage: localState.wsRuntimeMessage,
    wsRunningBotId: localState.wsRunningBotId,
    wsRunningBotName: localState.wsRunningBotName,
    wsEventsFile: localState.wsEventsFile,
    wsUrl,

    streams: localState.streams,
    toggleStreams,
    applySubscriptions,

    universeSelectedId: localState.universeSelectedId,
    universeSymbolsCount: localState.universeSymbolsCount,
    availableWsSymbols: localState.availableWsSymbols,
    availableWsRows: localState.availableWsRows,

    botStats: localState.botStats,

    events: localState.events,
    eventStream: localState.eventStream,
    requestEventsTail,
    requestRowsRefresh,
  };
}
