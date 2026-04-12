
import { createHmac } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { BybitDemoRestClient } from "../bybit/BybitDemoRestClient.js";
import { BybitRealRestClient } from "../bybit/BybitRealRestClient.js";
import { runtime } from "../runtime/runtime.js";
import {
  executorStore,
  type ExecutionMode,
  type ExecutorManagedPositionState,
  type ExecutorSettings,
} from "../executor/executorStore.js";

type ExecutionReason = "manual" | "candidate" | "final";

type FeedStatus =
  | "connecting"
  | "authenticating"
  | "subscribing"
  | "connected"
  | "reconnecting"
  | "missing_credentials"
  | "error";

type ExecutorRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "waiting_session"
  | "error";

type ExecutionPositionRow = {
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
  positionIdx: number | null;
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

type ExecutorPublicState = {
  settings: ExecutorSettings;
  activeSettings: ExecutorSettings | null;
  desiredRunning: boolean;
  status: ExecutorRuntimeStatus;
  error: string | null;
  updatedAt: number | null;
};

type ServerMessage =
  | { type: "hello"; payload: PositionsSnapshot }
  | { type: "execution_snapshot"; payload: PositionsSnapshot }
  | { type: "error"; message: string };

type ExecutionRestClient = {
  hasCredentials(): boolean;
  getPositionsLinear(params?: {
    symbol?: string;
    settleCoin?: string;
  }): Promise<{ list: Array<Record<string, unknown>> }>;
  getInstrumentsInfoLinear(params?: { symbol?: string }): Promise<Array<Record<string, unknown>>>;
  setTradingStopLinear(params: Record<string, unknown>): Promise<unknown>;
  placeOrderLinear(params: Record<string, unknown>): Promise<unknown>;
  cancelOrderLinear(params: Record<string, unknown>): Promise<unknown>;
};

type StoredPositionRow = ExecutionPositionRow & {
  leverage: number | null;
  updatedAt: number;
};

type StoredOrderRow = ExecutionOrderRow & {
  updatedAt: number;
};

type StoredRawOrder = {
  key: string;
  symbol: string;
  side: string | null;
  orderType: string | null;
  stopOrderType: string | null;
  orderFilter: string | null;
  triggerPrice: number | null;
  price: number | null;
  qty: number | null;
  leavesQty: number | null;
  reduceOnly: boolean;
  closeOnTrigger: boolean;
  positionIdx: number | null;
  orderLinkId: string | null;
  orderId: string | null;
  updatedAt: number;
};

type InstrumentSpec = {
  tickSize: number;
  qtyStep: number;
};

const POSITIONS_WS_PATH = "/ws/private-positions";
const PRIVATE_WS_PING_INTERVAL_MS = 20_000;
const CLIENT_BROADCAST_INTERVAL_MS = 1_000;
const REST_REFRESH_INTERVAL_MS = 60_000;
const EXECUTOR_ACTION_DEDUPE_MS = 5_000;
const EXECUTOR_ORDER_LINK_PREFIX = "executor_exit";

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

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

function readBooleanFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
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

  return {
    key,
    symbol,
    reason: inferReason(row),
    value: readNumber(row.positionValue ?? row.positionBalance ?? row.positionIM),
    pnl: readNumber(row.unrealisedPnl),
    tp: readPositiveNumber(row.takeProfit),
    sl: readPositiveNumber(row.stopLoss),
    trailingStop: readPositiveNumber(row.trailingStop),
    side,
    size,
    entryPrice: readPositiveNumber(row.avgPrice),
    markPrice: readPositiveNumber(row.markPrice),
    positionIdx: readNumber(row.positionIdx),
    updatedAt: readRowUpdatedAt(row, receivedAt),
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

function normalizeRawOrderRow(
  row: Record<string, unknown>,
  receivedAt: number,
): StoredRawOrder | null {
  if (!isActiveOrderStatus(row.orderStatus)) return null;

  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;

  return {
    key: toOrderKey(row),
    symbol,
    side: String(row.side ?? "").trim().toUpperCase() || null,
    orderType: String(row.orderType ?? "").trim().toUpperCase() || null,
    stopOrderType: String(row.stopOrderType ?? "").trim().toUpperCase() || null,
    orderFilter: String(row.orderFilter ?? "").trim().toUpperCase() || null,
    triggerPrice: readPositiveNumber(row.triggerPrice ?? row.triggerPx ?? row.stopPx),
    price: readPositiveNumber(row.price ?? row.orderPrice),
    qty:
      readPositiveNumber(row.qty) ??
      readPositiveNumber(row.orderQty) ??
      readPositiveNumber(row.size),
    leavesQty: readPositiveNumber(row.leavesQty),
    reduceOnly: readBooleanFlag(row.reduceOnly),
    closeOnTrigger: readBooleanFlag(row.closeOnTrigger),
    positionIdx: readNumber(row.positionIdx),
    orderLinkId: String(row.orderLinkId ?? "").trim() || null,
    orderId: String(row.orderId ?? "").trim() || null,
    updatedAt: readRowUpdatedAt(row, receivedAt),
  };
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
    key: toOrderKey(row),
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

function parsePositionIdxFromKey(key: string): number {
  const parts = String(key ?? "").split(":");
  const numeric = Number(parts[1] ?? 0);
  return Number.isFinite(numeric) ? Math.floor(numeric) : 0;
}

function getExitOrderSide(positionSide: string | null): "Buy" | "Sell" {
  return String(positionSide ?? "").trim().toUpperCase() === "SELL" ? "Buy" : "Sell";
}

function isRuntimeSessionActive(): boolean {
  const state = runtime.getStatus().sessionState;
  return state === "RUNNING" || state === "PAUSED" || state === "PAUSING" || state === "RESUMING";
}

function isExecutorOrderLinkId(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase().startsWith(EXECUTOR_ORDER_LINK_PREFIX);
}

function stepPrecision(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 8;
  const text = step.toString().toLowerCase();
  if (text.includes("e-")) {
    const numeric = Number(text.split("e-")[1]);
    return Number.isFinite(numeric) ? numeric : 8;
  }
  const idx = text.indexOf(".");
  return idx >= 0 ? text.length - idx - 1 : 0;
}

function roundNearestToStep(value: number, step: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;
  const precision = stepPrecision(step);
  return Number((Math.round(value / step) * step).toFixed(precision));
}

function roundDownToStep(value: number, step: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;
  const precision = stepPrecision(step);
  return Number((Math.floor((value + step * 1e-6) / step) * step).toFixed(precision));
}

function formatForApi(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = value.toFixed(12);
  return text.replace(/\.?0+$/, "") || "0";
}

function sameWithinStep(left: number | null, right: number | null, step: number): boolean {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  return Math.abs(left - right) <= Math.max(step / 2, 1e-9);
}

function computeTpPrice(entryPrice: number, side: string | null, tpPct: number): number {
  const ratio = Math.max(0, tpPct) / 100;
  return String(side ?? "").trim().toUpperCase() === "SELL"
    ? entryPrice * (1 - ratio)
    : entryPrice * (1 + ratio);
}

function computeSlPrice(entryPrice: number, side: string | null, slPct: number): number {
  const ratio = Math.max(0, slPct) / 100;
  return String(side ?? "").trim().toUpperCase() === "SELL"
    ? entryPrice * (1 + ratio)
    : entryPrice * (1 - ratio);
}

function computeTrailingDistance(anchorPrice: number, pct: number, tickSize: number): number {
  const raw = Math.max(tickSize, anchorPrice * Math.max(0, pct) / 100);
  return Math.max(tickSize, roundNearestToStep(raw, tickSize));
}

function isRelevantRawExitOrder(order: StoredRawOrder): boolean {
  const stopOrderType = String(order.stopOrderType ?? "").trim().toUpperCase();
  const orderFilter = String(order.orderFilter ?? "").trim().toUpperCase();
  return (
    order.reduceOnly ||
    order.closeOnTrigger ||
    isExecutorOrderLinkId(order.orderLinkId) ||
    stopOrderType.includes("TAKEPROFIT") ||
    stopOrderType.includes("STOPLOSS") ||
    orderFilter === "TPSLORDER"
  );
}

function parseInstrumentSpec(raw: Record<string, unknown>): InstrumentSpec {
  const priceFilter = (
    raw.priceFilter && typeof raw.priceFilter === "object" ? raw.priceFilter : {}
  ) as Record<string, unknown>;
  const lotSizeFilter = (
    raw.lotSizeFilter && typeof raw.lotSizeFilter === "object" ? raw.lotSizeFilter : {}
  ) as Record<string, unknown>;

  const tickSize = readPositiveNumber(priceFilter.tickSize ?? raw.tickSize) ?? 0.01;
  const qtyStep = readPositiveNumber(lotSizeFilter.qtyStep ?? raw.qtyStep) ?? 0.001;

  return {
    tickSize,
    qtyStep,
  };
}

class BybitPrivateExecutionStream {
  private privateWs: WebSocket | null = null;
  private privateReconnectTimer: NodeJS.Timeout | null = null;
  private privatePingTimer: NodeJS.Timeout | null = null;
  private restRefreshTimer: NodeJS.Timeout | null = null;
  private privateReconnectAttempt = 0;
  private shouldRun = false;
  private status: FeedStatus;
  private updatedAt: number | null = null;
  private error: string | null = null;

  private readonly restPositions = new Map<string, StoredPositionRow>();
  private readonly wsPositions = new Map<string, StoredPositionRow>();
  private readonly positionDeletes = new Map<string, number>();

  private readonly wsOrders = new Map<string, StoredOrderRow>();
  private readonly orderDeletes = new Map<string, number>();

  private readonly wsRawOrders = new Map<string, StoredRawOrder>();
  private readonly rawOrderDeletes = new Map<string, number>();

  private readonly listeners = new Set<(snapshot: PositionsSnapshot) => void>();

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

  getRestClient(): ExecutionRestClient | null {
    return this.restClient;
  }

  addListener(listener: (snapshot: PositionsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
      trailingStop: row.trailingStop,
      side: row.side,
      size: row.size,
      entryPrice: row.entryPrice,
      markPrice: row.markPrice,
      positionIdx: row.positionIdx,
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

  getPositionsDetailed(): StoredPositionRow[] {
    return this.getMergedPositions();
  }

  getRawOrdersDetailed(): StoredRawOrder[] {
    return this.getMergedRawOrders();
  }

  ensureStarted(): void {
    if (!this.hasCredentials()) {
      this.status = "missing_credentials";
      this.error = "missing_credentials";
      this.notifyListeners();
      return;
    }
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.startRestRefreshLoop();
    void this.refreshFromRest("startup");
    this.connectPrivate();
  }

  async forceRefresh(reason: string): Promise<void> {
    this.ensureStarted();
    await this.refreshFromRest(reason);
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

  private notifyListeners() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        continue;
      }
    }
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

  private getMergedRawOrders(): StoredRawOrder[] {
    const visible = new Map<string, StoredRawOrder>();
    const keys = new Set<string>([
      ...this.wsRawOrders.keys(),
      ...this.rawOrderDeletes.keys(),
    ]);

    for (const key of keys) {
      const wsRow = this.wsRawOrders.get(key) ?? null;
      const deleteTs = this.rawOrderDeletes.get(key) ?? null;
      const wsAllowed = wsRow != null && (deleteTs == null || wsRow.updatedAt > deleteTs);
      if (wsAllowed) visible.set(key, wsRow!);
    }

    return Array.from(visible.values()).sort((left, right) => left.updatedAt - right.updatedAt);
  }

  private getMergedOrders(): StoredOrderRow[] {
    const visible = new Map<string, StoredOrderRow>();
    const keys = new Set<string>([
      ...this.wsOrders.keys(),
      ...this.orderDeletes.keys(),
    ]);

    for (const key of keys) {
      const wsRow = this.wsOrders.get(key) ?? null;
      const deleteTs = this.orderDeletes.get(key) ?? null;
      const wsAllowed = wsRow != null && (deleteTs == null || wsRow.updatedAt > deleteTs);
      if (wsAllowed) visible.set(key, wsRow!);
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

      this.updatedAt = refreshedAt;
      if (this.status !== "missing_credentials") this.error = null;

      this.logger.info(
        {
          mode: this.mode,
          reason,
          positions: nextRestPositions.size,
        },
        "private execution positions refreshed from rest",
      );
      this.notifyListeners();
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

  private markRawOrderDeleted(key: string, deletedAt: number): void {
    this.wsRawOrders.delete(key);
    this.rawOrderDeletes.set(key, deletedAt);
  }

  private handlePositionFrame(data: unknown): void {
    const receivedAt = Date.now();
    this.logger.info(
      {
        mode: this.mode,
        kind: "position",
        data,
      },
      "private execution ws event",
    );

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
      this.notifyListeners();
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
    this.notifyListeners();
  }

  private handleOrderFrame(data: unknown): void {
    const receivedAt = Date.now();
    const leverageFallbackBySymbol = this.buildLeverageFallbackBySymbol();

    this.logger.info(
      {
        mode: this.mode,
        kind: "order",
        data,
      },
      "private execution ws event",
    );

    for (const item of parseMessageItems(data)) {
      const key = toOrderKey(item);
      const rawNormalized = normalizeRawOrderRow(item, receivedAt);
      if (!rawNormalized) {
        this.markRawOrderDeleted(key, receivedAt);
        this.markOrderDeleted(key, receivedAt);
        continue;
      }

      this.rawOrderDeletes.delete(key);
      this.wsRawOrders.set(key, rawNormalized);

      const normalized = normalizeOrderRow(item, leverageFallbackBySymbol, receivedAt);
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
    this.notifyListeners();
  }

  private connectPrivate(): void {
    if (!this.shouldRun || !this.hasCredentials()) return;

    this.status = this.privateReconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.error = null;

    const socket = new WebSocket(this.privateWsUrl);
    this.privateWs = socket;

    socket.on("open", () => {
      if (this.privateWs !== socket) return;
      this.status = "authenticating";
      this.error = null;
      this.privateReconnectAttempt = 0;
      this.logger.info({ mode: this.mode, kind: "open" }, "private execution ws event");
      this.notifyListeners();

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
          this.logger.info({ mode: this.mode, kind: "auth", msg }, "private execution ws event");
          if (msg.success === true) {
            this.status = "subscribing";
            this.error = null;
            this.notifyListeners();
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
          this.notifyListeners();
          return;
        }

        if (msg.op === "subscribe") {
          this.logger.info({ mode: this.mode, kind: "subscribe", msg }, "private execution ws event");
          if (msg.success === true) {
            this.status = "connected";
            this.error = null;
            this.notifyListeners();
            void this.refreshFromRest("subscribe_ok");
            return;
          }

          this.status = "error";
          this.error = String(msg.ret_msg ?? "subscribe_failed");
          this.logger.error({ mode: this.mode, msg }, "private execution subscribe failed");
          this.notifyListeners();
          return;
        }

        if (msg.op === "pong") {
          this.logger.info({ mode: this.mode, kind: "pong", msg }, "private execution ws event");
          return;
        }

        if (msg.op === "unsubscribe") {
          this.logger.info({ mode: this.mode, kind: "unsubscribe", msg }, "private execution ws event");
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
          this.logger.info(
            {
              mode: this.mode,
              kind: "execution",
              data: msg.data,
            },
            "private execution ws event",
          );
          this.updatedAt = receivedAt;
          this.status = "connected";
          this.error = null;
          this.notifyListeners();
          return;
        }

        this.logger.info(
          {
            mode: this.mode,
            kind: "other",
            msg,
          },
          "private execution ws event",
        );
      } catch (error) {
        this.status = "error";
        this.error = String((error as Error)?.message ?? error);
        this.logger.error(
          {
            mode: this.mode,
            raw,
            error: this.error,
          },
          "private execution ws message parse failed",
        );
        this.notifyListeners();
      }
    });

    socket.on("close", () => {
      if (this.privateWs !== socket) return;
      this.privateWs = null;
      if (this.privatePingTimer) clearInterval(this.privatePingTimer);
      this.privatePingTimer = null;
      this.logger.warn({ mode: this.mode, kind: "close" }, "private execution ws event");
      this.schedulePrivateReconnect();
    });

    socket.on("error", (error) => {
      if (this.privateWs !== socket) return;
      this.status = "error";
      this.error = String((error as Error)?.message ?? error);
      this.logger.warn(
        { mode: this.mode, kind: "error", error: this.error },
        "private execution socket error",
      );
      this.notifyListeners();
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
    this.notifyListeners();

    if (this.privateReconnectTimer) clearTimeout(this.privateReconnectTimer);
    this.privateReconnectTimer = setTimeout(() => {
      this.privateReconnectTimer = null;
      if (!this.shouldRun) return;
      this.connectPrivate();
    }, delayMs);
  }
}

class PrivateExecutionExecutorManager {
  private status: ExecutorRuntimeStatus = executorStore.getState().running ? "waiting_session" : "stopped";
  private error: string | null = executorStore.getState().error;
  private activeSettings: ExecutorSettings | null = executorStore.getState().running
    ? deepClone(executorStore.getSettings())
    : null;
  private readonly instrumentCache = new Map<string, InstrumentSpec>();
  private readonly recentFingerprints = new Map<string, { fingerprint: string; at: number }>();
  private reconcileInFlight = false;
  private queuedReason: string | null = null;
  private disposed = false;
  private readonly unsubscribeFns: Array<() => void> = [];

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly demoStream: BybitPrivateExecutionStream,
    private readonly realStream: BybitPrivateExecutionStream,
  ) {
    this.unsubscribeFns.push(
      demoStream.addListener(() => {
        if (this.activeSettings?.mode !== "demo") return;
        void this.scheduleReconcile("demo_feed_update");
      }),
    );
    this.unsubscribeFns.push(
      realStream.addListener(() => {
        if (this.activeSettings?.mode !== "real") return;
        void this.scheduleReconcile("real_feed_update");
      }),
    );
    runtime.on("state", this.handleRuntimeState);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    runtime.off("state", this.handleRuntimeState);
    for (const unsubscribe of this.unsubscribeFns) {
      try {
        unsubscribe();
      } catch {
        continue;
      }
    }
  }

  getPublicState(): ExecutorPublicState {
    const persisted = executorStore.getState();
    return {
      settings: persisted.settings,
      activeSettings: this.activeSettings ? deepClone(this.activeSettings) : null,
      desiredRunning: persisted.running,
      status: this.status,
      error: this.error ?? persisted.error ?? null,
      updatedAt: persisted.updatedAt,
    };
  }

  updateSettings(patch: Record<string, unknown>): ExecutorPublicState {
    executorStore.updateSettings(patch);
    return this.getPublicState();
  }

  async start(): Promise<ExecutorPublicState> {
    executorStore.setRunning(true);
    executorStore.setError(null);
    this.error = null;
    this.activeSettings = deepClone(executorStore.getSettings());

    if (!isRuntimeSessionActive()) {
      this.status = "waiting_session";
      return this.getPublicState();
    }

    await this.activate("manual_start");
    return this.getPublicState();
  }

  async stop(): Promise<ExecutorPublicState> {
    executorStore.setRunning(false);
    executorStore.setError(null);
    this.error = null;
    this.status = "stopped";
    this.activeSettings = null;
    this.queuedReason = null;
    this.recentFingerprints.clear();
    return this.getPublicState();
  }

  async syncFromPersisted(reason: string): Promise<void> {
    if (!executorStore.getState().running) {
      this.status = "stopped";
      this.activeSettings = null;
      return;
    }
    if (!this.activeSettings) {
      this.activeSettings = deepClone(executorStore.getSettings());
    }
    if (!isRuntimeSessionActive()) {
      this.status = "waiting_session";
      return;
    }
    await this.activate(reason);
  }

  private readonly handleRuntimeState = () => {
    if (!executorStore.getState().running) {
      this.status = "stopped";
      this.activeSettings = null;
      return;
    }
    if (!isRuntimeSessionActive()) {
      this.status = "waiting_session";
      return;
    }
    void this.activate("runtime_state");
  };

  private getActiveStream(mode: ExecutionMode): BybitPrivateExecutionStream {
    return mode === "real" ? this.realStream : this.demoStream;
  }

  private ensureActiveSettings(): ExecutorSettings {
    if (!this.activeSettings) {
      this.activeSettings = deepClone(executorStore.getSettings());
    }
    return this.activeSettings;
  }

  private handleExecutorError(reason: string, error: unknown): void {
    this.status = "error";
    this.error = String((error as Error)?.message ?? error);
    executorStore.setError(this.error);
    this.logger.error(
      {
        reason,
        error: this.error,
      },
      "private execution executor reconcile failed",
    );
  }

  private async activate(reason: string): Promise<void> {
    if (this.disposed || !executorStore.getState().running) return;
    if (!isRuntimeSessionActive()) {
      this.status = "waiting_session";
      return;
    }

    try {
      const settings = this.ensureActiveSettings();
      const stream = this.getActiveStream(settings.mode);
      this.status = "starting";
      stream.ensureStarted();
      await stream.forceRefresh(`executor_${reason}_startup_refresh`);
      await this.scheduleReconcile(`executor_${reason}`);
      if (executorStore.getState().running && isRuntimeSessionActive() && this.error == null) {
        this.status = "running";
      }
    } catch (error) {
      this.handleExecutorError(`activate:${reason}`, error);
      throw error;
    }
  }

  private isDuplicateFingerprint(positionKey: string, fingerprint: string): boolean {
    const current = this.recentFingerprints.get(positionKey);
    const now = Date.now();
    return Boolean(
      current &&
      current.fingerprint === fingerprint &&
      now - current.at <= EXECUTOR_ACTION_DEDUPE_MS,
    );
  }

  private rememberFingerprint(positionKey: string, fingerprint: string): void {
    this.recentFingerprints.set(positionKey, {
      fingerprint,
      at: Date.now(),
    });
  }

  private async applyTradingStopPatch(args: {
    restClient: ExecutionRestClient;
    symbol: string;
    positionIdx: number;
    patch: Record<string, unknown>;
  }): Promise<void> {
    this.logger.info(
      {
        symbol: args.symbol,
        positionIdx: args.positionIdx,
        patch: args.patch,
      },
      "private execution executor apply trading stop patch",
    );
    await args.restClient.setTradingStopLinear({
      symbol: args.symbol,
      positionIdx: args.positionIdx,
      ...args.patch,
    });
  }

  private async scheduleReconcile(reason: string): Promise<void> {
    if (this.disposed || !executorStore.getState().running) return;
    if (!isRuntimeSessionActive()) {
      this.status = "waiting_session";
      return;
    }
    if (this.reconcileInFlight) {
      this.queuedReason = reason;
      return;
    }

    this.reconcileInFlight = true;
    try {
      let nextReason: string | null = reason;
      while (nextReason) {
        this.queuedReason = null;
        try {
          await this.reconcile(nextReason);
        } catch (error) {
          this.handleExecutorError(`reconcile:${nextReason}`, error);
          return;
        }
        nextReason = this.queuedReason;
      }
    } finally {
      this.reconcileInFlight = false;
    }
  }

  private async reconcile(reason: string): Promise<void> {
    if (this.disposed || !executorStore.getState().running) return;
    if (!isRuntimeSessionActive()) {
      this.status = "waiting_session";
      return;
    }

    const settings = this.ensureActiveSettings();
    const stream = this.getActiveStream(settings.mode);
    const restClient = stream.getRestClient();

    if (!restClient || !restClient.hasCredentials()) {
      this.status = "error";
      this.error = "missing_credentials";
      executorStore.setError(this.error);
      return;
    }

    const positions = stream.getPositionsDetailed().filter((row) => Number(row.size ?? 0) > 0);
    const rawOrders = stream.getRawOrdersDetailed();
    const currentKeys = new Set<string>(positions.map((row) => row.key));
    const staleKeys = Object.keys(executorStore.getState().positionStates).filter((key) => !currentKeys.has(key));
    if (staleKeys.length > 0) {
      executorStore.removePositionStates(staleKeys);
    }

    let actions = 0;
    for (const position of positions) {
      const symbolOrders = rawOrders.filter((row) => row.symbol === position.symbol);
      actions += await this.reconcilePosition(position, symbolOrders, settings, restClient);
    }

    if (actions > 0) {
      await stream.forceRefresh(`executor_post_action_${reason}`);
    }

    this.status = "running";
    this.error = null;
    executorStore.setError(null);
  }

  private async reconcilePosition(
    position: StoredPositionRow,
    symbolOrders: StoredRawOrder[],
    settings: ExecutorSettings,
    restClient: ExecutionRestClient,
  ): Promise<number> {
    if (!Number.isFinite(position.entryPrice as number) || Number(position.entryPrice) <= 0) {
      return 0;
    }
    if (!Number.isFinite(position.size as number) || Number(position.size) <= 0) {
      executorStore.setPositionState(position.key, null);
      return 0;
    }

    const instrument = await this.getInstrumentSpec(settings.mode, restClient, position.symbol);
    const positionIdx = position.positionIdx != null ? Math.floor(position.positionIdx) : parsePositionIdxFromKey(position.key);
    const tickSize = instrument.tickSize;
    const qtyStep = instrument.qtyStep;
    const executorOrders = symbolOrders.filter((order) => isExecutorOrderLinkId(order.orderLinkId));

    switch (settings.exit) {
      case "trailing":
        executorStore.setPositionState(position.key, null);
        return await this.ensureTrailingOnly({
          position,
          restClient,
          positionIdx,
          distancePct: settings.slPct,
          anchorPrice: Number(position.entryPrice),
          tickSize,
          fingerprint: `trailing:${position.key}:${settings.slPct}`,
          executorOrders,
        });

      case "partial_and_trailing":
        return await this.ensurePartialAndTrailing({
          position,
          symbolOrders,
          restClient,
          positionIdx,
          tickSize,
          qtyStep,
          settings,
        });

      default:
        executorStore.setPositionState(position.key, null);
        return await this.ensureFullTpSl({
          position,
          restClient,
          positionIdx,
          tickSize,
          settings,
          executorOrders,
        });
    }
  }

  private async ensureFullTpSl(args: {
    position: StoredPositionRow;
    restClient: ExecutionRestClient;
    positionIdx: number;
    tickSize: number;
    settings: ExecutorSettings;
    executorOrders: StoredRawOrder[];
  }): Promise<number> {
    const targetTp = roundNearestToStep(
      computeTpPrice(Number(args.position.entryPrice), args.position.side, args.settings.tpPct),
      args.tickSize,
    );
    const targetSl = roundNearestToStep(
      computeSlPrice(Number(args.position.entryPrice), args.position.side, args.settings.slPct),
      args.tickSize,
    );

    const fingerprint = `full:${args.position.key}:${targetTp}:${targetSl}`;
    const needsTpUpdate = !sameWithinStep(args.position.tp, targetTp, args.tickSize);
    const needsSlUpdate = !sameWithinStep(args.position.sl, targetSl, args.tickSize);
    const needsTrailingClear = (args.position.trailingStop ?? null) != null;
    const needsExecutorOrderCancel = args.executorOrders.length > 0;

    if (!needsTpUpdate && !needsSlUpdate && !needsTrailingClear && !needsExecutorOrderCancel) {
      return 0;
    }
    if (this.isDuplicateFingerprint(args.position.key, fingerprint)) {
      return 0;
    }

    let actions = 0;

    if (needsExecutorOrderCancel) {
      actions += await this.cancelOrders(args.restClient, args.position.symbol, args.executorOrders);
    }

    if (needsTrailingClear) {
      await this.applyTradingStopPatch({
        restClient: args.restClient,
        symbol: args.position.symbol,
        positionIdx: args.positionIdx,
        patch: {
          trailingStop: "0",
        },
      });
      actions += 1;
    }

    if (needsTpUpdate) {
      await this.applyTradingStopPatch({
        restClient: args.restClient,
        symbol: args.position.symbol,
        positionIdx: args.positionIdx,
        patch: {
          tpslMode: "Full",
          takeProfit: formatForApi(targetTp),
          tpTriggerBy: "LastPrice",
        },
      });
      actions += 1;
    }

    if (needsSlUpdate) {
      await this.applyTradingStopPatch({
        restClient: args.restClient,
        symbol: args.position.symbol,
        positionIdx: args.positionIdx,
        patch: {
          tpslMode: "Full",
          stopLoss: formatForApi(targetSl),
          slTriggerBy: "LastPrice",
        },
      });
      actions += 1;
    }

    if (actions > 0) {
      this.rememberFingerprint(args.position.key, fingerprint);
    }
    return actions;
  }

  private async ensureTrailingOnly(args: {
    position: StoredPositionRow;
    restClient: ExecutionRestClient;
    positionIdx: number;
    distancePct: number;
    anchorPrice: number;
    tickSize: number;
    fingerprint: string;
    executorOrders: StoredRawOrder[];
  }): Promise<number> {
    const targetDistance = computeTrailingDistance(args.anchorPrice, args.distancePct, args.tickSize);
    const fingerprint = `${args.fingerprint}:${targetDistance}`;
    const needsTpClear = (args.position.tp ?? null) != null;
    const needsSlClear = (args.position.sl ?? null) != null;
    const needsTrailingUpdate = !sameWithinStep(args.position.trailingStop, targetDistance, args.tickSize);
    const needsExecutorOrderCancel = args.executorOrders.length > 0;

    if (!needsTpClear && !needsSlClear && !needsTrailingUpdate && !needsExecutorOrderCancel) {
      return 0;
    }
    if (this.isDuplicateFingerprint(args.position.key, fingerprint)) {
      return 0;
    }

    let actions = 0;

    if (needsExecutorOrderCancel) {
      actions += await this.cancelOrders(args.restClient, args.position.symbol, args.executorOrders);
    }

    if (needsTpClear) {
      await this.applyTradingStopPatch({
        restClient: args.restClient,
        symbol: args.position.symbol,
        positionIdx: args.positionIdx,
        patch: {
          tpslMode: "Full",
          takeProfit: "0",
        },
      });
      actions += 1;
    }

    if (needsSlClear) {
      await this.applyTradingStopPatch({
        restClient: args.restClient,
        symbol: args.position.symbol,
        positionIdx: args.positionIdx,
        patch: {
          tpslMode: "Full",
          stopLoss: "0",
        },
      });
      actions += 1;
    }

    if (needsTrailingUpdate) {
      await this.applyTradingStopPatch({
        restClient: args.restClient,
        symbol: args.position.symbol,
        positionIdx: args.positionIdx,
        patch: {
          tpslMode: "Full",
          trailingStop: formatForApi(targetDistance),
        },
      });
      actions += 1;
    }

    if (actions > 0) {
      this.rememberFingerprint(args.position.key, fingerprint);
    }
    return actions;
  }

  private async ensurePartialAndTrailing(args: {
    position: StoredPositionRow;
    symbolOrders: StoredRawOrder[];
    restClient: ExecutionRestClient;
    positionIdx: number;
    tickSize: number;
    qtyStep: number;
    settings: ExecutorSettings;
  }): Promise<number> {
    const persistedState = executorStore.getState().positionStates[args.position.key] ?? null;
    const positionSize = Number(args.position.size);
    const entryPrice = Number(args.position.entryPrice);
    const targetTp = roundNearestToStep(
      computeTpPrice(entryPrice, args.position.side, args.settings.tpPct),
      args.tickSize,
    );
    const targetSl = roundNearestToStep(
      computeSlPrice(entryPrice, args.position.side, args.settings.slPct),
      args.tickSize,
    );
    const targetQty = Math.max(
      args.qtyStep,
      roundDownToStep(positionSize * 0.7, args.qtyStep),
    );

    let nextState: ExecutorManagedPositionState = persistedState ?? {
      key: args.position.key,
      symbol: args.position.symbol,
      side: args.position.side,
      stage: "partial_pending",
      initialSize: positionSize,
      lastSize: positionSize,
      entryPrice,
      updatedAt: Date.now(),
    };

    const sameEntry = sameWithinStep(nextState.entryPrice, entryPrice, args.tickSize);
    if (!sameEntry || nextState.symbol !== args.position.symbol) {
      nextState = {
        key: args.position.key,
        symbol: args.position.symbol,
        side: args.position.side,
        stage: "partial_pending",
        initialSize: positionSize,
        lastSize: positionSize,
        entryPrice,
        updatedAt: Date.now(),
      };
    }

    if (
      nextState.stage === "partial_pending" &&
      positionSize < nextState.lastSize - Math.max(args.qtyStep / 2, 1e-9)
    ) {
      nextState = {
        ...nextState,
        stage: "trailing_active",
        lastSize: positionSize,
        updatedAt: Date.now(),
      };
      executorStore.setPositionState(args.position.key, nextState);
    }

    if (nextState.stage === "trailing_active") {
      const trailingAnchorPrice = computeTpPrice(entryPrice, args.position.side, args.settings.tpPct);
      const actions = await this.ensureTrailingOnly({
        position: args.position,
        restClient: args.restClient,
        positionIdx: args.positionIdx,
        distancePct: args.settings.tpPct,
        anchorPrice: trailingAnchorPrice,
        tickSize: args.tickSize,
        fingerprint: `partial_trailing:${args.position.key}:${args.settings.tpPct}`,
        executorOrders: args.symbolOrders.filter((order) => isExecutorOrderLinkId(order.orderLinkId)),
      });
      executorStore.setPositionState(args.position.key, {
        ...nextState,
        lastSize: positionSize,
        updatedAt: Date.now(),
      });
      return actions;
    }

    nextState = {
      ...nextState,
      stage: "partial_pending",
      lastSize: positionSize,
      updatedAt: Date.now(),
    };
    executorStore.setPositionState(args.position.key, nextState);

    const exitOrders = args.symbolOrders.filter(isRelevantRawExitOrder);
    const exitSide = getExitOrderSide(args.position.side);
    const managedOrder = exitOrders.find((order) => {
      if (!isExecutorOrderLinkId(order.orderLinkId)) return false;
      if (String(order.side ?? "").trim().toUpperCase() !== exitSide.toUpperCase()) return false;
      if (String(order.orderType ?? "").trim().toUpperCase() !== "LIMIT") return false;
      const orderPrice = order.price ?? order.triggerPrice ?? null;
      const orderQty = order.qty ?? order.leavesQty ?? null;
      return sameWithinStep(orderPrice, targetTp, args.tickSize) && sameWithinStep(orderQty, targetQty, args.qtyStep);
    }) ?? null;

    const conflictingOrders = exitOrders.filter((order) => order.key !== managedOrder?.key);
    const needsTakeProfitClear = (args.position.tp ?? null) != null;
    const needsTrailingClear = (args.position.trailingStop ?? null) != null;
    const needsStopLossUpdate = !sameWithinStep(args.position.sl, targetSl, args.tickSize);

    if (!managedOrder || conflictingOrders.length > 0 || needsTakeProfitClear || needsTrailingClear || needsStopLossUpdate) {
      const fingerprint = `partial_pending:${args.position.key}:${targetTp}:${targetSl}:${targetQty}`;
      if (this.isDuplicateFingerprint(args.position.key, fingerprint)) {
        return 0;
      }

      let actions = 0;
      actions += await this.cancelOrders(args.restClient, args.position.symbol, conflictingOrders);

      if (needsTakeProfitClear) {
        await this.applyTradingStopPatch({
          restClient: args.restClient,
          symbol: args.position.symbol,
          positionIdx: args.positionIdx,
          patch: {
            tpslMode: "Full",
            takeProfit: "0",
          },
        });
        actions += 1;
      }

      if (needsTrailingClear) {
        await this.applyTradingStopPatch({
          restClient: args.restClient,
          symbol: args.position.symbol,
          positionIdx: args.positionIdx,
          patch: {
            trailingStop: "0",
          },
        });
        actions += 1;
      }

      if (needsStopLossUpdate) {
        await this.applyTradingStopPatch({
          restClient: args.restClient,
          symbol: args.position.symbol,
          positionIdx: args.positionIdx,
          patch: {
            tpslMode: "Full",
            stopLoss: formatForApi(targetSl),
            slTriggerBy: "LastPrice",
          },
        });
        actions += 1;
      }

      if (!managedOrder) {
        this.logger.info(
          {
            symbol: args.position.symbol,
            positionIdx: args.positionIdx,
            targetQty,
            targetTp,
          },
          "private execution executor place partial tp order",
        );
        await args.restClient.placeOrderLinear({
          symbol: args.position.symbol,
          side: exitSide,
          orderType: "Limit",
          qty: formatForApi(targetQty),
          price: formatForApi(targetTp),
          timeInForce: "GTC",
          reduceOnly: true,
          positionIdx: args.positionIdx,
          orderLinkId: `${EXECUTOR_ORDER_LINK_PREFIX}:partial:${args.position.symbol}:${Date.now()}`,
        });
        actions += 1;
      }

      if (actions > 0) {
        this.rememberFingerprint(args.position.key, fingerprint);
      }
      return actions;
    }

    return 0;
  }

  private async cancelOrders(
    restClient: ExecutionRestClient,
    symbol: string,
    orders: StoredRawOrder[],
  ): Promise<number> {
    let cancelled = 0;
    for (const order of orders) {
      const orderId = String(order.orderId ?? "").trim();
      const orderLinkId = String(order.orderLinkId ?? "").trim();
      if (!orderId && !orderLinkId) continue;
      this.logger.info(
        {
          symbol,
          orderId: orderId || null,
          orderLinkId: orderLinkId || null,
        },
        "private execution executor cancel order",
      );
      await restClient.cancelOrderLinear({
        symbol,
        ...(orderId ? { orderId } : {}),
        ...(orderLinkId ? { orderLinkId } : {}),
      });
      cancelled += 1;
    }
    return cancelled;
  }

  private async getInstrumentSpec(
    mode: ExecutionMode,
    restClient: ExecutionRestClient,
    symbol: string,
  ): Promise<InstrumentSpec> {
    const key = `${mode}:${symbol}`;
    const cached = this.instrumentCache.get(key);
    if (cached) return cached;

    const rows = await restClient.getInstrumentsInfoLinear({ symbol });
    const row = Array.isArray(rows) ? rows[0] : null;
    const spec = row && typeof row === "object" ? parseInstrumentSpec(row) : { tickSize: 0.01, qtyStep: 0.001 };
    this.instrumentCache.set(key, spec);
    return spec;
  }
}

let executorManager: PrivateExecutionExecutorManager | null = null;

function fallbackExecutorState(): ExecutorPublicState {
  const persisted = executorStore.getState();
  return {
    settings: persisted.settings,
    activeSettings: null,
    desiredRunning: persisted.running,
    status: persisted.running ? "waiting_session" : "stopped",
    error: persisted.error,
    updatedAt: persisted.updatedAt,
  };
}

export function getExecutionExecutorState(): ExecutorPublicState {
  return executorManager?.getPublicState() ?? fallbackExecutorState();
}

export function updateExecutionExecutorSettings(patch: Record<string, unknown>): ExecutorPublicState {
  return executorManager?.updateSettings(patch) ?? fallbackExecutorState();
}

export async function startExecutionExecutor(): Promise<ExecutorPublicState> {
  if (!executorManager) {
    throw new Error("executor_not_ready");
  }
  return await executorManager.start();
}

export async function stopExecutionExecutor(): Promise<ExecutorPublicState> {
  if (!executorManager) {
    return fallbackExecutorState();
  }
  return await executorManager.stop();
}

export function createPrivatePositionsWs(app: {
  addHook: (name: "onReady" | "onClose", hook: () => Promise<void>) => void;
  log: FastifyBaseLogger;
}) {
  const clients = new Map<WebSocket, ExecutionMode>();

  const realRestClient = new BybitRealRestClient() as unknown as ExecutionRestClient;
  const demoRestClient = new BybitDemoRestClient() as unknown as ExecutionRestClient;

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

  executorManager = new PrivateExecutionExecutorManager(app.log, demoStream, realStream);

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
    await executorManager?.syncFromPersisted("app_ready");

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
    executorManager?.dispose();
    executorManager = null;

    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });
}
