import { createHmac } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { BybitDemoRestClient } from "../bybit/BybitDemoRestClient.js";
import { BybitRealRestClient } from "../bybit/BybitRealRestClient.js";

type ExecutionMode = "demo" | "real";
type ExecutionPositionReason = "manual" | "candidate" | "final";

type FeedStatus =
  | "connecting"
  | "authenticating"
  | "subscribing"
  | "connected"
  | "reconnecting"
  | "missing_credentials"
  | "error";

type ExecutionPositionRow = {
  key: string;
  symbol: string;
  reason: ExecutionPositionReason;
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

type PositionsSnapshot = {
  mode: ExecutionMode;
  status: FeedStatus;
  updatedAt: number | null;
  rows: ExecutionPositionRow[];
  error: string | null;
};

type ServerMessage =
  | { type: "hello"; payload: PositionsSnapshot }
  | { type: "positions_snapshot"; payload: PositionsSnapshot }
  | { type: "error"; message: string };

type PositionsSeedClient = {
  hasCredentials(): boolean;
  getPositionsLinear(params?: {
    symbol?: string;
    settleCoin?: string;
  }): Promise<{ list: Array<Record<string, unknown>> }>;
};

const POSITIONS_WS_PATH = "/ws/private-positions";
const PRIVATE_WS_PING_INTERVAL_MS = 20_000;
const CLIENT_BROADCAST_INTERVAL_MS = 1_000;

function normalizeMode(value: unknown): ExecutionMode {
  return String(value ?? "").trim().toLowerCase() === "real" ? "real" : "demo";
}

function readNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readPositiveNumber(value: unknown): number | null {
  const numeric = readNumber(value);
  return numeric != null && numeric > 0 ? numeric : null;
}

function inferPositionReason(row: Record<string, unknown>): ExecutionPositionReason {
  const directReason = String(row.reason ?? row.openReason ?? row.positionReason ?? "")
    .trim()
    .toLowerCase();

  if (directReason === "candidate" || directReason === "final" || directReason === "manual") {
    return directReason;
  }

  const orderLinkId = String(row.orderLinkId ?? row.positionLinkId ?? "")
    .trim()
    .toLowerCase();
  if (orderLinkId.includes("candidate")) return "candidate";
  if (orderLinkId.includes("final")) return "final";

  return "manual";
}

function toPositionKey(row: Record<string, unknown>): string {
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  const positionIdx = String(row.positionIdx ?? "0").trim() || "0";
  const side = String(row.side ?? "").trim().toUpperCase() || "NONE";
  return `${symbol}:${positionIdx}:${side}`;
}

function normalizePositionRow(
  row: Record<string, unknown>,
): ExecutionPositionRow | null {
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  const key = toPositionKey(row);
  const side = String(row.side ?? "").trim().toUpperCase();
  const size = Math.abs(Number(row.size ?? 0));

  if (!symbol || !Number.isFinite(size) || size <= 0 || !side || side === "NONE") {
    return null;
  }

  return {
    key,
    symbol,
    reason: inferPositionReason(row),
    value: readNumber(row.positionValue ?? row.positionBalance ?? row.positionIM),
    pnl: readNumber(row.unrealisedPnl),
    tp: readPositiveNumber(row.takeProfit),
    sl: readPositiveNumber(row.stopLoss),
    side,
    size,
    entryPrice: readPositiveNumber(row.avgPrice),
    markPrice: readPositiveNumber(row.markPrice),
    updatedAt: readNumber(row.updatedTime) ?? Date.now(),
  };
}

function safeSend(ws: WebSocket, body: ServerMessage): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(body));
    }
  } catch {
    return;
  }
}

class BybitPrivatePositionsStream {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private shouldRun = false;
  private status: FeedStatus;
  private updatedAt: number | null = null;
  private error: string | null = null;
  private positions = new Map<string, ExecutionPositionRow>();
  private seedInFlight = false;

  constructor(
    private readonly mode: ExecutionMode,
    private readonly logger: FastifyBaseLogger,
    private readonly wsUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly seedClient: PositionsSeedClient | null,
  ) {
    this.status = this.hasCredentials() ? "connecting" : "missing_credentials";
  }

