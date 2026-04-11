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

type PositionsSeedClient = {
  hasCredentials(): boolean;
  getPositionsLinear(params?: {
    symbol?: string;
    settleCoin?: string;
  }): Promise<{ list: Array<Record<string, unknown>> }>;
  getOpenOrdersLinear(params?: {
    symbol?: string;
    settleCoin?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ list: Array<Record<string, unknown>> }>;
};

type StoredPositionRow = ExecutionPositionRow & {
  leverage: number | null;
};

const POSITIONS_WS_PATH = "/ws/private-positions";
const PRIVATE_WS_PING_INTERVAL_MS = 20_000;
const CLIENT_BROADCAST_INTERVAL_MS = 1_000;
const PUBLIC_REAL_WS_URL = "wss://stream.bybit.com/v5/public/linear";
const PUBLIC_DEMO_WS_URL = "wss://stream-demo.bybit.com/v5/public/linear";

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

function normalizePositionRow(row: Record<string, unknown>): StoredPositionRow | null {
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
    reason: inferReason(row),
    value: readNumber(row.positionValue ?? row.positionBalance ?? row.positionIM),
    pnl: readNumber(row.unrealisedPnl),
    tp: readPositiveNumber(row.takeProfit),
    sl: readPositiveNumber(row.stopLoss),
    side,
    size,
    entryPrice: readPositiveNumber(row.avgPrice),
    markPrice: readPositiveNumber(row.markPrice),
    updatedAt: readNumber(row.updatedTime) ?? Date.now(),
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
): ExecutionOrderRow | null {
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
    updatedAt: readNumber(row.updatedTime) ?? Date.now(),
  };
}

function computePositionValue(
  currentPrice: number | null,
  size: number | null,
  fallback: number | null,
): number | null {
  if ((currentPrice ?? 0) > 0 && (size ?? 0) > 0) {
    return Number(currentPrice) * Number(size);
  }
  return fallback;
}

