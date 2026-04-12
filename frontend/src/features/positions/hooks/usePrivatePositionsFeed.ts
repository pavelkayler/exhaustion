
import { useCallback, useEffect, useMemo, useState } from "react";
import { getApiBase, getPrivatePositionsWsUrl } from "../../../shared/config/env";

export type ExecutionReason = "manual" | "candidate" | "final";

export type ExecutionPositionRow = {
  key: string;
  symbol: string;
  reason: ExecutionReason;
  value: number | null;
  pnl: number | null;
  tp: number | null;
  sl: number | null;
  side: string | null;
  size: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  updatedAt: number | null;
};

export type ExecutionOrderRow = {
  key: string;
  symbol: string;
  reason: ExecutionReason;
  value: number | null;
  margin: number | null;
  leverage: number | null;
  entryPrice: number | null;
  placedAt: number | null;
  updatedAt: number | null;
};

type ExecutionFeedStatus =
  | "connecting"
  | "authenticating"
  | "subscribing"
  | "connected"
  | "reconnecting"
  | "missing_credentials"
  | "error";

type PositionsSnapshot = {
  mode: "demo" | "real";
  status: ExecutionFeedStatus;
  updatedAt: number | null;
  positions: ExecutionPositionRow[];
  orders: ExecutionOrderRow[];
  error?: string | null;
};

type PrivateExecutionMessage =
  | {
      type: "hello" | "execution_snapshot";
      payload: PositionsSnapshot;
    }
  | { type: "error"; message: string };

type FeedState = {
  conn: "CONNECTING" | "CONNECTED" | "DISCONNECTED";
  status: ExecutionFeedStatus;
  positions: ExecutionPositionRow[];
  orders: ExecutionOrderRow[];
  updatedAt: number | null;
  error: string | null;
};

const EMPTY_STATE: FeedState = {
  conn: "CONNECTING",
  status: "connecting",
  positions: [],
  orders: [],
  updatedAt: null,
  error: null,
};

const apiBase = getApiBase();

async function requestRefresh(mode: "demo" | "real"): Promise<PositionsSnapshot> {
  const response = await fetch(`${apiBase}/api/execution/refresh`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode }),
  });
  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(
      String(
        (data as { error?: unknown; message?: unknown } | null)?.message
        ?? (data as { error?: unknown } | null)?.error
        ?? `${response.status} ${response.statusText}`,
      ),
    );
  }
  return data as PositionsSnapshot;
}

export function usePrivatePositionsFeed(mode: "demo" | "real") {
  const [state, setState] = useState<FeedState>(EMPTY_STATE);
  const [refreshing, setRefreshing] = useState(false);

  const wsUrl = useMemo(() => getPrivatePositionsWsUrl(mode), [mode]);

  const applySnapshot = useCallback((payload: PositionsSnapshot) => {
    setState({
      conn: "CONNECTED",
      status: payload.status,
      positions: Array.isArray(payload.positions) ? payload.positions : [],
      orders: Array.isArray(payload.orders) ? payload.orders : [],
      updatedAt: payload.updatedAt ?? null,
      error: payload.error ?? null,
    });
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const snapshot = await requestRefresh(mode);
      applySnapshot(snapshot);
    } finally {
      setRefreshing(false);
    }
  }, [applySnapshot, mode]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = (kind: "CONNECTING" | "DISCONNECTED" = "CONNECTING") => {
      if (!active) return;

      setState((prev) => ({
        ...prev,
        conn: kind === "CONNECTING" ? "CONNECTING" : "DISCONNECTED",
        status: kind === "CONNECTING" ? "connecting" : "reconnecting",
      }));

      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        if (!active) return;
        setState((prev) => ({ ...prev, conn: "CONNECTED", error: null }));
      };

      socket.onmessage = (event) => {
        if (!active) return;
        try {
          const msg = JSON.parse(String(event.data)) as PrivateExecutionMessage;
          if (msg.type === "error") {
            setState((prev) => ({ ...prev, error: msg.message }));
            return;
          }
          applySnapshot(msg.payload);
        } catch (error) {
          setState((prev) => ({
            ...prev,
            error: String((error as Error)?.message ?? error),
          }));
        }
      };

      socket.onclose = () => {
        if (!active) return;
        if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => connect("DISCONNECTED"), 2_000);
      };

      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          return;
        }
      };
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      try {
        socket?.close();
      } catch {
        return;
      }
    };
  }, [applySnapshot, wsUrl]);

  return { ...state, wsUrl, refreshing, refresh };
}
