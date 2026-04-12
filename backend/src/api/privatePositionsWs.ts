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

type OrdersSeedClient = {
  hasCredentials(): boolean;
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
const POSITION_RESUBSCRIBE_INTERVAL_MS = 60_000;
const POSITION_RESUBSCRIBE_TIMEOUT_MS = 8_000;
const POSITION_REFRESH_GUARD_INTERVAL_MS = 1_000;
const POSITION_BOOTSTRAP_RETRY_INTERVAL_MS = 10_000;
const POSITION_BOOTSTRAP_RETRY_MAX_MS = 60_000;

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
    updatedAt: receivedAt,
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
    updatedAt: receivedAt,
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
  private refreshGuardTimer: NodeJS.Timeout | null = null;
  private positionRefreshTimeoutTimer: NodeJS.Timeout | null = null;
  private privateReconnectAttempt = 0;
  private initialPrivateSubscribeDone = false;
  private bootstrapPositionResolved = false;

  private shouldRun = false;
  private status: FeedStatus;
  private updatedAt: number | null = null;
  private error: string | null = null;
  private positions = new Map<string, StoredPositionRow>();
  private orders = new Map<string, ExecutionOrderRow>();

  private lastPositionFrameAt: number | null = null;
  private positionRefreshCycleStartedAt: number | null = null;
  private positionRefreshAttemptStartedAt: number | null = null;
  private positionRefreshFailureCount = 0;
  private positionResubscribeInFlight = false;

  constructor(
    private readonly mode: ExecutionMode,
    private readonly logger: FastifyBaseLogger,
    private readonly privateWsUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly ordersSeedClient: OrdersSeedClient | null,
  ) {
    this.status = this.hasCredentials() ? "connecting" : "missing_credentials";
  }

  hasCredentials(): boolean {
    return this.apiKey.trim().length > 0 && this.apiSecret.trim().length > 0;
  }

  getSnapshot(): PositionsSnapshot {
    const positions = Array.from(this.positions.values()).sort((left, right) => {
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
    this.startRefreshGuard();
    void this.seedOrdersFromRest("ensure_started");
    this.connectPrivate();
  }

  stop(): void {
    this.shouldRun = false;

    if (this.privateReconnectTimer) clearTimeout(this.privateReconnectTimer);
    if (this.privatePingTimer) clearInterval(this.privatePingTimer);
    if (this.refreshGuardTimer) clearInterval(this.refreshGuardTimer);
    if (this.positionRefreshTimeoutTimer) clearTimeout(this.positionRefreshTimeoutTimer);

    this.privateReconnectTimer = null;
    this.privatePingTimer = null;
    this.refreshGuardTimer = null;
    this.positionRefreshTimeoutTimer = null;

    this.positionRefreshAttemptStartedAt = null;
    this.positionRefreshFailureCount = 0;
    this.positionResubscribeInFlight = false;
    this.bootstrapPositionResolved = false;

    try {
      this.privateWs?.close();
    } catch {}

    this.privateWs = null;
  }

  private startRefreshGuard(): void {
    if (this.refreshGuardTimer) clearInterval(this.refreshGuardTimer);
    this.refreshGuardTimer = setInterval(() => {
      this.tickPositionRefreshGuard();
    }, POSITION_REFRESH_GUARD_INTERVAL_MS);
  }

  private tickPositionRefreshGuard(): void {
    if (!this.shouldRun) return;
    if (!this.privateWs || this.privateWs.readyState !== WebSocket.OPEN) return;
    if (this.status !== "connected") return;
    if (this.positionResubscribeInFlight) return;

    const now = Date.now();
    const baseAt = this.lastPositionFrameAt ?? this.positionRefreshCycleStartedAt;
    if (!(Number(baseAt) > 0)) return;

    if (!this.bootstrapPositionResolved) {
      const bootstrapElapsedMs = now - Number(this.positionRefreshCycleStartedAt ?? baseAt);

      if (this.lastPositionFrameAt != null) {
        this.bootstrapPositionResolved = true;
      } else if (bootstrapElapsedMs >= POSITION_BOOTSTRAP_RETRY_MAX_MS) {
        this.bootstrapPositionResolved = true;
      } else if (bootstrapElapsedMs >= POSITION_BOOTSTRAP_RETRY_INTERVAL_MS) {
        this.requestPositionResubscribe(
          `position_bootstrap_${Math.floor(bootstrapElapsedMs / POSITION_BOOTSTRAP_RETRY_INTERVAL_MS)}`,
        );
        return;
      }
    }

    const elapsedMs = now - Number(baseAt);
    if (elapsedMs < POSITION_RESUBSCRIBE_INTERVAL_MS) return;

    const minutesSinceBase = Math.floor(elapsedMs / POSITION_RESUBSCRIBE_INTERVAL_MS);

    if (minutesSinceBase >= 5 && this.positionRefreshFailureCount >= 4) {
      this.logger.warn(
        {
          mode: this.mode,
          minutesSinceBase,
          failures: this.positionRefreshFailureCount,
        },
        "position refresh escalation: full private ws reconnect",
      );
      this.forcePrivateReconnect("position_refresh_5m_escalation");
      return;
    }

    if (minutesSinceBase >= this.positionRefreshFailureCount + 1) {
      this.requestPositionResubscribe(`position_refresh_m${minutesSinceBase}`);
    }
  }

  private async seedOrdersFromRest(reason: string): Promise<void> {
    if (!this.shouldRun) return;
    if (!this.ordersSeedClient || !this.ordersSeedClient.hasCredentials()) return;

    try {
      const response = await this.ordersSeedClient.getOpenOrdersLinear({
        settleCoin: "USDT",
        limit: 50,
      });

      const leverageFallbackBySymbol = new Map<string, number | null>();
      for (const position of this.positions.values()) {
        leverageFallbackBySymbol.set(position.symbol, position.leverage);
      }

      const receivedAt = Date.now();
      const nextOrders = new Map<string, ExecutionOrderRow>();
      for (const item of Array.isArray(response?.list) ? response.list : []) {
        if (!item || typeof item !== "object") continue;
        const normalized = normalizeOrderRow(item, leverageFallbackBySymbol, receivedAt);
        if (!normalized) continue;
        nextOrders.set(normalized.key, normalized);
      }

      this.orders = nextOrders;
      this.updatedAt = receivedAt;
      this.error = null;

      this.logger.info(
        {
          mode: this.mode,
          reason,
          orders: nextOrders.size,
        },
        "private execution orders seeded",
      );
    } catch (error) {
      this.logger.warn(
        {
          mode: this.mode,
          reason,
          error: String((error as Error)?.message ?? error),
        },
        "private execution orders seed failed",
      );
    }
  }

  private requestPositionResubscribe(reason: string): void {
    if (!this.privateWs || this.privateWs.readyState !== WebSocket.OPEN) return;
    if (this.positionResubscribeInFlight) return;

    this.positionResubscribeInFlight = true;
    this.positionRefreshAttemptStartedAt = Date.now();

    if (this.positionRefreshTimeoutTimer) clearTimeout(this.positionRefreshTimeoutTimer);
    this.positionRefreshTimeoutTimer = setTimeout(() => {
      this.positionRefreshTimeoutTimer = null;
      this.markPositionRefreshFailure(`${reason}:timeout`);
    }, POSITION_RESUBSCRIBE_TIMEOUT_MS);

    this.logger.info(
      {
        mode: this.mode,
        reason,
        failures: this.positionRefreshFailureCount,
      },
      "position refresh resubscribe requested",
    );

    try {
      this.privateWs.send(JSON.stringify({ op: "unsubscribe", args: ["position"] }));
    } catch {}

    setTimeout(() => {
      if (!this.privateWs || this.privateWs.readyState !== WebSocket.OPEN) return;
      try {
        this.privateWs.send(JSON.stringify({ op: "subscribe", args: ["position"] }));
      } catch {}
    }, 150);
  }

  private markPositionRefreshSuccess(receivedAt: number): void {
    this.lastPositionFrameAt = receivedAt;
    this.positionRefreshCycleStartedAt = receivedAt;
    this.positionRefreshFailureCount = 0;
    this.positionResubscribeInFlight = false;
    this.bootstrapPositionResolved = true;
    if (this.positionRefreshTimeoutTimer) clearTimeout(this.positionRefreshTimeoutTimer);
    this.positionRefreshTimeoutTimer = null;
    this.positionRefreshAttemptStartedAt = null;
  }

  private markPositionRefreshFailure(reason: string): void {
    if (!this.positionResubscribeInFlight) return;

    this.positionResubscribeInFlight = false;
    this.positionRefreshAttemptStartedAt = null;
    if (this.positionRefreshTimeoutTimer) clearTimeout(this.positionRefreshTimeoutTimer);
    this.positionRefreshTimeoutTimer = null;
    this.positionRefreshFailureCount += 1;

    this.logger.warn(
      {
        mode: this.mode,
        reason,
        failures: this.positionRefreshFailureCount,
        lastPositionFrameAt: this.lastPositionFrameAt,
      },
      "position refresh resubscribe failed",
    );
  }

  private forcePrivateReconnect(reason: string): void {
    this.positionResubscribeInFlight = false;
    this.positionRefreshAttemptStartedAt = null;
    if (this.positionRefreshTimeoutTimer) clearTimeout(this.positionRefreshTimeoutTimer);
    this.positionRefreshTimeoutTimer = null;

    const socket = this.privateWs;
    this.privateWs = null;
    this.initialPrivateSubscribeDone = false;
    this.bootstrapPositionResolved = false;
    this.status = "reconnecting";

    try {
      socket?.close();
    } catch {}

    if (this.privateReconnectTimer) clearTimeout(this.privateReconnectTimer);
    this.privateReconnectTimer = setTimeout(() => {
      this.privateReconnectTimer = null;
      if (!this.shouldRun) return;
      this.connectPrivate();
    }, 250);

    this.logger.warn({ mode: this.mode, reason }, "forcing private ws reconnect");
  }

  private handlePositionFrame(data: unknown): void {
    const receivedAt = Date.now();
    const items = parseMessageItems(data);
    let mutated = false;

    if (Array.isArray(data) && data.length === 0) {
      if (this.positions.size > 0) {
        this.positions.clear();
        mutated = true;
      }
    } else {
      for (const item of items) {
        const normalized = normalizePositionRow(item, receivedAt);
        const key = toPositionKey(item);

        if (!normalized) {
          if (this.positions.delete(key)) mutated = true;
          continue;
        }

        this.positions.set(key, normalized);
        mutated = true;
      }
    }

    this.markPositionRefreshSuccess(receivedAt);
    this.updatedAt = receivedAt;
    this.status = "connected";
    this.error = null;

    if (!mutated && Array.isArray(data) && data.length === 0) {
      this.logger.info({ mode: this.mode }, "position refresh confirmed: no open positions");
    }
  }

  private handleOrderFrame(data: unknown): void {
    const receivedAt = Date.now();
    let mutated = false;

    const leverageFallbackBySymbol = new Map<string, number | null>();
    for (const position of this.positions.values()) {
      leverageFallbackBySymbol.set(position.symbol, position.leverage);
    }

    for (const item of parseMessageItems(data)) {
      const normalized = normalizeOrderRow(item, leverageFallbackBySymbol, receivedAt);
      const key = toOrderKey(item);

      if (!normalized) {
        if (this.orders.delete(key)) mutated = true;
        continue;
      }

      this.orders.set(key, normalized);
      mutated = true;
    }

    if (mutated) {
      this.updatedAt = receivedAt;
      this.status = "connected";
      this.error = null;
    }
  }

  private connectPrivate(): void {
    if (!this.shouldRun || !this.hasCredentials()) return;

    this.status = this.privateReconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.error = null;
    this.initialPrivateSubscribeDone = false;
    this.bootstrapPositionResolved = false;
    this.positionResubscribeInFlight = false;
    this.positionRefreshAttemptStartedAt = null;
    if (this.positionRefreshTimeoutTimer) clearTimeout(this.positionRefreshTimeoutTimer);
    this.positionRefreshTimeoutTimer = null;

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
            if (!this.initialPrivateSubscribeDone) {
              this.initialPrivateSubscribeDone = true;
              this.status = "connected";
              this.error = null;
              this.positionRefreshCycleStartedAt = Date.now();
              this.bootstrapPositionResolved = false;
              void this.seedOrdersFromRest("subscribe_ok");
              this.requestPositionResubscribe("subscribe_ok_bootstrap");
              setTimeout(() => {
                if (!this.shouldRun) return;
                if (this.bootstrapPositionResolved) return;
                this.requestPositionResubscribe("subscribe_ok_bootstrap_retry");
              }, 3_000);
            } else if (this.positionResubscribeInFlight) {
              this.status = "connected";
              this.error = null;
            }
            return;
          }

          this.status = "error";
          this.error = String(msg.ret_msg ?? "subscribe_failed");
          this.logger.error({ mode: this.mode, msg }, "private execution subscribe failed");
          if (this.positionResubscribeInFlight) {
            this.markPositionRefreshFailure("position_resubscribe_nack");
          }
          return;
        }

        if (msg.op === "unsubscribe") {
          if (msg.success !== true && this.positionResubscribeInFlight) {
            this.markPositionRefreshFailure("position_unsubscribe_nack");
          }
          return;
        }

        if (msg.op === "pong") {
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

  const realOrdersSeedClient = new BybitRealRestClient();
  const demoOrdersSeedClient = new BybitDemoRestClient();

  const realStream = new BybitPrivateExecutionStream(
    "real",
    app.log,
    process.env.BYBIT_PRIVATE_WS_URL ?? "wss://stream.bybit.com/v5/private",
    process.env.BYBIT_API_KEY ?? "",
    process.env.BYBIT_API_SECRET ?? "",
    realOrdersSeedClient,
  );

  const demoStream = new BybitPrivateExecutionStream(
    "demo",
    app.log,
    process.env.BYBIT_DEMO_PRIVATE_WS_URL ?? "wss://stream-demo.bybit.com/v5/private",
    process.env.BYBIT_DEMO_API_KEY ?? "",
    process.env.BYBIT_DEMO_API_SECRET ?? "",
    demoOrdersSeedClient,
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
