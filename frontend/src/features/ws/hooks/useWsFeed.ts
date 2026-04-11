import { useCallback, useEffect, useState } from "react";
import { getWsUrl } from "../../../shared/config/env";
import type {
  AvailableWsSymbol,
  BotStats,
  ConnStatus,
  LogEvent,
  SessionState,
  StreamsState,
  SymbolRow,
  WsMessage,
} from "../../../shared/types/domain";
import { computeReconnectDelay } from "../utils/wsBackoff";
import { appendEventWithDedupe, dedupeEvents } from "../utils/eventDedupe";

type ClientWsMessage =
  | { type: "events_tail_request"; payload: { limit: number } }
  | { type: "rows_refresh_request"; payload?: { mode?: "tick" | "snapshot"; detail?: "full" | "preview" } }
  | { type: "streams_toggle_request" }
  | { type: "streams_apply_subscriptions_request" };

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

type WsFeedState = {
  conn: ConnStatus;
  rows: SymbolRow[];
  lastServerTime: number | null;
  lastMsg: string;
  wsSessionState: SessionState;
  wsSessionId: string | null;
  wsRunningSinceMs: number | null;
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
const listeners = new Set<(state: WsFeedState) => void>();
const liteListeners = new Set<(state: WsFeedState) => void>();
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let started = false;
let eventsLimit = 5;
let fullEmitTimer: number | null = null;
let liteEmitTimer: number | null = null;

let state: WsFeedState = {
  conn: "CONNECTING",
  rows: [],
  lastServerTime: null,
  lastMsg: "",
  wsSessionState: "STOPPED",
  wsSessionId: null,
  wsRunningSinceMs: null,
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

function connect(kind: "CONNECTING" | "RECONNECTING") {
  patchState({ conn: kind });
  const nextWs = new WebSocket(wsUrl);
  ws = nextWs;

  nextWs.onopen = () => {
    if (ws !== nextWs) return;
    reconnectAttempt = 0;
    patchState({ conn: "CONNECTED" });
    send({ type: "events_tail_request", payload: { limit: eventsLimit } });
    if (listeners.size > 0) {
      send({ type: "rows_refresh_request", payload: { mode: "snapshot", detail: "full" } });
    }
  };

  nextWs.onmessage = (e) => {
    if (ws !== nextWs) return;
    const raw = String(e.data);
    patchState({ lastMsg: raw });

    try {
      const msg = JSON.parse(raw) as WsMessage;

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
          wsRunningSinceMs: Number(snapshotPayload.runningSinceMs ?? 0) > 0 ? Number(snapshotPayload.runningSinceMs) : null,
          rows: Array.isArray(snapshotRows) ? snapshotRows : [],
          streams: {
            streamsEnabled: snapshotPayload.streamsEnabled,
            bybitConnected: snapshotPayload.bybitConnected,
          },
          universeSelectedId: snapshotPayload.universeSelectedId ?? "",
          universeSymbolsCount: Number(snapshotPayload.universeSymbolsCount ?? 0),
          availableWsSymbols: Array.isArray(snapshotPayload.availableWsSymbols) ? snapshotPayload.availableWsSymbols : [],
          availableWsRows: Array.isArray(snapshotPayload.availableWsRows) ? snapshotPayload.availableWsRows : [],
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
          availableWsSymbols: Array.isArray(tickPayload.availableWsSymbols) ? tickPayload.availableWsSymbols : [],
          availableWsRows: Array.isArray(tickPayload.availableWsRows) ? tickPayload.availableWsRows : [],
          botStats: tickPayload.botStats ?? EMPTY_BOT_STATS,
        });
        return;
      }

      if (msg.type === "streams_state") {
        patchState({ streams: msg.payload });
        return;
      }

      if (msg.type === "events_tail") {
        patchState({ events: dedupeEvents(msg.payload.events ?? [], eventsLimit) });
        return;
      }

      if (msg.type === "events_append") {
        const ev = msg.payload.event;
        patchState({
          events: appendEventWithDedupe(state.events, ev, eventsLimit),
          eventStream: appendEventWithDedupe(state.eventStream, ev, EVENT_STREAM_MAX),
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
    wsUrl,
    streams: localState.streams,
    universeSelectedId: localState.universeSelectedId,
    universeSymbolsCount: localState.universeSymbolsCount,
    availableWsSymbols: localState.availableWsSymbols,
  };
}

export function useWsFeed() {
  const [localState, setLocalState] = useState<WsFeedState>(state);

  useEffect(() => {
    ensureStarted();
    listeners.add(setLocalState);
    setLocalState(state);
    send({ type: "rows_refresh_request", payload: { mode: "snapshot", detail: "full" } });
    return () => {
      listeners.delete(setLocalState);
      if (listeners.size === 0) {
        send({ type: "rows_refresh_request", payload: { mode: "snapshot", detail: "preview" } });
      }
    };
  }, []);

  const requestEventsTail = useCallback((limit: number) => {
    const lim = Math.max(1, Math.min(100, Math.floor(limit)));
    eventsLimit = lim;
    send({ type: "events_tail_request", payload: { limit: lim } });
  }, []);

  const requestRowsRefresh = useCallback((mode: "tick" | "snapshot" = "tick") => {
    send({ type: "rows_refresh_request", payload: { mode, detail: "full" } });
  }, []);

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