function computePositionPnl(args: {
  side: string | null;
  size: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  fallback: number | null;
}): number | null {
  const size = Number(args.size);
  const entryPrice = Number(args.entryPrice);
  const currentPrice = Number(args.currentPrice);
  const side = String(args.side ?? "").trim().toUpperCase();

  if (!(size > 0) || !(entryPrice > 0) || !(currentPrice > 0)) {
    return args.fallback;
  }

  if (side === "SELL") return (entryPrice - currentPrice) * size;
  if (side === "BUY") return (currentPrice - entryPrice) * size;

  return args.fallback;
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
  private privateReconnectAttempt = 0;

  private publicWs: WebSocket | null = null;
  private publicReconnectTimer: NodeJS.Timeout | null = null;
  private publicReconnectAttempt = 0;
  private publicSymbolsKey = "";

  private reconcileTimer: NodeJS.Timeout | null = null;
  private lastSeedStartedAt = 0;

  private shouldRun = false;
  private status: FeedStatus;
  private updatedAt: number | null = null;
  private error: string | null = null;
  private positions = new Map<string, StoredPositionRow>();
  private orders = new Map<string, ExecutionOrderRow>();
  private marketPrices = new Map<string, number>();
  private marketUpdatedAt: number | null = null;
  private seedInFlight = false;

  constructor(
    private readonly mode: ExecutionMode,
    private readonly logger: FastifyBaseLogger,
    private readonly privateWsUrl: string,
    private readonly publicWsUrl: string,
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
    const positions = Array.from(this.positions.values())
      .map((row): ExecutionPositionRow => {
        const currentPrice = this.marketPrices.get(row.symbol) ?? row.markPrice ?? null;
        return {
          key: row.key,
          symbol: row.symbol,
          reason: row.reason,
          value: computePositionValue(currentPrice, row.size, row.value),
          pnl: computePositionPnl({
            side: row.side,
            size: row.size,
            entryPrice: row.entryPrice,
            currentPrice,
            fallback: row.pnl,
          }),
          tp: row.tp,
          sl: row.sl,
          side: row.side,
          size: row.size,
          entryPrice: row.entryPrice,
          markPrice: currentPrice,
          updatedAt: row.updatedAt,
        };
      })
      .sort((left, right) => {
        const symbolCmp = left.symbol.localeCompare(right.symbol);
        if (symbolCmp !== 0) return symbolCmp;
        return left.key.localeCompare(right.key);
      });

    const orders = Array.from(this.orders.values()).sort((left, right) => {
      const symbolCmp = left.symbol.localeCompare(right.symbol);
      if (symbolCmp !== 0) return symbolCmp;
      return (left.placedAt ?? 0) - (right.placedAt ?? 0);
    });

    return {
      mode: this.mode,
      status: this.status,
      updatedAt: Math.max(
        Number(this.updatedAt ?? 0),
        Number(this.marketUpdatedAt ?? 0),
      ) || null,
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
    void this.seedFromRest("ensure_started");
    this.connectPrivate();
  }

  stop(): void {
    this.shouldRun = false;

    if (this.privateReconnectTimer) clearTimeout(this.privateReconnectTimer);
    if (this.privatePingTimer) clearInterval(this.privatePingTimer);
    if (this.publicReconnectTimer) clearTimeout(this.publicReconnectTimer);
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);

    this.privateReconnectTimer = null;
    this.privatePingTimer = null;
    this.publicReconnectTimer = null;
    this.reconcileTimer = null;

    try {
      this.privateWs?.close();
    } catch {}
    try {
      this.publicWs?.close();
    } catch {}

    this.privateWs = null;
    this.publicWs = null;
    this.publicSymbolsKey = "";
  }

  private scheduleSeedFromRest(reason: string, delayMs = 250): void {
    if (!this.shouldRun || !this.seedClient || !this.seedClient.hasCredentials()) return;

    const now = Date.now();
    const minDelay = Math.max(0, 1_000 - (now - this.lastSeedStartedAt));
    const nextDelay = Math.max(delayMs, minDelay);

    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.seedFromRest(reason);
    }, nextDelay);
  }

  private async seedFromRest(reason: string): Promise<void> {
    if (!this.shouldRun) return;
    if (!this.seedClient || !this.seedClient.hasCredentials()) return;
    if (this.seedInFlight) return;

    this.seedInFlight = true;
    this.lastSeedStartedAt = Date.now();

    try {
      const [positionsResp, ordersResp] = await Promise.all([
        this.seedClient.getPositionsLinear({ settleCoin: "USDT" }),
        this.seedClient.getOpenOrdersLinear({ settleCoin: "USDT", limit: 50 }),
      ]);

      const nextPositions = new Map<string, StoredPositionRow>();
      for (const item of Array.isArray(positionsResp?.list) ? positionsResp.list : []) {
        if (!item || typeof item !== "object") continue;
        const normalized = normalizePositionRow(item);
        if (!normalized) continue;
        nextPositions.set(normalized.key, normalized);
      }

      const leverageFallbackBySymbol = new Map<string, number | null>();
      for (const position of nextPositions.values()) {
        leverageFallbackBySymbol.set(position.symbol, position.leverage);
      }

      const nextOrders = new Map<string, ExecutionOrderRow>();
      for (const item of Array.isArray(ordersResp?.list) ? ordersResp.list : []) {
        if (!item || typeof item !== "object") continue;
        const normalized = normalizeOrderRow(item, leverageFallbackBySymbol);
        if (!normalized) continue;
        nextOrders.set(normalized.key, normalized);
      }

      this.positions = nextPositions;
      this.orders = nextOrders;
      this.updatedAt = Date.now();
      this.error = null;
      this.syncPublicTickerSocket();

      this.logger.info(
        {
          mode: this.mode,
          reason,
          positions: nextPositions.size,
          orders: nextOrders.size,
        },
        "private execution seed synced",
      );
    } catch (error) {
      this.logger.warn(
        {
          mode: this.mode,
          reason,
          error: String((error as Error)?.message ?? error),
        },
        "private execution seed failed",
      );
    } finally {
      this.seedInFlight = false;
    }
  }

  private connectPrivate(): void {
    if (!this.shouldRun || !this.hasCredentials()) return;

    this.positions.clear();
    this.orders.clear();
    this.updatedAt = null;
    this.error = null;
    this.status = this.privateReconnectAttempt > 0 ? "reconnecting" : "connecting";

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
            socket.send(JSON.stringify({ op: "subscribe", args: ["position", "order", "execution"] }));
            return;
          }

          this.status = "error";
          this.error = String(msg.ret_msg ?? "auth_failed");
          this.logger.error({ mode: this.mode, msg }, "private execution auth failed");
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
          this.logger.error({ mode: this.mode, msg }, "private execution subscribe failed");
          return;
        }

        if (msg.op === "pong") {
          return;
        }

        if (msg.topic === "position") {
          let mutated = false;

          for (const item of parseMessageItems(msg.data)) {
            const normalized = normalizePositionRow(item);
            const key = toPositionKey(item);

            if (!normalized) {
              if (this.positions.delete(key)) mutated = true;
              continue;
            }

            this.positions.set(key, normalized);
            mutated = true;
          }

          if (mutated) {
            this.updatedAt = Date.now();
            this.status = "connected";
            this.error = null;
            this.syncPublicTickerSocket();
          }
          return;
        }

        if (msg.topic === "order") {
          let mutated = false;
          let needsReconcile = false;

          const leverageFallbackBySymbol = new Map<string, number | null>();
          for (const position of this.positions.values()) {
            leverageFallbackBySymbol.set(position.symbol, position.leverage);
          }

          for (const item of parseMessageItems(msg.data)) {
            const normalized = normalizeOrderRow(item, leverageFallbackBySymbol);
            const key = toOrderKey(item);

            if (!normalized) {
              if (this.orders.delete(key)) mutated = true;
              needsReconcile = true;
              continue;
            }

            this.orders.set(key, normalized);
            mutated = true;

            if (!isActiveOrderStatus(item.orderStatus)) {
              needsReconcile = true;
            }
          }

          if (mutated) {
            this.updatedAt = Date.now();
            this.status = "connected";
            this.error = null;
            this.syncPublicTickerSocket();
          }

          if (needsReconcile) {
            this.scheduleSeedFromRest("order_state_change", 250);
          }
          return;
        }

        if (msg.topic === "execution") {
          this.updatedAt = Date.now();
          this.status = "connected";
          this.error = null;
          this.scheduleSeedFromRest("execution_event", 250);
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
      this.connectPrivate();
    }, delayMs);
  }

  private getTrackedSymbols(): string[] {
    const out = new Set<string>();
    for (const row of this.positions.values()) out.add(row.symbol);
    for (const row of this.orders.values()) out.add(row.symbol);
    return Array.from(out).sort();
  }

  private syncPublicTickerSocket(): void {
    const symbols = this.getTrackedSymbols();
    const nextKey = symbols.join(",");

    if (!nextKey) {
      this.publicSymbolsKey = "";
      this.marketPrices.clear();
      try {
        this.publicWs?.close();
      } catch {}
      this.publicWs = null;
      return;
    }

    if (
      this.publicWs &&
      (this.publicWs.readyState === WebSocket.OPEN ||
        this.publicWs.readyState === WebSocket.CONNECTING) &&
      this.publicSymbolsKey === nextKey
    ) {
      return;
    }

    this.publicSymbolsKey = nextKey;

    try {
      this.publicWs?.close();
    } catch {}
    this.publicWs = null;

    this.connectPublicTickerSocket(symbols);
  }

  private connectPublicTickerSocket(symbols: string[]): void {
    if (!this.shouldRun || symbols.length === 0) return;

    const socket = new WebSocket(this.publicWsUrl);
    this.publicWs = socket;

    socket.on("open", () => {
      if (this.publicWs !== socket) return;
      this.publicReconnectAttempt = 0;
      const args = symbols.map((symbol) => `tickers.${symbol}`);
      socket.send(JSON.stringify({ op: "subscribe", args }));
    });

    socket.on("message", (buffer: RawData) => {
      if (this.publicWs !== socket) return;
      const raw = typeof buffer === "string" ? buffer : buffer.toString("utf8");

      try {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        const topic = String(msg.topic ?? "");
        if (!topic.startsWith("tickers.")) return;

        const symbol = topic.slice("tickers.".length).trim().toUpperCase();
        if (!symbol) return;

        const payload =
          msg.data && typeof msg.data === "object" ? (msg.data as Record<string, unknown>) : {};

        const currentPrice =
          readPositiveNumber(payload.markPrice) ??
          readPositiveNumber(payload.lastPrice) ??
          readPositiveNumber(payload.indexPrice);

        if (currentPrice != null) {
          this.marketPrices.set(symbol, currentPrice);
          this.marketUpdatedAt = Date.now();
        }
      } catch {}
    });

    socket.on("close", () => {
      if (this.publicWs !== socket) return;
      this.publicWs = null;
      this.schedulePublicReconnect();
    });

    socket.on("error", () => {
      try {
        socket.close();
      } catch {}
    });
  }

  private schedulePublicReconnect(): void {
    if (!this.shouldRun || !this.publicSymbolsKey) return;

    this.publicReconnectAttempt += 1;
    const delayMs = Math.min(10_000, 1_000 * this.publicReconnectAttempt);

    if (this.publicReconnectTimer) clearTimeout(this.publicReconnectTimer);
    this.publicReconnectTimer = setTimeout(() => {
      this.publicReconnectTimer = null;
      const symbols = this.publicSymbolsKey.split(",").filter(Boolean);
      this.connectPublicTickerSocket(symbols);
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

  const realStream = new BybitPrivateExecutionStream(
    "real",
    app.log,
    process.env.BYBIT_PRIVATE_WS_URL ?? "wss://stream.bybit.com/v5/private",
    process.env.BYBIT_PUBLIC_WS_URL ?? PUBLIC_REAL_WS_URL,
    process.env.BYBIT_API_KEY ?? "",
    process.env.BYBIT_API_SECRET ?? "",
    realSeedClient,
  );

  const demoStream = new BybitPrivateExecutionStream(
    "demo",
    app.log,
    process.env.BYBIT_DEMO_PRIVATE_WS_URL ?? "wss://stream-demo.bybit.com/v5/private",
    process.env.BYBIT_DEMO_PUBLIC_WS_URL ?? PUBLIC_DEMO_WS_URL,
    process.env.BYBIT_DEMO_API_KEY ?? "",
    process.env.BYBIT_DEMO_API_SECRET ?? "",
    demoSeedClient,
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
