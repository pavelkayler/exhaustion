
import { createHmac } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { BybitDemoRestClient } from "../bybit/BybitDemoRestClient.js";
import { BybitRealRestClient } from "../bybit/BybitRealRestClient.js";
import { runtime } from "../runtime/runtime.js";
import {
  executorStore,
  type ExecutionMode,
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
  getOpenOrdersLinear(params?: {
    symbol?: string;
    settleCoin?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ list: Array<Record<string, unknown>> }>;
  getInstrumentsInfoLinear(params?: { symbol?: string }): Promise<Array<Record<string, unknown>>>;
  placeOrderLinear(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancelOrderLinear(params: Record<string, unknown>): Promise<unknown>;
  setLeverageLinear(params: Record<string, unknown>): Promise<unknown>;
  setTradingStopLinear(params: Record<string, unknown>): Promise<unknown>;
};

type StoredPositionRow = ExecutionPositionRow & {
  leverage: number | null;
  updatedAt: number;
};

type StoredOrderRow = ExecutionOrderRow & {
  orderId: string | null;
  orderLinkId: string | null;
  side: string | null;
  orderType: string | null;
  updatedAt: number;
};

type InstrumentSpec = {
  tickSize: number;
  qtyStep: number;
};

type TrailingReconcileSummary = {
  total: number;
  attempted: number;
  failed: number;
  pending: number;
};

const POSITIONS_WS_PATH = "/ws/private-positions";
const PRIVATE_WS_PING_INTERVAL_MS = 20_000;
const CLIENT_BROADCAST_INTERVAL_MS = 1_000;
const REST_REFRESH_INTERVAL_MS = 60_000;
const TRAILING_RECONCILE_RETRY_MS = 5_000;
const TRAILING_RECONCILE_DEBOUNCE_MS = 250;
const ORDER_MAINTENANCE_INTERVAL_MS = 30_000;
const EXECUTOR_ORDER_LINK_PREFIX = "executor";

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

  const orderLinkId = String(row.orderLinkId ?? row.positionLinkId ?? row.orderTag ?? "")
    .trim()
    .toLowerCase();

  if (orderLinkId.includes("candidate")) return "candidate";
  if (orderLinkId.includes("final")) return "final";
  return "manual";
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
    return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  }
  if (value && typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [];
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
    readPositiveNumber(row.updatedTime)
    ?? readPositiveNumber(row.updatedAt)
    ?? readPositiveNumber(row.ts)
    ?? readPositiveNumber(row.transactTime)
    ?? readPositiveNumber(row.createdTime)
    ?? readPositiveNumber(row.createdAt)
    ?? fallbackTs
  );
}

