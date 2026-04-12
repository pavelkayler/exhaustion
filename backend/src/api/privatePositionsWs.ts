import { createHmac } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { BybitDemoRestClient } from "../bybit/BybitDemoRestClient.js";
import { BybitRealRestClient } from "../bybit/BybitRealRestClient.js";

type ExecutionMode = "demo" | "real";
type ExecutionReason = "manual" | "candidate" | "final";

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

type ExecutionOrderRow = {
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

type PositionsSnapshot = {
  mode: ExecutionMode;
  status: FeedStatus;
  updatedAt: number | null;
  positions: ExecutionPositionRow[];
  orders: ExecutionOrderRow[];
  error: string | null;
};

type ServerMessage =
  | { type: "hello"; payload: PositionsSnapshot }
  | { type: "execution_snapshot"; payload: PositionsSnapshot }
  | { type: "error"; message: string };

type ExecutionRestClient = {
  hasCredentials(): boolean;
  getOpenOrdersLinear(params?: {
    symbol?: string;
    settleCoin?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ list: Array<Record<string, unknown>> }>;
  getPositionsLinear(params?: {
    symbol?: string;
    settleCoin?: string;
  }): Promise<{ list: Array<Record<string, unknown>> }>;
};

type StoredPositionRow = ExecutionPositionRow & {
  leverage: number | null;
  updatedAt: number;
};

type StoredOrderRow = ExecutionOrderRow & {
  updatedAt: number;
};

const POSITIONS_WS_PATH = "/ws/private-positions";
const PRIVATE_WS_PING_INTERVAL_MS = 20_000;
const CLIENT_BROADCAST_INTERVAL_MS = 1_000;
const REST_REFRESH_INTERVAL_MS = 60_000;

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

function inferReason(row: Record<string, unknown>): ExecutionReason {
  const directReason = String(row.reason ?? row.openReason ?? row.positionReason ?? "")
    .trim()
    .toLowerCase();

  if (directReason === "candidate" || directReason === "final" || directReason === "manual") {
    return directReason;
  }

  const orderLinkId = String(
    row.orderLinkId ?? row.positionLinkId ?? row.orderTag ?? "",
  )
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

function toOrderKey(row: Record<string, unknown>): string {
  const orderId = String(row.orderId ?? "").trim();
  const orderLinkId = String(row.orderLinkId ?? "").trim();
  const symbol = String(row.symbol ?? "").trim().toUpperCase();

  if (orderId) return orderId;
  if (orderLinkId) return `${symbol}:${orderLinkId}`;
  return `${symbol}:${String(row.createdTime ?? row.updatedTime ?? Date.now())}`;
}

function readRowUpdatedAt(row: Record<string, unknown>, fallbackTs: number): number {
  return (
    readPositiveNumber(row.updatedTime) ??
    readPositiveNumber(row.updatedAt) ??
    readPositiveNumber(row.ts) ??
    readPositiveNumber(row.transactTime) ??
    readPositiveNumber(row.createdTime) ??
    readPositiveNumber(row.createdAt) ??
    fallbackTs
  );
}

function normalizePositionRow(
  row: Record<string, unknown>,
  receivedAt: number,
): StoredPositionRow | null {
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  const key = toPositionKey(row);
  const side = String(row.side ?? "").trim().toUpperCase();
  const size = Math.abs(Number(row.size ?? 0));

  if (!symbol || !Number.isFinite(size) || size <= 0 || !side || side === "NONE") {
    return null;
  }

  const updatedAt = readRowUpdatedAt(row, receivedAt);

  return {
    key,
    symbol,
    reason: inferReason(row),
    value: readNumber(row.positionValue ?? row.positionBalance ?? row.positionIM),
    pnl: readNumber(row.unrealisedPnl),
    tp: readPositiveNumber(row.takeProfit),
    sl: readPositiveNumber(row.stopLoss),
    side,
    size,
    entryPrice: readPositiveNumber(row.avgPrice),
    markPrice: readPositiveNumber(row.markPrice),
    updatedAt,
    leverage: readPositiveNumber(row.leverage),
  };
}

function isActiveOrderStatus(value: unknown): boolean {
  const status = String(value ?? "").trim().toUpperCase();
  if (!status) return true;

  return (
    status === "NEW" ||
    status === "PARTIALLYFILLED" ||
    status === "UNTRIGGERED" ||
    status === "TRIGGERED" ||
    status === "ACTIVE" ||
    status === "CREATED"
  );
}

function isLimitOrderType(value: unknown): boolean {
  return String(value ?? "").trim().toUpperCase() === "LIMIT";
}

function normalizeOrderRow(
  row: Record<string, unknown>,
  leverageFallbackBySymbol: Map<string, number | null>,
  receivedAt: number,
): StoredOrderRow | null {
  if (!isActiveOrderStatus(row.orderStatus)) return null;
  if (!isLimitOrderType(row.orderType)) return null;

  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;

  const key = toOrderKey(row);
  const leverage =
    readPositiveNumber(row.leverage) ?? leverageFallbackBySymbol.get(symbol) ?? null;

  const entryPrice =
    readPositiveNumber(row.price) ??
    readPositiveNumber(row.triggerPrice) ??
    readPositiveNumber(row.orderPrice) ??
    readPositiveNumber(row.basePrice);

  const qty =
    readPositiveNumber(row.qty) ??
    readPositiveNumber(row.leavesQty) ??
    readPositiveNumber(row.orderQty) ??
    readPositiveNumber(row.size);

  const value =
    (entryPrice != null && qty != null ? entryPrice * qty : null) ??
    readPositiveNumber(row.orderValue) ??
    readPositiveNumber(row.positionValue);

  const margin =
    (value != null && leverage != null && leverage > 0 ? value / leverage : null) ??
    readPositiveNumber(row.orderMargin) ??
    readPositiveNumber(row.positionIM) ??
    readPositiveNumber(row.positionBalance);

  return {
    key,
    symbol,
    reason: inferReason(row),
    value,
    margin,
    leverage,
    entryPrice,
    placedAt:
      readNumber(row.createdTime) ??
      readNumber(row.createdAt) ??
      readNumber(row.placeTime) ??
      readNumber(row.updatedTime),
    updatedAt: readRowUpdatedAt(row, receivedAt),
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

function parseMessageItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === "object"),
    );
  }
  if (value && typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [];
}

class BybitPrivateExecutionStream {
  private privateWs: WebSocket | null = null;
  private privateReconnectTimer: NodeJS.Timeout | null = null;
  private privatePingTimer: NodeJS.Timeout | null = null;
  private restRefreshTimer: NodeJS.Timeout | null = null;
  private privateReconnectAttempt = 0;
  private initialPrivateSubscribeDone = false;

  private shouldRun = false;
  private status: FeedStatus;
  private updatedAt: number | null = null;
  private error: string | null = null;

  private readonly restPositions = new Map<string, StoredPositionRow>();
  private readonly wsPositions = new Map<string, StoredPositionRow>();
  private readonly positionDeletes = new Map<string, number>();

  private readonly restOrders = new Map<string, StoredOrderRow>();
  private readonly wsOrders = new Map<string, StoredOrderRow>();
  private readonly orderDeletes = new Map<string, number>();

  constructor(
    private readonly mode: ExecutionMode,
    private readonly logger: FastifyBaseLogger,
    private readonly privateWsUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly restClient: ExecutionRestClient | null,
  ) {
    this.status = this.hasCredentials() ? "connecting" : "missing_credentials";
  }

  hasCredentials(): boolean {
    return this.apiKey.trim().length > 0 && this.apiSecret.trim().length > 0;
  }

  getSnapshot(): PositionsSnapshot {
    const positions = this.getMergedPositions().map((row) => ({
      key: row.key,
      symbol: row.symbol,
      reason: row.reason,
      value: row.value,
      pnl: row.pnl,
      tp: row.tp,
      sl: row.sl,
      side: row.side,
      size: row.size,
      entryPrice: row.entryPrice,
      markPrice: row.markPrice,
      updatedAt: row.updatedAt,
    }));

    const orders = this.getMergedOrders().map((row) => ({
      key: row.key,
      symbol: row.symbol,
      reason: row.reason,
      value: row.value,
      margin: row.margin,
      leverage: row.leverage,
      entryPrice: row.entryPrice,
      placedAt: row.placedAt,
      updatedAt: row.updatedAt,
    }));

    return {
      mode: this.mode,
      status: this.status,
      updatedAt: this.updatedAt,
      error: this.error,
      positions,
      orders,
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
    this.startRestRefreshLoop();
    void this.refreshFromRest("startup");
    this.connectPrivate();
  }

  stop(): void {
    this.shouldRun = false;

    if (this.privateReconnectTimer) clearTimeout(this.privateReconnectTimer);
    if (this.privatePingTimer) clearInterval(this.privatePingTimer);
    if (this.restRefreshTimer) clearInterval(this.restRefreshTimer);

    this.privateReconnectTimer = null;
    this.privatePingTimer = null;
    this.restRefreshTimer = null;

    try {
      this.privateWs?.close();
    } catch {}

    this.privateWs = null;
  }

  private startRestRefreshLoop(): void {
    if (this.restRefreshTimer) clearInterval(this.restRefreshTimer);
    this.restRefreshTimer = setInterval(() => {
      void this.refreshFromRest("interval");
    }, REST_REFRESH_INTERVAL_MS);
  }

  private buildVisiblePositionMap(): Map<string, StoredPositionRow> {
    const visible = new Map<string, StoredPositionRow>();
    const keys = new Set<string>([
      ...this.restPositions.keys(),
      ...this.wsPositions.keys(),
      ...this.positionDeletes.keys(),
    ]);

    for (const key of keys) {
      const restRow = this.restPositions.get(key) ?? null;
      const wsRow = this.wsPositions.get(key) ?? null;
      const deleteTs = this.positionDeletes.get(key) ?? null;

      const restAllowed = restRow != null && (deleteTs == null || restRow.updatedAt > deleteTs);
      const wsAllowed = wsRow != null && (deleteTs == null || wsRow.updatedAt > deleteTs);

      if (wsAllowed && (!restAllowed || wsRow!.updatedAt >= restRow!.updatedAt)) {
        visible.set(key, wsRow!);
        continue;
      }

      if (restAllowed) {
        visible.set(key, restRow!);
      }
    }

    return visible;
  }

  private getMergedPositions(): StoredPositionRow[] {
    return Array.from(this.buildVisiblePositionMap().values()).sort((left, right) => {
      const symbolCmp = left.symbol.localeCompare(right.symbol);
      if (symbolCmp !== 0) return symbolCmp;
      return left.key.localeCompare(right.key);
    });
  }

  private getMergedOrders(): StoredOrderRow[] {
    const visible = new Map<string, StoredOrderRow>();
    const keys = new Set<string>([
      ...this.restOrders.keys(),
      ...this.wsOrders.keys(),
      ...this.orderDeletes.keys(),
    ]);

    for (const key of keys) {
      const restRow = this.restOrders.get(key) ?? null;
      const wsRow = this.wsOrders.get(key) ?? null;
      const deleteTs = this.orderDeletes.get(key) ?? null;

      const restAllowed = restRow != null && (deleteTs == null || restRow.updatedAt > deleteTs);
      const wsAllowed = wsRow != null && (deleteTs == null || wsRow.updatedAt > deleteTs);

      if (wsAllowed && (!restAllowed || wsRow!.updatedAt >= restRow!.updatedAt)) {
        visible.set(key, wsRow!);
        continue;
      }

      if (restAllowed) {
        visible.set(key, restRow!);
      }
    }

    return Array.from(visible.values()).sort((left, right) => {
      const symbolCmp = left.symbol.localeCompare(right.symbol);
      if (symbolCmp !== 0) return symbolCmp;
      return (left.placedAt ?? 0) - (right.placedAt ?? 0);
    });
  }

  private buildLeverageFallbackBySymbol(): Map<string, number | null> {
    const fallback = new Map<string, number | null>();
    for (const position of this.getMergedPositions()) {
      fallback.set(position.symbol, position.leverage);
    }
    return fallback;
  }

  private async refreshFromRest(reason: string): Promise<void> {
    if (!this.shouldRun) return;
    if (!this.restClient || !this.restClient.hasCredentials()) return;

    try {
      const refreshedAt = Date.now();

      const positionsResponse = await this.restClient.getPositionsLinear({
        settleCoin: "USDT",
      });

      const nextRestPositions = new Map<string, StoredPositionRow>();
      for (const item of Array.isArray(positionsResponse?.list) ? positionsResponse.list : []) {
        if (!item || typeof item !== "object") continue;
        const normalized = normalizePositionRow(item, refreshedAt);
        if (!normalized) continue;
        nextRestPositions.set(normalized.key, normalized);
      }
      this.restPositions.clear();
      for (const [key, value] of nextRestPositions.entries()) {
        this.restPositions.set(key, value);
      }

      const leverageFallbackBySymbol = this.buildLeverageFallbackBySymbol();

      const ordersResponse = await this.restClient.getOpenOrdersLinear({
        settleCoin: "USDT",
        limit: 50,
      });

      const nextRestOrders = new Map<string, StoredOrderRow>();
      for (const item of Array.isArray(ordersResponse?.list) ? ordersResponse.list : []) {
        if (!item || typeof item !== "object") continue;
        const normalized = normalizeOrderRow(item, leverageFallbackBySymbol, refreshedAt);
        if (!normalized) continue;
        nextRestOrders.set(normalized.key, normalized);
      }
      this.restOrders.clear();
      for (const [key, value] of nextRestOrders.entries()) {
        this.restOrders.set(key, value);
      }

      this.updatedAt = refreshedAt;
      if (this.status !== "missing_credentials") {
        this.error = null;
      }

      this.logger.info(
        {
          mode: this.mode,
          reason,
          positions: nextRestPositions.size,
          orders: nextRestOrders.size,
        },
        "private execution state refreshed from rest",
      );
    } catch (error) {
      this.logger.warn(
        {
          mode: this.mode,
          reason,
          error: String((error as Error)?.message ?? error),
        },
        "private execution rest refresh failed",
      );
    }
  }

  private markPositionDeleted(key: string, deletedAt: number): void {
    this.wsPositions.delete(key);
    this.positionDeletes.set(key, deletedAt);
  }

  private markOrderDeleted(key: string, deletedAt: number): void {
    this.wsOrders.delete(key);
    this.orderDeletes.set(key, deletedAt);
  }

  private handlePositionFrame(data: unknown): void {
    const receivedAt = Date.now();

    if (Array.isArray(data) && data.length === 0) {
      const visibleKeys = new Set<string>([
        ...this.restPositions.keys(),
        ...this.wsPositions.keys(),
      ]);
      for (const key of visibleKeys) {
        this.markPositionDeleted(key, receivedAt);
      }
      this.updatedAt = receivedAt;
      this.status = "connected";
      this.error = null;
      return;
    }

    for (const item of parseMessageItems(data)) {
      const normalized = normalizePositionRow(item, receivedAt);
      const key = toPositionKey(item);

      if (!normalized) {
        this.markPositionDeleted(key, receivedAt);
        continue;
      }

      this.positionDeletes.delete(key);
      this.wsPositions.set(key, normalized);
    }

    this.updatedAt = receivedAt;
    this.status = "connected";
    this.error = null;
  }

  private handleOrderFrame(data: unknown): void {
    const receivedAt = Date.now();
    const leverageFallbackBySymbol = this.buildLeverageFallbackBySymbol();

    for (const item of parseMessageItems(data)) {
      const normalized = normalizeOrderRow(item, leverageFallbackBySymbol, receivedAt);
      const key = toOrderKey(item);

      if (!normalized) {
        this.markOrderDeleted(key, receivedAt);
        continue;
      }

      this.orderDeletes.delete(key);
      this.wsOrders.set(key, normalized);
    }

    this.updatedAt = receivedAt;
    this.status = "connected";
    this.error = null;
  }

  private connectPrivate(): void {
    if (!this.shouldRun || !this.hasCredentials()) return;

    this.status = this.privateReconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.error = null;
    this.initialPrivateSubscribeDone = false;

    const socket = new WebSocket(this.privateWsUrl);
    this.privateWs = socket;

    socket.on("open", () => {
      if (this.privateWs !== socket) return;
      this.status = "authenticating";
      this.error = null;
      this.privateReconnectAttempt = 0;

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

      if (this.privatePingTimer) clearInterval(this.privatePingTimer);
      this.privatePingTimer = setInterval(() => {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "ping" }));
          }
        } catch {}
      }, PRIVATE_WS_PING_INTERVAL_MS);
    });

    socket.on("message", (buffer: RawData) => {
      if (this.privateWs !== socket) return;
      const raw = typeof buffer === "string" ? buffer : buffer.toString("utf8");

      try {
        const msg = JSON.parse(raw) as Record<string, unknown>;

        if (msg.op === "auth") {
          if (msg.success === true) {
            this.status = "subscribing";
            this.error = null;
            socket.send(
              JSON.stringify({
                op: "subscribe",
                args: ["position", "order", "execution"],
              }),
            );
            return;
          }

          this.status = "error";
          this.error = String(msg.ret_msg ?? "auth_failed");
          this.logger.error({ mode: this.mode, msg }, "private execution auth failed");
          return;
        }

        if (msg.op === "subscribe") {
          if (msg.success === true) {
            this.initialPrivateSubscribeDone = true;
            this.status = "connected";
            this.error = null;
            void this.refreshFromRest("subscribe_ok");
            return;
          }

          this.status = "error";
          this.error = String(msg.ret_msg ?? "subscribe_failed");
          this.logger.error({ mode: this.mode, msg }, "private execution subscribe failed");
          return;
        }

        if (msg.op === "unsubscribe" || msg.op === "pong") {
          return;
        }

        if (msg.topic === "position") {
          this.handlePositionFrame(msg.data);
          return;
        }

        if (msg.topic === "order") {
          this.handleOrderFrame(msg.data);
          return;
        }

        if (msg.topic === "execution") {
          const receivedAt = Date.now();
          this.updatedAt = receivedAt;
          this.status = "connected";
          this.error = null;
          return;
        }
      } catch (error) {
        this.status = "error";
        this.error = String((error as Error)?.message ?? error);
      }
    });

    socket.on("close", () => {
      if (this.privateWs !== socket) return;
      this.privateWs = null;
      if (this.privatePingTimer) clearInterval(this.privatePingTimer);
      this.privatePingTimer = null;
      this.schedulePrivateReconnect();
    });

    socket.on("error", (error) => {
      if (this.privateWs !== socket) return;
      this.status = "error";
      this.error = String((error as Error)?.message ?? error);
      this.logger.warn(
        { mode: this.mode, error: this.error },
        "private execution socket error",
      );
      try {
        socket.close();
      } catch {}
    });
  }

  private schedulePrivateReconnect(): void {
    if (!this.shouldRun || !this.hasCredentials()) return;

    this.privateReconnectAttempt += 1;
    const delayMs = Math.min(10_000, 1_000 * this.privateReconnectAttempt);
    this.status = "reconnecting";

    if (this.privateReconnectTimer) clearTimeout(this.privateReconnectTimer);
    this.privateReconnectTimer = setTimeout(() => {
      this.privateReconnectTimer = null;
      if (!this.shouldRun) return;
      this.connectPrivate();
    }, delayMs);
  }
}