  hasCredentials(): boolean {
    return this.apiKey.trim().length > 0 && this.apiSecret.trim().length > 0;
  }

  getSnapshot(): PositionsSnapshot {
    return {
      mode: this.mode,
      status: this.status,
      updatedAt: this.updatedAt,
      error: this.error,
      rows: Array.from(this.positions.values()).sort((left, right) => {
        const symbolCmp = left.symbol.localeCompare(right.symbol);
        if (symbolCmp !== 0) return symbolCmp;
        return left.key.localeCompare(right.key);
      }),
    };
  }

  ensureStarted(): void {
    if (!this.hasCredentials()) {
      this.status = "missing_credentials";
      this.error = "missing_credentials";
      return;
    }
    if (this.shouldRun) return;
    this.shouldRun = true;
    void this.seedFromRest("ensure_started");
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    try {
      this.ws?.close();
    } catch {
      return;
    } finally {
      this.ws = null;
    }
  }

  private async seedFromRest(reason: string): Promise<void> {
    if (!this.shouldRun) return;
    if (!this.seedClient || !this.seedClient.hasCredentials()) return;
    if (this.seedInFlight) return;

    this.seedInFlight = true;
    try {
      const response = await this.seedClient.getPositionsLinear({ settleCoin: "USDT" });
      const rows = Array.isArray(response?.list) ? response.list : [];

      const next = new Map<string, ExecutionPositionRow>();
      for (const item of rows) {
        if (!item || typeof item !== "object") continue;
        const normalized = normalizePositionRow(item);
        if (!normalized) continue;
        next.set(normalized.key, normalized);
      }

      this.positions = next;
      this.updatedAt = Date.now();
      this.error = null;

      this.logger.info(
        {
          mode: this.mode,
          reason,
          rows: next.size,
        },
        "private positions seed synced",
      );
    } catch (error) {
      this.logger.warn(
        {
          mode: this.mode,
          reason,
          error: String((error as Error)?.message ?? error),
        },
        "private positions seed failed",
      );
    } finally {
      this.seedInFlight = false;
    }
  }

