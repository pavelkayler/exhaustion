import { useEffect, useMemo, useState } from "react";
import { getPrivatePositionsWsUrl } from "../../../shared/config/env";

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

type PrivateExecutionMessage =
  | {
      type: "hello" | "execution_snapshot";
      payload: {
        mode: "demo" | "real";
        status: ExecutionFeedStatus;
        updatedAt: number | null;
        positions: ExecutionPositionRow[];
        orders: ExecutionOrderRow[];
        error?: string | null;
      };
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

export function usePrivatePositionsFeed(mode: "demo" | "real") {
  const [state, setState] = useState<FeedState>(EMPTY_STATE);

  const wsUrl = useMemo(() => getPrivatePositionsWsUrl(mode), [mode]);

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
          setState({
            conn: "CONNECTED",
            status: msg.payload.status,
            positions: Array.isArray(msg.payload.positions) ? msg.payload.positions : [],
            orders: Array.isArray(msg.payload.orders) ? msg.payload.orders : [],
            updatedAt: msg.payload.updatedAt ?? null,
            error: msg.payload.error ?? null,
          });
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
  }, [wsUrl]);

  return { ...state, wsUrl };
}