export function createPrivatePositionsWs(app: {
  addHook: (name: "onReady" | "onClose", hook: () => Promise<void>) => void;
  log: FastifyBaseLogger;
}) {
  const clients = new Map<WebSocket, ExecutionMode>();

  const realRestClient = new BybitRealRestClient();
  const demoRestClient = new BybitDemoRestClient();

  const realStream = new BybitPrivateExecutionStream(
    "real",
    app.log,
    process.env.BYBIT_PRIVATE_WS_URL ?? "wss://stream.bybit.com/v5/private",
    process.env.BYBIT_API_KEY ?? "",
    process.env.BYBIT_API_SECRET ?? "",
    realRestClient,
  );

  const demoStream = new BybitPrivateExecutionStream(
    "demo",
    app.log,
    process.env.BYBIT_DEMO_PRIVATE_WS_URL ?? "wss://stream-demo.bybit.com/v5/private",
    process.env.BYBIT_DEMO_API_KEY ?? "",
    process.env.BYBIT_DEMO_API_SECRET ?? "",
    demoRestClient,
  );

  const getStream = (mode: ExecutionMode) => (mode === "real" ? realStream : demoStream);

  const host = process.env.POSITIONS_WS_HOST ?? process.env.HOST ?? "0.0.0.0";
  const port = Math.max(1, Number(process.env.POSITIONS_WS_PORT ?? 8081) || 8081);

  let wss: WebSocketServer | null = null;
  let broadcastTimer: NodeJS.Timeout | null = null;

  function broadcastSnapshots() {
    for (const [client, mode] of clients.entries()) {
      safeSend(client, {
        type: "execution_snapshot",
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

    realStream.ensureStarted();
    demoStream.ensureStarted();

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

    app.log.info({ host, port, path: POSITIONS_WS_PATH }, "private execution ws ready");
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