function hasOwnField(row: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function firstPresentField(row: Record<string, unknown>, keys: string[]): { present: boolean; value: unknown } {
  for (const key of keys) {
    if (hasOwnField(row, key)) {
      return { present: true, value: row[key] };
    }
  }
  return { present: false, value: undefined };
}

function mergeNullableNumber(
  previous: number | null,
  row: Record<string, unknown>,
  keys: string[],
  options?: { positiveOnly?: boolean },
): number | null {
  const next = firstPresentField(row, keys);
  if (!next.present) return previous;
  const numeric = readNumber(next.value);
  if (numeric == null) return null;
  if (options?.positiveOnly) return numeric > 0 ? numeric : null;
  return numeric;
}

function mergeNullableString(
  previous: string | null,
  row: Record<string, unknown>,
  keys: string[],
): string | null {
  const next = firstPresentField(row, keys);
  if (!next.present) return previous;
  const text = String(next.value ?? "").trim();
  return text ? text.toUpperCase() : null;
}

function normalizePositionRow(
  row: Record<string, unknown>,
  previous: StoredPositionRow | null,
  receivedAt: number,
): StoredPositionRow | null {
  const symbol = String(row.symbol ?? previous?.symbol ?? "").trim().toUpperCase();
  const key = toPositionKey({ ...previous, ...row });
  const side = mergeNullableString(previous?.side ?? null, row, ["side"]);
  const size = mergeNullableNumber(previous?.size ?? null, row, ["size"]);
  if (!symbol || !side || side === "NONE" || !Number.isFinite(size as number) || Number(size) <= 0) {
    return null;
  }

  const updatedAt = readRowUpdatedAt(row, receivedAt);

  return {
    key,
    symbol,
    reason: inferReason(row),
    value: mergeNullableNumber(previous?.value ?? null, row, ["positionValue", "positionBalance", "positionIM"]),
    pnl: mergeNullableNumber(previous?.pnl ?? null, row, ["unrealisedPnl"]),
    tp: mergeNullableNumber(previous?.tp ?? null, row, ["takeProfit"], { positiveOnly: true }),
    sl: mergeNullableNumber(previous?.sl ?? null, row, ["stopLoss"], { positiveOnly: true }),
    trailingStop: mergeNullableNumber(previous?.trailingStop ?? null, row, ["trailingStop"], { positiveOnly: true }),
    side,
    size,
    entryPrice: mergeNullableNumber(previous?.entryPrice ?? null, row, ["avgPrice"], { positiveOnly: true }),
    markPrice: mergeNullableNumber(previous?.markPrice ?? null, row, ["markPrice"], { positiveOnly: true }),
    positionIdx: mergeNullableNumber(previous?.positionIdx ?? null, row, ["positionIdx"]),
    updatedAt,
    leverage: mergeNullableNumber(previous?.leverage ?? null, row, ["leverage"], { positiveOnly: true }),
  };
}

function isActiveOrderStatus(value: unknown): boolean {
  const status = String(value ?? "").trim().toUpperCase();
  if (!status) return true;
  return (
    status === "NEW"
    || status === "PARTIALLYFILLED"
    || status === "UNTRIGGERED"
    || status === "TRIGGERED"
    || status === "ACTIVE"
    || status === "CREATED"
  );
}

function isDisplayableLimitOrder(row: Record<string, unknown>): boolean {
  const orderType = String(row.orderType ?? "").trim().toUpperCase();
  const stopOrderType = String(row.stopOrderType ?? "").trim().toUpperCase();
  const orderFilter = String(row.orderFilter ?? "").trim().toUpperCase();
  if (orderType !== "LIMIT") return false;
  if (readBooleanFlag(row.reduceOnly) || readBooleanFlag(row.closeOnTrigger)) return false;
  if (stopOrderType) return false;
  if (orderFilter === "TPSLORDER" || orderFilter === "STOPORDER") return false;
  return true;
}

function normalizeOrderRow(
  row: Record<string, unknown>,
  leverageFallbackBySymbol: Map<string, number | null>,
  receivedAt: number,
): StoredOrderRow | null {
  if (!isActiveOrderStatus(row.orderStatus)) return null;
  if (!isDisplayableLimitOrder(row)) return null;

  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;

  const key = toOrderKey(row);
  const entryPrice =
    readPositiveNumber(row.price)
    ?? readPositiveNumber(row.orderPrice)
    ?? readPositiveNumber(row.basePrice);

  const qty =
    readPositiveNumber(row.qty)
    ?? readPositiveNumber(row.orderQty)
    ?? readPositiveNumber(row.leavesQty)
    ?? readPositiveNumber(row.size);

  const value =
    readPositiveNumber(row.orderValue)
    ?? ((entryPrice != null && qty != null) ? entryPrice * qty : null);

  const leverage = readPositiveNumber(row.leverage) ?? leverageFallbackBySymbol.get(symbol) ?? null;
  const margin =
    readPositiveNumber(row.orderMargin)
    ?? readPositiveNumber(row.orderIM)
    ?? readPositiveNumber(row.positionIM)
    ?? readPositiveNumber(row.positionBalance)
    ?? readPositiveNumber(row.requiredMargin)
    ?? readPositiveNumber(row.initialMargin)
    ?? readPositiveNumber(row.leavesValue)
    ?? (value != null && leverage != null && leverage > 0 ? value / leverage : null);

  return {
    key,
    symbol,
    reason: inferReason(row),
    value,
    margin,
    leverage,
    entryPrice,
    placedAt:
      readNumber(row.createdTime)
      ?? readNumber(row.createdAt)
      ?? readNumber(row.placeTime)
      ?? readNumber(row.updatedTime),
    updatedAt: readRowUpdatedAt(row, receivedAt),
    orderId: String(row.orderId ?? "").trim() || null,
    orderLinkId: String(row.orderLinkId ?? "").trim() || null,
    side: String(row.side ?? "").trim().toUpperCase() || null,
    orderType: String(row.orderType ?? "").trim().toUpperCase() || null,
  };
}

function parseInstrumentSpec(raw: Record<string, unknown>): InstrumentSpec {
  const priceFilter = (
    raw.priceFilter && typeof raw.priceFilter === "object" ? raw.priceFilter : {}
  ) as Record<string, unknown>;
  const lotSizeFilter = (
    raw.lotSizeFilter && typeof raw.lotSizeFilter === "object" ? raw.lotSizeFilter : {}
  ) as Record<string, unknown>;
  return {
    tickSize: readPositiveNumber(priceFilter.tickSize ?? raw.tickSize) ?? 0.01,
    qtyStep: readPositiveNumber(lotSizeFilter.qtyStep ?? raw.qtyStep) ?? 0.001,
  };
}

function isRuntimeSessionActive(): boolean {
  const state = runtime.getStatus().sessionState;
  return state === "RUNNING" || state === "PAUSED" || state === "PAUSING" || state === "RESUMING";
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

function computeTrailingDistance(entryPrice: number, slPct: number): number {
  return entryPrice * (Math.max(0, slPct) / 100);
}

function roundDownToStep(value: number, step: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;
  const precision = stepPrecision(step);
  return Number((Math.floor(value / step) * step).toFixed(precision));
}

function normalizeSignalState(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function isCandidateSignalState(state: string): boolean {
  return state === "CANDIDATE" || state === "WATCHLIST" || state === "CONFIRMED";
}

function isFinalSignalState(state: string): boolean {
  return state === "SOFT_FINAL" || state === "FINAL";
}

function resolveSignalExecutionReason(state: string): ExecutionReason | null {
  if (isFinalSignalState(state)) return "final";
  if (isCandidateSignalState(state)) return "candidate";
  return null;
}

function resolveSignalReferencePrice(payload: Record<string, unknown>): number | null {
  const priceContext = (
    payload.priceContext && typeof payload.priceContext === "object" ? payload.priceContext : {}
  ) as Record<string, unknown>;
  const snapshot = (
    payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot : {}
  ) as Record<string, unknown>;
  const metrics = (
    snapshot.metrics && typeof snapshot.metrics === "object" ? snapshot.metrics : {}
  ) as Record<string, unknown>;
  return (
    readPositiveNumber(priceContext.midPrice)
    ?? readPositiveNumber(priceContext.markPrice)
    ?? readPositiveNumber(priceContext.lastPrice)
    ?? readPositiveNumber(metrics.markPrice)
    ?? readPositiveNumber(metrics.lastPrice)
  );
}

function isExecutorManagedOrder(row: StoredOrderRow): boolean {
  return row.reason === "candidate" || row.reason === "final";
}

function buildExecutorOrderLinkId(reason: ExecutionReason, symbol: string, batchTs: number, index: number): string {
  return `${EXECUTOR_ORDER_LINK_PREFIX}_${reason}_${symbol}_${batchTs}_${index}`;
}

function buildCancelOrderParams(row: StoredOrderRow): Record<string, unknown> | null {
  if (row.orderId) {
    return { symbol: row.symbol, orderId: row.orderId };
  }
  if (row.orderLinkId) {
    return { symbol: row.symbol, orderLinkId: row.orderLinkId };
  }
  return null;
}

function computeShortEntryPrice(referencePrice: number, offsetPct: number): number {
  return referencePrice * (1 + (Math.max(0, offsetPct) / 100));
}

function mergeStoredPositionRows(
  primary: StoredPositionRow,
  secondary: StoredPositionRow,
): StoredPositionRow {
  return {
    ...primary,
    reason: primary.reason ?? secondary.reason,
    value: primary.value ?? secondary.value,
    pnl: primary.pnl ?? secondary.pnl,
    tp: primary.tp ?? secondary.tp,
    sl: primary.sl ?? secondary.sl,
    trailingStop: primary.trailingStop ?? secondary.trailingStop,
    side: primary.side ?? secondary.side,
    size: primary.size ?? secondary.size,
    entryPrice: primary.entryPrice ?? secondary.entryPrice,
    markPrice: primary.markPrice ?? secondary.markPrice,
    positionIdx: primary.positionIdx ?? secondary.positionIdx,
    leverage: primary.leverage ?? secondary.leverage,
    updatedAt: Math.max(primary.updatedAt, secondary.updatedAt),
  };
}

function resolvePositionIdx(position: StoredPositionRow): number {
  if (Number.isFinite(position.positionIdx as number)) {
    return Math.max(0, Math.floor(Number(position.positionIdx)));
  }
  const side = String(position.side ?? "").trim().toUpperCase();
  if (side === "BUY") return 1;
  if (side === "SELL") return 2;
  return 0;
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

  private readonly restOrders = new Map<string, StoredOrderRow>();
  private readonly wsOrders = new Map<string, StoredOrderRow>();
  private readonly orderDeletes = new Map<string, number>();
  private readonly restLeverageHints = new Map<string, number | null>();
  private readonly wsLeverageHints = new Map<string, number | null>();

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

  private notifyListeners(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        continue;
      }
    }
  }

  private rememberLeverageHint(target: Map<string, number | null>, row: Record<string, unknown>): void {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    const leverage = readPositiveNumber(row.leverage);
    if (!symbol || leverage == null) return;
    target.set(symbol, leverage);
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
    void this.refreshFromExchange("startup", { includeOrders: true });
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
    } catch {
      return;
    }
    this.privateWs = null;
  }

  async forceRefresh(reason: string, options?: { includeOrders?: boolean }): Promise<PositionsSnapshot> {
    this.ensureStarted();
    await this.refreshFromExchange(reason, { includeOrders: options?.includeOrders ?? true });
    return this.getSnapshot();
  }

  getPositionsDetailed(): StoredPositionRow[] {
    return this.getMergedPositions();
  }

  getOrdersDetailed(): StoredOrderRow[] {
    return this.getMergedOrders();
  }

  applyOptimisticProtection(key: string, patch: { tp?: number | null; sl?: number | null; trailingStop?: number | null }): void {
    const current = this.getMergedPositions().find((row) => row.key === key);
    if (!current) return;
    const updated: StoredPositionRow = {
      ...current,
      ...(Object.prototype.hasOwnProperty.call(patch, "tp") ? { tp: patch.tp ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "sl") ? { sl: patch.sl ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "trailingStop") ? { trailingStop: patch.trailingStop ?? null } : {}),
      updatedAt: Date.now(),
    };
    this.positionDeletes.delete(key);
    this.wsPositions.set(key, updated);
    this.updatedAt = updated.updatedAt;
    this.notifyListeners();
  }

  getSnapshot(): PositionsSnapshot {
    return {
      mode: this.mode,
      status: this.status,
      updatedAt: this.updatedAt,
      positions: this.getMergedPositions().map((row) => ({
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
      })),
      orders: this.getMergedOrders().map((row) => ({
        key: row.key,
        symbol: row.symbol,
        reason: row.reason,
        value: row.value,
        margin: row.margin,
        leverage: row.leverage,
        entryPrice: row.entryPrice,
        placedAt: row.placedAt,
        updatedAt: row.updatedAt,
      })),
      error: this.error,
    };
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

      if (restAllowed && wsAllowed) {
        const primary = wsRow!.updatedAt >= restRow!.updatedAt ? wsRow! : restRow!;
        const secondary = primary === wsRow ? restRow! : wsRow!;
        visible.set(key, mergeStoredPositionRows(primary, secondary));
        continue;
      }
      if (wsAllowed) {
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

    const leverageFallbackBySymbol = this.buildLeverageFallbackBySymbol();

    return Array.from(visible.values())
      .map((row) => {
        const leverage = row.leverage ?? leverageFallbackBySymbol.get(row.symbol) ?? null;
        const margin =
          row.margin
          ?? ((row.value != null && leverage != null && leverage > 0) ? row.value / leverage : null);
        if (leverage === row.leverage && margin === row.margin) {
          return row;
        }
        return {
          ...row,
          leverage,
          margin,
        };
      })
      .sort((left, right) => {
        const symbolCmp = left.symbol.localeCompare(right.symbol);
        if (symbolCmp !== 0) return symbolCmp;
        return Number(left.placedAt ?? 0) - Number(right.placedAt ?? 0);
      });
  }

  private buildLeverageFallbackBySymbol(): Map<string, number | null> {
    const fallback = new Map<string, number | null>();
    for (const [symbol, leverage] of this.restLeverageHints.entries()) {
      fallback.set(symbol, leverage);
    }
    for (const [symbol, leverage] of this.wsLeverageHints.entries()) {
      fallback.set(symbol, leverage);
    }
    for (const position of this.getMergedPositions()) {
      if (position.leverage != null) {
        fallback.set(position.symbol, position.leverage);
      }
    }
    return fallback;
  }

  private async refreshFromExchange(
    reason: string,
    options?: { includeOrders?: boolean },
  ): Promise<void> {
    if (!this.shouldRun) return;
    if (!this.restClient || !this.restClient.hasCredentials()) return;

    try {
      const refreshedAt = Date.now();
      const positionsResponse = await this.restClient.getPositionsLinear({
        settleCoin: "USDT",
      });

      const nextPositions = new Map<string, StoredPositionRow>();
      const seenPositionKeys = new Set<string>();
      for (const item of Array.isArray(positionsResponse?.list) ? positionsResponse.list : []) {
        if (!item || typeof item !== "object") continue;
        this.rememberLeverageHint(this.restLeverageHints, item);
        const key = toPositionKey(item);
        seenPositionKeys.add(key);
        const normalized = normalizePositionRow(
          item,
          this.restPositions.get(key) ?? null,
          refreshedAt,
        );
        if (!normalized) continue;
        nextPositions.set(normalized.key, normalized);
      }

      for (const staleKey of this.restPositions.keys()) {
        if (!seenPositionKeys.has(staleKey)) {
          this.positionDeletes.set(staleKey, refreshedAt);
        }
      }

      this.restPositions.clear();
      for (const [key, value] of nextPositions.entries()) {
        this.positionDeletes.delete(key);
        this.restPositions.set(key, value);
      }

      let ordersCount = this.getMergedOrders().length;
      if (options?.includeOrders) {
        const leverageFallbackBySymbol = this.buildLeverageFallbackBySymbol();
        const ordersResponse = await this.restClient.getOpenOrdersLinear({
          settleCoin: "USDT",
          limit: 50,
        });
        const nextOrders = new Map<string, StoredOrderRow>();
        const seenOrderKeys = new Set<string>();
        for (const item of Array.isArray(ordersResponse?.list) ? ordersResponse.list : []) {
          if (!item || typeof item !== "object") continue;
          const key = toOrderKey(item);
          seenOrderKeys.add(key);
          const normalized = normalizeOrderRow(item, leverageFallbackBySymbol, refreshedAt);
          if (!normalized) continue;
          nextOrders.set(normalized.key, normalized);
        }
        for (const staleKey of this.restOrders.keys()) {
          if (!seenOrderKeys.has(staleKey)) {
            this.orderDeletes.set(staleKey, refreshedAt);
          }
        }
        this.restOrders.clear();
        for (const [key, value] of nextOrders.entries()) {
          this.orderDeletes.delete(key);
          this.restOrders.set(key, value);
        }
        ordersCount = nextOrders.size;
      }

      this.updatedAt = refreshedAt;
      this.error = null;
      if (this.status !== "missing_credentials") {
        this.status = "connected";
      }

      this.logger.info(
        { mode: this.mode, reason, positions: nextPositions.size, orders: ordersCount },
        "private execution exchange refresh complete",
      );
      this.notifyListeners();
    } catch (error) {
      this.logger.warn(
        { mode: this.mode, reason, error: String((error as Error)?.message ?? error) },
        "private execution exchange refresh failed",
      );
    }
  }

  private startRestRefreshLoop(): void {
    if (this.restRefreshTimer) clearInterval(this.restRefreshTimer);
    this.restRefreshTimer = setInterval(() => {
      void this.refreshFromExchange("interval_positions", { includeOrders: false });
    }, REST_REFRESH_INTERVAL_MS);
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
    const items = parseMessageItems(data);

    this.logger.info({ mode: this.mode, kind: "position", items }, "private execution ws event");

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

    for (const item of items) {
      this.rememberLeverageHint(this.wsLeverageHints, item);
      const key = toPositionKey(item);
      const normalized = normalizePositionRow(
        item,
        this.wsPositions.get(key) ?? this.restPositions.get(key) ?? null,
        receivedAt,
      );
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
    const items = parseMessageItems(data);

    this.logger.info({ mode: this.mode, kind: "order", items }, "private execution ws event");

    for (const item of items) {
      const key = toOrderKey(item);
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
    this.notifyListeners();

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

      socket.send(JSON.stringify({
        op: "auth",
        args: [this.apiKey, expires, signature],
      }));

      if (this.privatePingTimer) clearInterval(this.privatePingTimer);
      this.privatePingTimer = setInterval(() => {
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
            socket.send(JSON.stringify({
              op: "subscribe",
              args: ["position", "order", "execution"],
            }));
            return;
          }
          this.status = "error";
          this.error = String(msg.ret_msg ?? "auth_failed");
          this.notifyListeners();
          return;
        }

        if (msg.op === "subscribe") {
          this.logger.info({ mode: this.mode, kind: "subscribe", msg }, "private execution ws event");
          if (msg.success === true) {
            this.status = "connected";
            this.error = null;
            this.notifyListeners();
            void this.refreshFromExchange("subscribe_ok", { includeOrders: true });
            return;
          }
          this.status = "error";
          this.error = String(msg.ret_msg ?? "subscribe_failed");
          this.notifyListeners();
          return;
        }

        if (msg.op === "pong") return;

        if (msg.topic === "position") {
          this.handlePositionFrame(msg.data);
          return;
        }

        if (msg.topic === "order") {
          this.handleOrderFrame(msg.data);
          return;
        }

        if (msg.topic === "execution") {
          this.logger.info({ mode: this.mode, kind: "execution", data: msg.data }, "private execution ws event");
          this.updatedAt = Date.now();
          this.status = "connected";
          this.error = null;
          this.notifyListeners();
          return;
        }

        this.logger.info({ mode: this.mode, kind: "other", msg }, "private execution ws event");
      } catch (error) {
        this.status = "error";
        this.error = String((error as Error)?.message ?? error);
        this.notifyListeners();
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
      this.logger.warn({ mode: this.mode, error: this.error }, "private execution socket error");
      this.notifyListeners();
      try {
        socket.close();
      } catch {
        return;
      }
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
  private status: ExecutorRuntimeStatus = "stopped";
  private error: string | null = null;
  private activeSettings: ExecutorSettings | null = null;
  private readonly instrumentCache = new Map<string, InstrumentSpec>();
  private readonly streamUnsubscribes: Array<() => void> = [];
  private readonly openSymbolsByMode: Record<ExecutionMode, Set<string>> = {
    demo: new Set<string>(),
    real: new Set<string>(),
  };
  private readonly lastClosedAtByModeSymbol = new Map<string, number>();
  private readonly signalInFlightByModeSymbol = new Set<string>();
  private fullReconcileTimer: NodeJS.Timeout | null = null;
  private trailingReconcileTimer: NodeJS.Timeout | null = null;
  private orderMaintenanceTimer: NodeJS.Timeout | null = null;
  private fullReconcileInFlight = false;
  private trailingReconcileInFlight = false;

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly demoStream: BybitPrivateExecutionStream,
    private readonly realStream: BybitPrivateExecutionStream,
  ) {
    runtime.on("state", this.handleRuntimeState);
    runtime.on("event", this.handleRuntimeEvent);
    this.streamUnsubscribes.push(
      this.demoStream.addListener(() => {
        this.handleStreamSnapshot("demo");
      }),
      this.realStream.addListener(() => {
        this.handleStreamSnapshot("real");
      }),
    );
  }

  dispose(): void {
    runtime.off("state", this.handleRuntimeState);
    runtime.off("event", this.handleRuntimeEvent);
    for (const unsubscribe of this.streamUnsubscribes) {
      try {
        unsubscribe();
      } catch {
        continue;
      }
    }
    this.clearRuntimeTimers();
  }

  resetOnBoot(): void {
    executorStore.setRunning(false);
    executorStore.setError(null);
    executorStore.resetPositionStates();
    this.status = "stopped";
    this.error = null;
    this.activeSettings = null;
    this.signalInFlightByModeSymbol.clear();
    this.lastClosedAtByModeSymbol.clear();
    this.openSymbolsByMode.demo.clear();
    this.openSymbolsByMode.real.clear();
    this.clearRuntimeTimers();
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

    try {
      await this.activate("manual_start");
    } catch (error) {
      this.status = "error";
      this.error = String((error as Error)?.message ?? error);
      executorStore.setError(this.error);
    }
    return this.getPublicState();
  }

  async stop(): Promise<ExecutorPublicState> {
    executorStore.setRunning(false);
    executorStore.setError(null);
    this.error = null;
    this.status = "stopped";
    this.activeSettings = null;
    this.signalInFlightByModeSymbol.clear();
    this.clearRuntimeTimers();
    return this.getPublicState();
  }

  private readonly handleRuntimeState = () => {
    if (!executorStore.getState().running) {
      this.status = "stopped";
      this.activeSettings = null;
      this.clearRuntimeTimers();
      return;
    }
    if (!isRuntimeSessionActive()) {
      this.status = "waiting_session";
      this.clearRuntimeTimers();
      return;
    }
    if (this.status === "waiting_session") {
      void this.activate("runtime_ready");
      return;
    }
    this.ensureOrderMaintenanceTimer();
    this.scheduleProtectionReconcile("runtime_state", TRAILING_RECONCILE_DEBOUNCE_MS);
  };

  private readonly handleRuntimeEvent = (event: unknown) => {
    void this.processSignalTransitionEvent(event).catch((error) => {
      this.logger.error(
        { mode: this.activeSettings?.mode ?? "demo", error: String((error as Error)?.message ?? error) },
        "private execution executor signal processing failed",
      );
    });
  };

  private handleStreamSnapshot(mode: ExecutionMode): void {
    this.notePositionClosures(mode);
    const settings = this.activeSettings;
    if (!executorStore.getState().running) return;
    if (!isRuntimeSessionActive()) return;
    if (!settings || settings.mode !== mode) return;
    this.ensureOrderMaintenanceTimer();
    this.scheduleProtectionReconcile("stream_update", TRAILING_RECONCILE_DEBOUNCE_MS);
  }

  private clearRuntimeTimers(): void {
    this.clearFullReconcileTimer();
    this.clearTrailingReconcileTimer();
    if (this.orderMaintenanceTimer) {
      clearInterval(this.orderMaintenanceTimer);
      this.orderMaintenanceTimer = null;
    }
  }

  private clearFullReconcileTimer(): void {
    if (this.fullReconcileTimer) {
      clearTimeout(this.fullReconcileTimer);
      this.fullReconcileTimer = null;
    }
  }

  private clearTrailingReconcileTimer(): void {
    if (this.trailingReconcileTimer) {
      clearTimeout(this.trailingReconcileTimer);
      this.trailingReconcileTimer = null;
    }
  }

  private ensureOrderMaintenanceTimer(): void {
    if (this.orderMaintenanceTimer) return;
    this.orderMaintenanceTimer = setInterval(() => {
      void this.runOrderMaintenanceTick();
    }, ORDER_MAINTENANCE_INTERVAL_MS);
  }

  private async runOrderMaintenanceTick(): Promise<void> {
    const settings = this.activeSettings;
    if (!executorStore.getState().running) return;
    if (!settings) return;
    if (!isRuntimeSessionActive()) return;
    try {
      if (settings.cancelActivePositionOrders) {
        await this.cancelStaleOrdersIfNeeded("order_alive_tick");
      }
      this.scheduleProtectionReconcile("order_maintenance", 0);
    } catch (error) {
      this.logger.error(
        { mode: settings.mode, error: String((error as Error)?.message ?? error) },
        "private execution executor order maintenance failed",
      );
    }
  }

  private scheduleProtectionReconcile(reason: string, delayMs: number): void {
    const settings = this.activeSettings;
    if (!executorStore.getState().running) return;
    if (!settings) return;
    if (settings.exit === "full") {
      this.scheduleFullReconcile(reason, delayMs);
      return;
    }
    if (settings.exit === "trailing") {
      this.scheduleTrailingReconcile(reason, delayMs);
    }
  }

  private scheduleFullReconcile(reason: string, delayMs: number): void {
    const settings = this.activeSettings;
    if (!executorStore.getState().running) return;
    if (!settings || settings.exit !== "full") return;
    this.clearFullReconcileTimer();
    this.fullReconcileTimer = setTimeout(() => {
      this.fullReconcileTimer = null;
      void this.runFullReconcileLoop(reason);
    }, Math.max(0, delayMs));
  }

  private scheduleTrailingReconcile(reason: string, delayMs: number): void {
    const settings = this.activeSettings;
    if (!executorStore.getState().running) return;
    if (!settings || settings.exit !== "trailing") return;
    this.clearTrailingReconcileTimer();
    this.trailingReconcileTimer = setTimeout(() => {
      this.trailingReconcileTimer = null;
      void this.runTrailingReconcileLoop(reason);
    }, Math.max(0, delayMs));
  }

  private async runFullReconcileLoop(reason: string): Promise<void> {
    const settings = this.activeSettings;
    if (!executorStore.getState().running) return;
    if (!settings || settings.exit !== "full") return;
    if (!isRuntimeSessionActive()) return;

    if (this.fullReconcileInFlight) {
      this.scheduleFullReconcile(`${reason}_queued`, TRAILING_RECONCILE_RETRY_MS);
      return;
    }

    this.fullReconcileInFlight = true;
    try {
      const stream = this.getActiveStream(settings.mode);
      const summary = await this.reconcileFullPositions(stream, settings, reason);
      if (summary.pending > 0) {
        this.scheduleFullReconcile(`${reason}_retry`, TRAILING_RECONCILE_RETRY_MS);
      }
    } catch (error) {
      this.logger.error(
        { mode: settings.mode, reason, error: String((error as Error)?.message ?? error) },
        "private execution executor full reconcile loop failed",
      );
      this.scheduleFullReconcile(`${reason}_retry_error`, TRAILING_RECONCILE_RETRY_MS);
    } finally {
      this.fullReconcileInFlight = false;
    }
  }

  private async runTrailingReconcileLoop(reason: string): Promise<void> {
    const settings = this.activeSettings;
    if (!executorStore.getState().running) return;
    if (!settings || settings.exit !== "trailing") return;
    if (!isRuntimeSessionActive()) return;

    if (this.trailingReconcileInFlight) {
      this.scheduleTrailingReconcile(`${reason}_queued`, TRAILING_RECONCILE_RETRY_MS);
      return;
    }

    this.trailingReconcileInFlight = true;
    try {
      const stream = this.getActiveStream(settings.mode);
      const summary = await this.reconcileTrailingPositions(stream, settings, reason);
      if (summary.pending > 0) {
        this.scheduleTrailingReconcile(`${reason}_retry`, TRAILING_RECONCILE_RETRY_MS);
      }
    } catch (error) {
      this.logger.error(
        { mode: settings.mode, reason, error: String((error as Error)?.message ?? error) },
        "private execution executor trailing reconcile loop failed",
      );
      this.scheduleTrailingReconcile(`${reason}_retry_error`, TRAILING_RECONCILE_RETRY_MS);
    } finally {
      this.trailingReconcileInFlight = false;
    }
  }

  private getActiveStream(mode: ExecutionMode): BybitPrivateExecutionStream {
    return mode === "real" ? this.realStream : this.demoStream;
  }

  private logSignalStep(
    step: "signal_seen" | "signal_skipped_reason" | "orders_cancelled" | "grid_submitted",
    payload: Record<string, unknown>,
  ): void {
    this.logger.info(
      { step, ...payload },
      "private execution executor signal step",
    );
  }

  private getCooldownKey(mode: ExecutionMode, symbol: string): string {
    return `${mode}:${symbol}`;
  }

  private getOpenSymbolsForStream(stream: BybitPrivateExecutionStream): Set<string> {
    const next = new Set<string>();
    for (const row of stream.getPositionsDetailed()) {
      if (Number(row.size ?? 0) <= 0) continue;
      next.add(row.symbol);
    }
    return next;
  }

  private syncOpenSymbols(mode: ExecutionMode): void {
    const stream = this.getActiveStream(mode);
    this.openSymbolsByMode[mode] = this.getOpenSymbolsForStream(stream);
  }

  private notePositionClosures(mode: ExecutionMode): void {
    const stream = this.getActiveStream(mode);
    const next = this.getOpenSymbolsForStream(stream);
    const prev = this.openSymbolsByMode[mode];
    const now = Date.now();
    for (const symbol of prev) {
      if (!next.has(symbol)) {
        this.lastClosedAtByModeSymbol.set(this.getCooldownKey(mode, symbol), now);
        this.logger.info(
          { mode, symbol, closedAt: now },
          "private execution executor cooldown started after position close",
        );
      }
    }
    this.openSymbolsByMode[mode] = next;
  }

  private isCooldownActive(mode: ExecutionMode, symbol: string, settings: ExecutorSettings): boolean {
    if (!(settings.cooldownMin > 0)) return false;
    const closedAt = this.lastClosedAtByModeSymbol.get(this.getCooldownKey(mode, symbol));
    if (!(closedAt && closedAt > 0)) return false;
    return (Date.now() - closedAt) < settings.cooldownMin * 60_000;
  }

  private async activate(reason: string): Promise<void> {
    if (!executorStore.getState().running) return;
    if (!isRuntimeSessionActive()) {
      this.status = "waiting_session";
      return;
    }

    const settings = this.activeSettings ?? deepClone(executorStore.getSettings());
    this.activeSettings = settings;
    const stream = this.getActiveStream(settings.mode);

    this.status = "starting";
    await stream.forceRefresh(`executor_${reason}_startup_refresh`, { includeOrders: true });
    this.syncOpenSymbols(settings.mode);

    if (settings.exit === "full") {
      const summary = await this.reconcileFullPositions(stream, settings, `executor_${reason}_full_startup`);
      if (summary.pending > 0) {
        this.scheduleFullReconcile(`${reason}_startup_retry`, TRAILING_RECONCILE_RETRY_MS);
      }
    }

    if (settings.exit === "trailing") {
      const summary = await this.reconcileTrailingPositions(stream, settings, `executor_${reason}_trailing_startup`);
      if (summary.pending > 0) {
        this.scheduleTrailingReconcile(`${reason}_startup_retry`, TRAILING_RECONCILE_RETRY_MS);
      }
    }

    if (settings.cancelActivePositionOrders) {
      await this.cancelStaleOrdersIfNeeded(`executor_${reason}_order_alive`);
    }

    this.ensureOrderMaintenanceTimer();
    this.status = "running";
    this.error = null;
    executorStore.setError(null);
  }

  private async processSignalTransitionEvent(event: unknown): Promise<void> {
    const settings = this.activeSettings;
    if (!executorStore.getState().running) return;
    if (!settings) return;
    if (!isRuntimeSessionActive()) return;

    const source = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
    if (String(source.type ?? "").trim().toUpperCase() !== "SHORT_SIGNAL_TRANSITION") return;

    const payload = (source.payload && typeof source.payload === "object" ? source.payload : {}) as Record<string, unknown>;
    const snapshot = (payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot : {}) as Record<string, unknown>;
    const symbol = String(source.symbol ?? snapshot.symbol ?? "").trim().toUpperCase();
    const nextState = normalizeSignalState(payload.nextState ?? snapshot.state);
    const advisoryVerdict = normalizeSignalState(snapshot.advisoryVerdict ?? ((snapshot.metrics && typeof snapshot.metrics === "object") ? (snapshot.metrics as Record<string, unknown>).advisoryVerdict : null));
    const transitionReason = String(payload.transitionReason ?? snapshot.summaryReason ?? "").trim() || null;
    const reason = resolveSignalExecutionReason(nextState);
    this.logSignalStep("signal_seen", {
      mode: settings.mode,
      symbol: symbol || null,
      state: nextState || null,
      reason,
      advisoryVerdict: advisoryVerdict || null,
      transitionReason,
    });

    if (!symbol) {
      this.logSignalStep("signal_skipped_reason", {
        mode: settings.mode,
        symbol: null,
        state: nextState || null,
        reason,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
        skipReason: "missing_symbol",
      });
      return;
    }
    if (!nextState) {
      this.logSignalStep("signal_skipped_reason", {
        mode: settings.mode,
        symbol,
        state: null,
        reason: null,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
        skipReason: "missing_state",
      });
      return;
    }
    if (nextState === "SUPPRESSED") {
      this.logSignalStep("signal_skipped_reason", {
        mode: settings.mode,
        symbol,
        state: nextState,
        reason: null,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
        skipReason: "suppressed_state",
      });
      return;
    }
    if (!reason) {
      this.logSignalStep("signal_skipped_reason", {
        mode: settings.mode,
        symbol,
        state: nextState,
        reason: null,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
        skipReason: "unsupported_state",
      });
      return;
    }
    if (reason === "candidate" && !settings.takeCandidateSignalsInLiveExecution) {
      this.logSignalStep("signal_skipped_reason", {
        mode: settings.mode,
        symbol,
        state: nextState,
        reason,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
        skipReason: "candidate_signals_disabled",
      });
      return;
    }
    if (reason === "final" && !settings.takeFinalSignals) {
      this.logSignalStep("signal_skipped_reason", {
        mode: settings.mode,
        symbol,
        state: nextState,
        reason,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
        skipReason: "final_signals_disabled",
      });
      return;
    }
    if (reason === "final" && advisoryVerdict !== "TRADEABLE") {
      this.logSignalStep("signal_skipped_reason", {
        mode: settings.mode,
        symbol,
        state: nextState,
        reason,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
        skipReason: "final_not_tradeable",
      });
      return;
    }

    const referencePrice = resolveSignalReferencePrice(payload);
    if (!(referencePrice && referencePrice > 0)) {
      this.logSignalStep("signal_skipped_reason", {
        mode: settings.mode,
        symbol,
        state: nextState,
        reason,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
        skipReason: "missing_reference_price",
      });
      return;
    }

    const signalKey = `${settings.mode}:${symbol}`;
    if (this.signalInFlightByModeSymbol.has(signalKey)) {
      this.logSignalStep("signal_skipped_reason", {
        mode: settings.mode,
        symbol,
        state: nextState,
        reason,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
        skipReason: "processing_already_in_flight",
      });
      return;
    }

    this.signalInFlightByModeSymbol.add(signalKey);
    try {
      await this.handleTradeableSignal({
        settings,
        symbol,
        reason,
        state: nextState,
        referencePrice,
        advisoryVerdict: advisoryVerdict || null,
        transitionReason,
      });
    } finally {
      this.signalInFlightByModeSymbol.delete(signalKey);
    }
  }

  private async handleTradeableSignal(args: {
    settings: ExecutorSettings;
    symbol: string;
    reason: ExecutionReason;
    state: string;
    referencePrice: number;
    advisoryVerdict: string | null;
    transitionReason: string | null;
  }): Promise<void> {
    const stream = this.getActiveStream(args.settings.mode);
    const restClient = stream.getRestClient();
    if (!restClient || !restClient.hasCredentials()) {
      throw new Error("missing_credentials");
    }

    const hasOpenPosition = stream.getPositionsDetailed().some((row) => row.symbol === args.symbol && Number(row.size ?? 0) > 0);
    if (hasOpenPosition) {
      this.logSignalStep("signal_skipped_reason", {
        mode: args.settings.mode,
        symbol: args.symbol,
        state: args.state,
        reason: args.reason,
        advisoryVerdict: args.advisoryVerdict,
        transitionReason: args.transitionReason,
        skipReason: "position_already_open",
      });
      return;
    }

    if (this.isCooldownActive(args.settings.mode, args.symbol, args.settings)) {
      this.logSignalStep("signal_skipped_reason", {
        mode: args.settings.mode,
        symbol: args.symbol,
        state: args.state,
        reason: args.reason,
        advisoryVerdict: args.advisoryVerdict,
        transitionReason: args.transitionReason,
        cooldownMin: args.settings.cooldownMin,
        skipReason: "cooldown_active",
      });
      return;
    }

    const canceled = await this.cancelExecutorOrdersForSymbol(stream, restClient, args.symbol, "replace_on_signal");
    this.logSignalStep("orders_cancelled", {
      mode: args.settings.mode,
      symbol: args.symbol,
      state: args.state,
      reason: args.reason,
      advisoryVerdict: args.advisoryVerdict,
      transitionReason: args.transitionReason,
      canceledOrders: canceled,
    });
    await stream.forceRefresh(`signal_${args.symbol}_pre_place_refresh`, { includeOrders: true });
    const grid = await this.placeSignalEntryGrid(stream, restClient, args);
    await stream.forceRefresh(`signal_${args.symbol}_post_place_refresh`, { includeOrders: true });
    this.logSignalStep("grid_submitted", {
      mode: args.settings.mode,
      symbol: args.symbol,
      state: args.state,
      reason: args.reason,
      advisoryVerdict: args.advisoryVerdict,
      transitionReason: args.transitionReason,
      ordersCount: grid.ordersCount,
      marginPerOrder: grid.marginPerOrder,
      orderLinkIds: grid.orderLinkIds,
    });
  }

  private async cancelExecutorOrdersForSymbol(
    stream: BybitPrivateExecutionStream,
    restClient: ExecutionRestClient,
    symbol: string,
    reason: string,
  ): Promise<number> {
    const targetOrders = stream.getOrdersDetailed().filter((row) => row.symbol === symbol && isExecutorManagedOrder(row));
    let canceled = 0;
    for (const order of targetOrders) {
      const cancelParams = buildCancelOrderParams(order);
      if (!cancelParams) continue;
      this.logger.info(
        { mode: this.activeSettings?.mode ?? "demo", symbol, reason, cancelParams },
        "private execution executor cancel entry order",
      );
      await restClient.cancelOrderLinear(cancelParams);
      canceled += 1;
    }
    return canceled;
  }

  private async cancelStaleOrdersIfNeeded(reason: string): Promise<void> {
    const settings = this.activeSettings;
    if (!settings || !settings.cancelActivePositionOrders) return;
    const stream = this.getActiveStream(settings.mode);
    const restClient = stream.getRestClient();
    if (!restClient || !restClient.hasCredentials()) return;

    const now = Date.now();
    const ttlMs = Math.max(1, settings.orderAliveMin) * 60_000;
    const staleOrders = stream.getOrdersDetailed().filter((row) => (
      isExecutorManagedOrder(row)
      && Number(row.placedAt ?? 0) > 0
      && (now - Number(row.placedAt)) >= ttlMs
    ));

    if (staleOrders.length === 0) return;

    for (const order of staleOrders) {
      const cancelParams = buildCancelOrderParams(order);
      if (!cancelParams) continue;
      this.logger.info(
        {
          mode: settings.mode,
          symbol: order.symbol,
          reason,
          orderKey: order.key,
          ageMs: now - Number(order.placedAt ?? now),
          orderAliveMin: settings.orderAliveMin,
        },
        "private execution executor cancel stale entry order",
      );
      await restClient.cancelOrderLinear(cancelParams);
    }
  }

  private async placeSignalEntryGrid(
    stream: BybitPrivateExecutionStream,
    restClient: ExecutionRestClient,
    args: {
      settings: ExecutorSettings;
      symbol: string;
      reason: ExecutionReason;
      state: string;
      referencePrice: number;
      advisoryVerdict: string | null;
      transitionReason: string | null;
    },
  ): Promise<{ ordersCount: number; marginPerOrder: number; orderLinkIds: string[] }> {
    const instrument = await this.getInstrumentSpec(args.settings.mode, restClient, args.symbol);
    const ordersCount = Math.max(1, Math.floor(Number(args.settings.gridOrdersCount) || 0));
    const marginPerOrder = args.settings.maxUsdt / ordersCount;
    if (!(marginPerOrder > 0) || !(args.settings.leverage > 0)) {
      throw new Error("invalid_executor_order_budget");
    }

    await restClient.setLeverageLinear({
      symbol: args.symbol,
      buyLeverage: formatForApi(args.settings.leverage),
      sellLeverage: formatForApi(args.settings.leverage),
    });

    const createdOrderLinkIds: string[] = [];
    const batchTs = Date.now();

    try {
      for (let index = 0; index < ordersCount; index += 1) {
        const offsetPct = Number(args.settings.firstOrderOffsetPct) + index * Number(args.settings.gridStepPct);
        const rawPrice = computeShortEntryPrice(args.referencePrice, offsetPct);
        const price = roundNearestToStep(rawPrice, instrument.tickSize);
        if (!(price > 0)) {
          throw new Error(`invalid_entry_price:${args.symbol}:${index + 1}`);
        }

        const rawQty = (marginPerOrder * Number(args.settings.leverage)) / price;
        const qty = roundDownToStep(rawQty, instrument.qtyStep);
        if (!(qty > 0)) {
          throw new Error(`invalid_entry_qty:${args.symbol}:${index + 1}`);
        }

        const orderLinkId = buildExecutorOrderLinkId(args.reason, args.symbol, batchTs, index + 1);
        createdOrderLinkIds.push(orderLinkId);

        const request = {
          symbol: args.symbol,
          side: "Sell",
          orderType: "Limit",
          price: formatForApi(price),
          qty: formatForApi(qty),
          timeInForce: "GTC",
          positionIdx: 2,
          orderLinkId,
        };

        this.logger.info(
          {
            mode: args.settings.mode,
            symbol: args.symbol,
            state: args.state,
            reason: args.reason,
            request,
          },
          "private execution executor place signal entry order",
        );
        await restClient.placeOrderLinear(request);
      }
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      for (const orderLinkId of createdOrderLinkIds) {
        try {
          await restClient.cancelOrderLinear({ symbol: args.symbol, orderLinkId });
        } catch {
          continue;
        }
      }
      throw new Error(message);
    }

    return {
      ordersCount,
      marginPerOrder,
      orderLinkIds: [...createdOrderLinkIds],
    };
  }

  private async reconcileFullPositions(
    stream: BybitPrivateExecutionStream,
    settings: ExecutorSettings,
    reason: string,
  ): Promise<TrailingReconcileSummary> {
    const restClient = stream.getRestClient();
    if (!restClient || !restClient.hasCredentials()) {
      throw new Error("missing_credentials");
    }

    const positions = stream.getPositionsDetailed().filter((row) => Number(row.size ?? 0) > 0);
    let attempted = 0;
    let failed = 0;
    let pending = 0;

    for (const position of positions) {
      if (!Number.isFinite(position.entryPrice as number) || Number(position.entryPrice) <= 0) {
        pending += 1;
        this.logger.warn(
          { mode: settings.mode, reason, symbol: position.symbol, key: position.key, entryPrice: position.entryPrice },
          "private execution executor full reconcile postponed: invalid entry price",
        );
        continue;
      }

      try {
        const positionIdx = resolvePositionIdx(position);
        const instrument = await this.getInstrumentSpec(settings.mode, restClient, position.symbol);
        const targetTp = roundNearestToStep(
          computeTpPrice(Number(position.entryPrice), position.side, settings.tpPct),
          instrument.tickSize,
        );
        const targetSl = roundNearestToStep(
          computeSlPrice(Number(position.entryPrice), position.side, settings.slPct),
          instrument.tickSize,
        );

        const trailingPresent = (position.trailingStop ?? null) != null;
        const tpMatches = sameWithinStep(position.tp ?? null, targetTp, instrument.tickSize);
        const slMatches = sameWithinStep(position.sl ?? null, targetSl, instrument.tickSize);
        const needsTrailingClear = trailingPresent;
        const needsTpReset = (position.tp ?? null) != null && !tpMatches;
        const needsSlReset = (position.sl ?? null) != null && !slMatches;
        const needsTpSet = !tpMatches;
        const needsSlSet = !slMatches;

        if (!needsTrailingClear && !needsTpReset && !needsSlReset && !needsTpSet && !needsSlSet) {
          continue;
        }

        attempted += 1;

        if (needsTrailingClear) {
          this.logger.info(
            { mode: settings.mode, reason, symbol: position.symbol, positionIdx, patch: { trailingStop: "0" } },
            "private execution executor apply trading stop patch",
          );
          await restClient.setTradingStopLinear({
            symbol: position.symbol,
            positionIdx,
            trailingStop: "0",
          });
        }

        if (needsTpReset) {
          this.logger.info(
            { mode: settings.mode, reason, symbol: position.symbol, positionIdx, patch: { tpslMode: "Full", takeProfit: "0" } },
            "private execution executor apply trading stop patch",
          );
          await restClient.setTradingStopLinear({
            symbol: position.symbol,
            positionIdx,
            tpslMode: "Full",
            takeProfit: "0",
          });
        }

        if (needsSlReset) {
          this.logger.info(
            { mode: settings.mode, reason, symbol: position.symbol, positionIdx, patch: { tpslMode: "Full", stopLoss: "0" } },
            "private execution executor apply trading stop patch",
          );
          await restClient.setTradingStopLinear({
            symbol: position.symbol,
            positionIdx,
            tpslMode: "Full",
            stopLoss: "0",
          });
        }

        if (needsTpSet) {
          this.logger.info(
            { mode: settings.mode, reason, symbol: position.symbol, positionIdx, patch: { tpslMode: "Full", takeProfit: formatForApi(targetTp), tpTriggerBy: "LastPrice" } },
            "private execution executor apply trading stop patch",
          );
          await restClient.setTradingStopLinear({
            symbol: position.symbol,
            positionIdx,
            tpslMode: "Full",
            takeProfit: formatForApi(targetTp),
            tpTriggerBy: "LastPrice",
          });
        }

        if (needsSlSet) {
          this.logger.info(
            { mode: settings.mode, reason, symbol: position.symbol, positionIdx, patch: { tpslMode: "Full", stopLoss: formatForApi(targetSl), slTriggerBy: "LastPrice" } },
            "private execution executor apply trading stop patch",
          );
          await restClient.setTradingStopLinear({
            symbol: position.symbol,
            positionIdx,
            tpslMode: "Full",
            stopLoss: formatForApi(targetSl),
            slTriggerBy: "LastPrice",
          });
        }

        stream.applyOptimisticProtection(position.key, {
          tp: targetTp,
          sl: targetSl,
          trailingStop: null,
        });
      } catch (error) {
        failed += 1;
        const message = String((error as Error)?.message ?? error);
        this.logger.error(
          {
            mode: settings.mode,
            reason,
            symbol: position.symbol,
            side: position.side,
            positionIdx: resolvePositionIdx(position),
            entryPrice: position.entryPrice,
            tp: position.tp,
            sl: position.sl,
            trailingStop: position.trailingStop,
            error: message,
          },
          "private execution executor full reconcile failed",
        );
      }
    }

    pending += failed;

    if (attempted > 0 || pending > 0) {
      this.logger.info(
        {
          mode: settings.mode,
          reason,
          total: positions.length,
          attempted,
          failed,
          pending,
        },
        "private execution executor full reconcile summary",
      );
    }

    return {
      total: positions.length,
      attempted,
      failed,
      pending,
    };
  }

  private async reconcileTrailingPositions(
    stream: BybitPrivateExecutionStream,
    settings: ExecutorSettings,
    reason: string,
  ): Promise<TrailingReconcileSummary> {
    const restClient = stream.getRestClient();
    if (!restClient || !restClient.hasCredentials()) {
      throw new Error("missing_credentials");
    }

    const positions = stream.getPositionsDetailed().filter((row) => Number(row.size ?? 0) > 0);
    let attempted = 0;
    let failed = 0;
    let pending = 0;

    for (const position of positions) {
      if (!Number.isFinite(position.entryPrice as number) || Number(position.entryPrice) <= 0) {
        pending += 1;
        this.logger.warn(
          { mode: settings.mode, reason, symbol: position.symbol, key: position.key, entryPrice: position.entryPrice },
          "private execution executor trailing reconcile postponed: invalid entry price",
        );
        continue;
      }

      const positionIdx = resolvePositionIdx(position);

      try {
        const instrument = await this.getInstrumentSpec(settings.mode, restClient, position.symbol);
        const targetTrailingStop = roundNearestToStep(
          computeTrailingDistance(Number(position.entryPrice), settings.slPct),
          instrument.tickSize,
        );
        const hasTp = (position.tp ?? null) != null;
        const hasSl = (position.sl ?? null) != null;
        const hasTrailing = (position.trailingStop ?? null) != null;
        const trailingMatches = sameWithinStep(position.trailingStop ?? null, targetTrailingStop, instrument.tickSize);
        const needsTrailingClear = hasTrailing && !trailingMatches;
        const needsTpReset = hasTp;
        const needsSlReset = hasSl;
        const needsTrailingSet = !hasTrailing || !trailingMatches;

        if (!needsTpReset && !needsSlReset && !needsTrailingSet) {
          continue;
        }

        attempted += 1;

        if (needsTrailingClear) {
          this.logger.info(
            {
              mode: settings.mode,
              reason,
              symbol: position.symbol,
              positionIdx,
              patch: { trailingStop: "0" },
            },
            "private execution executor apply trailing clear patch",
          );
          await restClient.setTradingStopLinear({
            symbol: position.symbol,
            positionIdx,
            trailingStop: "0",
          });
        }

        if (needsTpReset) {
          this.logger.info(
            {
              mode: settings.mode,
              reason,
              symbol: position.symbol,
              positionIdx,
              patch: { tpslMode: "Full", takeProfit: "0" },
            },
            "private execution executor apply tp clear patch",
          );
          await restClient.setTradingStopLinear({
            symbol: position.symbol,
            positionIdx,
            tpslMode: "Full",
            takeProfit: "0",
          });
        }

        if (needsSlReset) {
          this.logger.info(
            {
              mode: settings.mode,
              reason,
              symbol: position.symbol,
              positionIdx,
              patch: { tpslMode: "Full", stopLoss: "0" },
            },
            "private execution executor apply sl clear patch",
          );
          await restClient.setTradingStopLinear({
            symbol: position.symbol,
            positionIdx,
            tpslMode: "Full",
            stopLoss: "0",
          });
        }

        if (needsTrailingSet) {
          this.logger.info(
            {
              mode: settings.mode,
              reason,
              symbol: position.symbol,
              positionIdx,
              patch: { trailingStop: formatForApi(targetTrailingStop) },
            },
            "private execution executor apply trailing patch",
          );
          await restClient.setTradingStopLinear({
            symbol: position.symbol,
            positionIdx,
            trailingStop: formatForApi(targetTrailingStop),
          });
        }
      } catch (error) {
        failed += 1;
        const message = String((error as Error)?.message ?? error);
        this.logger.error(
          {
            mode: settings.mode,
            reason,
            symbol: position.symbol,
            side: position.side,
            positionIdx,
            entryPrice: position.entryPrice,
            tp: position.tp,
            sl: position.sl,
            trailingStop: position.trailingStop,
            error: message,
          },
          "private execution executor trailing reconcile failed",
        );
      }
    }

    pending += failed;

    if (attempted > 0 || pending > 0) {
      this.logger.info(
        {
          mode: settings.mode,
          reason,
          total: positions.length,
          attempted,
          failed,
          pending,
        },
        "private execution executor trailing reconcile summary",
      );
    }

    return {
      total: positions.length,
      attempted,
      failed,
      pending,
    };
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
let demoExecutionStream: BybitPrivateExecutionStream | null = null;
let realExecutionStream: BybitPrivateExecutionStream | null = null;

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

export async function refreshPrivateExecutionSnapshot(mode: ExecutionMode): Promise<PositionsSnapshot> {
  const stream = mode === "real" ? realExecutionStream : demoExecutionStream;
  if (!stream) {
    throw new Error("execution_stream_not_ready");
  }
  return await stream.forceRefresh("manual_refresh", { includeOrders: true });
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

  realExecutionStream = realStream;
  demoExecutionStream = demoStream;
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
    executorManager?.resetOnBoot();

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
    executorManager?.dispose();
    executorManager = null;
    realExecutionStream = null;
    demoExecutionStream = null;

    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });
}
