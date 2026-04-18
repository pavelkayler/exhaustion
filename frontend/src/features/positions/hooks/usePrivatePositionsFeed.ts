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
  trailingStop: number | null;
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
  entryBatch: string | null;
  entrySlot: number | null;
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

type ActionKeyMap = Record<string, true>;

const EMPTY_STATE: FeedState = {
  conn: "CONNECTING",
  status: "connecting",
  positions: [],
  orders: [],
  updatedAt: null,
  error: null,
};

const apiBase = getApiBase();

function toErrorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error ?? "unknown_error");
}

function pruneKeyMap(map: ActionKeyMap, activeKeys: Set<string>): ActionKeyMap {
  let changed = false;
  const next: ActionKeyMap = {};
  for (const key of Object.keys(map)) {
    if (activeKeys.has(key)) {
      next[key] = true;
      continue;
    }
    changed = true;
  }
  return changed ? next : map;
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
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
  return data as T;
}

async function requestRefresh(mode: "demo" | "real"): Promise<PositionsSnapshot> {
  return postJson<PositionsSnapshot>("/api/execution/refresh", { mode });
}

async function requestClosePositionMarket(
  mode: "demo" | "real",
  key: string,
): Promise<{ ok: true }> {
  return postJson<{ ok: true }>("/api/execution/positions/close-market", { mode, key });
}

async function requestCancelOrder(
  mode: "demo" | "real",
  key: string,
): Promise<{ ok: true }> {
  return postJson<{ ok: true }>("/api/execution/orders/cancel", { mode, key });
}

export function usePrivatePositionsFeed(mode: "demo" | "real") {
  const [state, setState] = useState<FeedState>(EMPTY_STATE);
  const [refreshing, setRefreshing] = useState(false);

  const [positionPendingKeys, setPositionPendingKeys] = useState<ActionKeyMap>({});
  const [positionFailedKeys, setPositionFailedKeys] = useState<ActionKeyMap>({});
  const [positionActionError, setPositionActionError] = useState<string | null>(null);

  const [orderPendingKeys, setOrderPendingKeys] = useState<ActionKeyMap>({});
  const [orderFailedKeys, setOrderFailedKeys] = useState<ActionKeyMap>({});
  const [orderActionError, setOrderActionError] = useState<string | null>(null);

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

  const closePositionMarket = useCallback(async (key: string) => {
    if (!key) return;

    setPositionActionError(null);
    setPositionPendingKeys((prev) => ({ ...prev, [key]: true }));
    setPositionFailedKeys((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      await requestClosePositionMarket(mode, key);
    } catch (error) {
      const message = toErrorMessage(error);
      setPositionPendingKeys((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setPositionFailedKeys((prev) => ({ ...prev, [key]: true }));
      setPositionActionError(message);
    }
  }, [mode]);

  const cancelOrder = useCallback(async (key: string) => {
    if (!key) return;

    setOrderActionError(null);
    setOrderPendingKeys((prev) => ({ ...prev, [key]: true }));
    setOrderFailedKeys((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      await requestCancelOrder(mode, key);
    } catch (error) {
      const message = toErrorMessage(error);
      setOrderPendingKeys((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setOrderFailedKeys((prev) => ({ ...prev, [key]: true }));
      setOrderActionError(message);
    }
  }, [mode]);

  useEffect(() => {
    setPositionPendingKeys({});
    setPositionFailedKeys({});
    setPositionActionError(null);
    setOrderPendingKeys({});
    setOrderFailedKeys({});
    setOrderActionError(null);
  }, [mode]);

  useEffect(() => {
    const activeKeys = new Set<string>(state.positions.map((row) => row.key));
    setPositionPendingKeys((prev) => pruneKeyMap(prev, activeKeys));
    setPositionFailedKeys((prev) => pruneKeyMap(prev, activeKeys));
  }, [state.positions]);

  useEffect(() => {
    const activeKeys = new Set<string>(state.orders.map((row) => row.key));
    setOrderPendingKeys((prev) => pruneKeyMap(prev, activeKeys));
    setOrderFailedKeys((prev) => pruneKeyMap(prev, activeKeys));
  }, [state.orders]);

  useEffect(() => {
    if (
      Object.keys(positionPendingKeys).length === 0
      && Object.keys(positionFailedKeys).length === 0
    ) {
      setPositionActionError(null);
    }
  }, [positionPendingKeys, positionFailedKeys]);

  useEffect(() => {
    if (
      Object.keys(orderPendingKeys).length === 0
      && Object.keys(orderFailedKeys).length === 0
    ) {
      setOrderActionError(null);
    }
  }, [orderPendingKeys, orderFailedKeys]);

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

  return {
    ...state,
    wsUrl,
    refreshing,
    refresh,
    closePositionMarket,
    cancelOrder,
    positionPendingKeys,
    positionFailedKeys,
    positionActionError,
    orderPendingKeys,
    orderFailedKeys,
    orderActionError,
  };
}