  private connect(): void {
    if (!this.shouldRun || !this.hasCredentials()) return;

    this.positions.clear();
    this.updatedAt = null;
    this.error = null;
    this.status = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";

    const socket = new WebSocket(this.wsUrl);
    this.ws = socket;

    socket.on("open", () => {
      if (this.ws !== socket) return;
      this.status = "authenticating";
      this.error = null;
      this.reconnectAttempt = 0;

      const expires = Date.now() + 10_000;
      const signature = createHmac("sha256", this.apiSecret)
        .update(`GET/realtime${expires}`)
        .digest("hex");

      socket.send(
        JSON.stringify({
          op: "auth",
          args: [this.apiKey, expires, signature],
        }),
      );

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "ping" }));
          }
        } catch {
          return;
        }
      }, PRIVATE_WS_PING_INTERVAL_MS);
    });

    socket.on("message", (buffer: RawData) => {
      if (this.ws !== socket) return;
      const raw = typeof buffer === "string" ? buffer : buffer.toString("utf8");

      try {
        const msg = JSON.parse(raw) as Record<string, unknown>;

        if (msg.op === "auth") {
          if (msg.success === true) {
            this.status = "subscribing";
            this.error = null;
            socket.send(JSON.stringify({ op: "subscribe", args: ["position"] }));
            return;
          }

          this.status = "error";
          this.error = String(msg.ret_msg ?? "auth_failed");
          this.logger.error(
            { mode: this.mode, msg },
            "bybit private positions auth failed",
          );
          return;
        }

        if (msg.op === "subscribe") {
          if (msg.success === true) {
            this.status = "connected";
            this.error = null;
            void this.seedFromRest("subscribe_ok");
            return;
          }

          this.status = "error";
          this.error = String(msg.ret_msg ?? "subscribe_failed");
          this.logger.error(
            { mode: this.mode, msg },
            "bybit private positions subscribe failed",
          );
          return;
        }

        if (msg.op === "pong") {
          return;
        }

        if (msg.topic === "position") {
          const rows = Array.isArray(msg.data) ? msg.data : [];
          for (const item of rows) {
            if (!item || typeof item !== "object") continue;
            const normalized = normalizePositionRow(item as Record<string, unknown>);
            const key = toPositionKey(item as Record<string, unknown>);
            if (!normalized) {
              this.positions.delete(key);
              continue;
            }
            this.positions.set(key, normalized);
          }
          this.updatedAt = Date.now();
          this.status = "connected";
          this.error = null;
        }
      } catch (error) {
        this.status = "error";
        this.error = String((error as Error)?.message ?? error);
      }
    });

    socket.on("close", () => {
      if (this.ws !== socket) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.scheduleReconnect();
    });

    socket.on("error", (error) => {
      if (this.ws !== socket) return;
      this.status = "error";
      this.error = String((error as Error)?.message ?? error);
      this.logger.warn(
        { mode: this.mode, error: this.error },
        "bybit private positions socket error",
      );
      try {
        socket.close();
      } catch {
        return;
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || !this.hasCredentials()) return;

    this.reconnectAttempt += 1;
    const delayMs = Math.min(10_000, 1_000 * this.reconnectAttempt);
    this.status = "reconnecting";

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}

export function createPrivatePositionsWs(app: {
  addHook: (name: "onReady" | "onClose", hook: () => Promise<void>) => void;
  log: FastifyBaseLogger;
}) {
  const clients = new Map<WebSocket, ExecutionMode>();

  const realSeedClient = new BybitRealRestClient();
  const demoSeedClient = new BybitDemoRestClient();

  const realStream = new BybitPrivatePositionsStream(
    "real",
    app.log,
    process.env.BYBIT_PRIVATE_WS_URL ?? "wss://stream.bybit.com/v5/private",
    process.env.BYBIT_API_KEY ?? "",
    process.env.BYBIT_API_SECRET ?? "",
    realSeedClient,
  );
  const demoStream = new BybitPrivatePositionsStream(
    "demo",
    app.log,
    process.env.BYBIT_DEMO_PRIVATE_WS_URL ?? "wss://stream-demo.bybit.com/v5/private",
    process.env.BYBIT_DEMO_API_KEY ?? "",
    process.env.BYBIT_DEMO_API_SECRET ?? "",
    demoSeedClient,
  );

  const getStream = (mode: ExecutionMode) =>
    mode === "real" ? realStream : demoStream;

  const host = process.env.POSITIONS_WS_HOST ?? process.env.HOST ?? "0.0.0.0";
  const port = Math.max(1, Number(process.env.POSITIONS_WS_PORT ?? 8081) || 8081);

  let wss: WebSocketServer | null = null;
  let broadcastTimer: NodeJS.Timeout | null = null;

  function broadcastSnapshots() {
    for (const [client, mode] of clients.entries()) {
      safeSend(client, {
        type: "positions_snapshot",
        payload: getStream(mode).getSnapshot(),
      });
    }
  }

  app.addHook("onReady", async () => {
    wss = new WebSocketServer({
      host,
      port,
      path: POSITIONS_WS_PATH,
    });

    broadcastTimer = setInterval(() => {
      broadcastSnapshots();
    }, CLIENT_BROADCAST_INTERVAL_MS);

    wss.on("connection", (ws, request) => {
      const mode = (() => {
        try {
          const url = new URL(request.url ?? POSITIONS_WS_PATH, "http://localhost");
          return normalizeMode(url.searchParams.get("mode"));
        } catch {
          return "demo";
        }
      })();

      clients.set(ws, mode);
      getStream(mode).ensureStarted();

      safeSend(ws, {
        type: "hello",
        payload: getStream(mode).getSnapshot(),
      });

      ws.on("close", () => {
        clients.delete(ws);
      });

      ws.on("error", () => {
        clients.delete(ws);
      });
    });

    app.log.info(
      { host, port, path: POSITIONS_WS_PATH },
      "private positions ws ready",
    );
  });

  app.addHook("onClose", async () => {
    if (broadcastTimer) clearInterval(broadcastTimer);
    broadcastTimer = null;

    realStream.stop();
    demoStream.stop();
    clients.clear();

    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });
}
