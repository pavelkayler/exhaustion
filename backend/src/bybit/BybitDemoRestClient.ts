import { buildSignedHeaders, buildSortedQueryString } from "./v5Auth.js";
import { nowMs, refreshServerTimeOffset, startServerTimeOffsetScheduler } from "./serverTimeOffset.js";

type ApiResp<T> = { retCode: number; retMsg: string; result: T };

type PlaceOrderLinearParams = {
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market" | "Limit";
  qty: string | number;
  price?: string | number;
  timeInForce?: string;
  reduceOnly?: boolean;
  closeOnTrigger?: boolean;
  bboSideType?: "Queue" | "Counterparty";
  bboLevel?: number;
  takeProfit?: string | number;
  stopLoss?: string | number;
  triggerPrice?: string | number;
  triggerDirection?: 1 | 2;
  triggerBy?: string;
  positionIdx?: 0 | 1 | 2;
  orderLinkId?: string;
};

type CancelOrderLinearParams = { symbol: string; orderId?: string; orderLinkId?: string };
type Position = { symbol?: string; side?: string; size?: string; avgPrice?: string; takeProfit?: string; stopLoss?: string; unrealisedPnl?: string; curRealisedPnl?: string; positionIdx?: number | string; };
type OpenOrder = { symbol?: string; orderLinkId?: string; orderId?: string; side?: string; price?: string; qty?: string; triggerPrice?: string; stopOrderType?: string; reduceOnly?: boolean; };
type OpenOrderQuery = { symbol?: string; settleCoin?: string; limit?: number; cursor?: string };
type OpenOrderResult = { list?: OpenOrder[]; nextPageCursor?: string };

type Execution = { execId?: string; symbol?: string; execTime?: string; execFee?: string; feeRate?: string; closedSize?: string; execQty?: string; execValue?: string; side?: string; orderId?: string; orderLinkId?: string; orderPrice?: string; markPrice?: string; isMaker?: boolean; execType?: string; seq?: string; feeCurrency?: string; extraFees?: string; leavesQty?: string; orderType?: string; stopOrderType?: string; leverage?: string; closedPnl?: string; };

type ClosedPnlEntry = { symbol?: string; orderId?: string; side?: string; qty?: string; orderPrice?: string; orderType?: string; execType?: string; closedSize?: string; cumEntryValue?: string; avgEntryPrice?: string; cumExitValue?: string; avgExitPrice?: string; closedPnl?: string; fillCount?: string; leverage?: string; openFee?: string; closeFee?: string; createdTime?: string; updatedTime?: string; };
type TransactionLogEntry = { id?: string; symbol?: string; category?: string; side?: string; transactionTime?: string; type?: string; transSubType?: string; qty?: string; size?: string; currency?: string; tradePrice?: string; funding?: string; fee?: string; cashFlow?: string; change?: string; cashBalance?: string; feeRate?: string; bonusChange?: string; tradeId?: string; orderId?: string; orderLinkId?: string; extraFees?: string; };

type TradingStopLinearParams = {
  symbol: string;
  takeProfit?: string | number;
  stopLoss?: string | number;
  trailingStop?: string | number;
  activePrice?: string | number;
  tpTriggerBy?: string;
  slTriggerBy?: string;
  positionIdx?: 0 | 1 | 2;
  tpslMode?: "Full" | "Partial";
  tpOrderType?: "Market" | "Limit";
  slOrderType?: "Market" | "Limit";
  tpLimitPrice?: string | number;
  slLimitPrice?: string | number;
  tpSize?: string | number;
  slSize?: string | number;
};

function isTimestampWindowError(retCode: unknown, retMsg: unknown): boolean {
  const code = Number(retCode);
  const msg = String(retMsg ?? "").toLowerCase();
  return code === 10002 || code === -1 || msg.includes("time exceeds the time window") || msg.includes("server timestamp") || msg.includes("recv_window") || msg.includes("request expired");
}

function isTransientFetchError(error: unknown): boolean {
  const name = String((error as any)?.name ?? "").toLowerCase();
  const message = String((error as any)?.message ?? error ?? "").toLowerCase();
  return name.includes("abort")
    || message.includes("fetch failed")
    || message.includes("networkerror")
    || message.includes("econnreset")
    || message.includes("timeout");
}

function finiteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeTradingStopLinearParams(params: TradingStopLinearParams): TradingStopLinearParams {
  const next: TradingStopLinearParams = { ...params };
  const trailingStop = finiteNumber(params.trailingStop);
  const activePrice = finiteNumber(params.activePrice);
  const takeProfit = finiteNumber(params.takeProfit);
  const stopLoss = finiteNumber(params.stopLoss);
  const isFullModeReset =
    String(params.tpslMode ?? "") === "Full"
    && takeProfit === 0
    && stopLoss === 0
    && !(trailingStop != null && trailingStop > 0);

  if (trailingStop != null && trailingStop > 0) {
    if (activePrice != null && activePrice > trailingStop) {
      const inferredPct = trailingStop / activePrice;
      if (Number.isFinite(inferredPct) && inferredPct > 0 && inferredPct < 0.95) {
        const immediateTrailingStop = trailingStop / (1 - inferredPct);
        if (Number.isFinite(immediateTrailingStop) && immediateTrailingStop > 0) {
          next.trailingStop = immediateTrailingStop;
        }
      }
    }
    delete next.activePrice;
    return next;
  }

  if (isFullModeReset) {
    next.trailingStop = "0";
    next.activePrice = "0";
  }

  return next;
}

export class BybitDemoRestClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly recvWindow: number;
  readonly httpTimeoutMs: number;
  private inflight = 0;
  private queue: Array<() => void> = [];
  private maxConcurrent = 2;
  private minGapMs = 120;
  private lastStartMs = 0;

  constructor() {
    this.baseUrl = process.env.BYBIT_DEMO_REST_URL ?? "https://api-demo.bybit.com";
    this.apiKey = process.env.BYBIT_DEMO_API_KEY ?? "";
    this.apiSecret = process.env.BYBIT_DEMO_API_SECRET ?? "";
    this.recvWindow = Number(process.env.BYBIT_RECV_WINDOW ?? 20000);
    this.httpTimeoutMs = Math.max(2_000, Number(process.env.BYBIT_DEMO_HTTP_TIMEOUT_MS ?? 10_000));
    startServerTimeOffsetScheduler({ baseUrl: this.baseUrl });
  }

  hasCredentials(): boolean { return this.apiKey.length > 0 && this.apiSecret.length > 0; }

  private async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      const gapRemaining = Math.max(0, this.minGapMs - (now - this.lastStartMs));
      if (this.inflight < this.maxConcurrent && gapRemaining <= 0) {
        this.inflight += 1;
        this.lastStartMs = Date.now();
        return;
      }
      await new Promise<void>((resolve) => {
        let done = false;
        const wake = () => { if (done) return; done = true; resolve(); };
        this.queue.push(wake);
        if (gapRemaining > 0) setTimeout(wake, gapRemaining);
      });
    }
  }

  private release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async request<T>(method: "GET" | "POST", endpoint: string, query?: Record<string, unknown>, body?: Record<string, unknown>, opts?: { ignoreRetCodes?: number[] }): Promise<T> {
    return this.requestInternal(method, endpoint, query, body, opts, false, false);
  }

  private async requestInternal<T>(
    method: "GET" | "POST",
    endpoint: string,
    query?: Record<string, unknown>,
    body?: Record<string, unknown>,
    opts?: { ignoreRetCodes?: number[] },
    retried10006 = false,
    retried10002 = false,
    transientFetchRetries = 0,
  ): Promise<T> {
    const q = buildSortedQueryString(query ?? {});
    const url = q ? `${this.baseUrl}${endpoint}?${q}` : `${this.baseUrl}${endpoint}`;
    const bodyString = method === "POST" ? JSON.stringify(body ?? {}) : "";
    let retried = retried10006;

    while (true) {
      await this.acquire();
      try {
        const signed = buildSignedHeaders({
          apiKey: this.apiKey,
          apiSecret: this.apiSecret,
          recvWindow: this.recvWindow,
          timestamp: nowMs(),
          method,
          queryString: q,
          bodyString,
        });
        const headers: Record<string, string> = { ...signed, "Content-Type": "application/json" };
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
        }, this.httpTimeoutMs);
        const init: RequestInit = { method, headers, signal: controller.signal };
        if (method === "POST") init.body = bodyString;

        let res: Response;
        try {
          res = await fetch(url, init);
        } catch (error) {
          const normalizedError =
            String((error as any)?.name ?? "").toLowerCase().includes("abort")
              ? new Error(`timeout after ${this.httpTimeoutMs}ms`)
              : error;
          if (isTransientFetchError(normalizedError) && transientFetchRetries < 2) {
            await this.sleep(250 * (transientFetchRetries + 1));
            return this.requestInternal(method, endpoint, query, body, opts, retried, retried10002, transientFetchRetries + 1);
          }
          throw normalizedError;
        } finally {
          clearTimeout(timeout);
        }
        const text = await res.text();
        let parsed: ApiResp<T> | null = null;
        try {
          parsed = JSON.parse(text) as ApiResp<T>;
        } catch {
          parsed = null;
        }

        if (parsed?.retCode === 10006 && !retried) {
          const resetHeader = res.headers.get("X-Bapi-Limit-Reset-Timestamp");
          let waitMs = 1000;
          const resetAtMs = Number(resetHeader);
          if (Number.isFinite(resetAtMs) && resetAtMs > 0) waitMs = Math.max(250, Math.min(5000, resetAtMs - Date.now()));
          retried = true;
          await this.sleep(waitMs);
          continue;
        }

        if (isTimestampWindowError(parsed?.retCode, parsed?.retMsg) && !retried10002) {
          await refreshServerTimeOffset({ baseUrl: this.baseUrl });
          await this.sleep(250);
          return this.requestInternal(method, endpoint, query, body, opts, retried, true, transientFetchRetries);
        }

        const shouldIgnoreRetCode = parsed && parsed.retCode !== 0 && Array.isArray(opts?.ignoreRetCodes) && opts.ignoreRetCodes.includes(parsed.retCode);
        if (!res.ok || !parsed || (parsed.retCode !== 0 && !shouldIgnoreRetCode)) {
          const err: any = new Error(`Bybit demo REST error: ${endpoint}`);
          err.status = res.status;
          err.retCode = parsed?.retCode;
          err.retMsg = parsed?.retMsg ?? text;
          throw err;
        }

        return parsed.result;
      } finally {
        this.release();
      }
    }
  }

  placeOrderLinear(params: PlaceOrderLinearParams) {
    return this.request("POST", "/v5/order/create", undefined, { category: "linear", ...params });
  }

  cancelOrderLinear(params: CancelOrderLinearParams) {
    return this.request("POST", "/v5/order/cancel", undefined, { category: "linear", ...params });
  }

  async getOpenOrdersLinear(params: OpenOrderQuery = {}): Promise<{ list: OpenOrder[] }> {
    const { limit: requestedLimit, cursor: requestedCursor, ...baseParams } = params;
    const limit = Math.max(1, Math.min(50, Number(requestedLimit ?? 50) || 50));
    const rows: OpenOrder[] = [];
    const seen = new Set<string>();
    let cursor = String(requestedCursor ?? "").trim();

    for (let page = 0; page < 20; page += 1) {
      const result = await this.request<OpenOrderResult>("GET", "/v5/order/realtime", {
        category: "linear",
        ...baseParams,
        limit,
        ...(cursor ? { cursor } : {}),
      });
      const batch = Array.isArray(result?.list) ? result.list : [];
      for (const row of batch) {
        const key = String(row?.orderId ?? row?.orderLinkId ?? "").trim();
        if (key) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        rows.push(row);
      }
      const nextCursor = String(result?.nextPageCursor ?? "").trim();
      if (!nextCursor || nextCursor === cursor || batch.length === 0) break;
      cursor = nextCursor;
    }

    return { list: rows };
  }

  async getPositionsLinear(params: { symbol?: string; settleCoin?: string } = {}): Promise<{ list: Position[] }> {
    return this.request("GET", "/v5/position/list", { category: "linear", ...params });
  }

  async getInstrumentsInfoLinear(params: { symbol?: string } = {}): Promise<any[]> {
    const result = await this.request<{ list?: any[] }>("GET", "/v5/market/instruments-info", { category: "linear", ...params });
    return Array.isArray(result?.list) ? result.list : [];
  }

  async getExecutionsLinear(params: { symbol?: string; startTime?: number; endTime?: number; limit?: number; cursor?: string } = {}): Promise<{ list: Execution[]; nextPageCursor?: string }> {
    const result = await this.request<{ list?: Execution[]; nextPageCursor?: string }>("GET", "/v5/execution/list", { category: "linear", ...params });
    return { list: Array.isArray(result?.list) ? result.list : [], ...(result?.nextPageCursor ? { nextPageCursor: result.nextPageCursor } : {}) };
  }

  async getClosedPnlLinear(params: { symbol?: string; startTime?: number; endTime?: number; limit?: number; cursor?: string } = {}): Promise<{ list: ClosedPnlEntry[]; nextPageCursor?: string }> {
    const result = await this.request<{ list?: ClosedPnlEntry[]; nextPageCursor?: string }>("GET", "/v5/position/closed-pnl", { category: "linear", ...params });
    return { list: Array.isArray(result?.list) ? result.list : [], ...(result?.nextPageCursor ? { nextPageCursor: result.nextPageCursor } : {}) };
  }

  async getTransactionLogLinear(params: { currency?: string; startTime?: number; endTime?: number; limit?: number; cursor?: string } = {}): Promise<{ list: TransactionLogEntry[]; nextPageCursor?: string }> {
    const result = await this.request<{ list?: TransactionLogEntry[]; nextPageCursor?: string }>("GET", "/v5/account/transaction-log", { accountType: "UNIFIED", category: "linear", ...params });
    return { list: Array.isArray(result?.list) ? result.list : [], ...(result?.nextPageCursor ? { nextPageCursor: result.nextPageCursor } : {}) };
  }

  getWalletBalance(params: { coin?: string } = {}) {
    return this.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED", ...params });
  }

  setLeverageLinear(params: { symbol: string; buyLeverage: string | number; sellLeverage: string | number }) {
    return this.request("POST", "/v5/position/set-leverage", undefined, { category: "linear", ...params }, { ignoreRetCodes: [110043] });
  }

  setTradingStopLinear(params: TradingStopLinearParams) {
    return this.request("POST", "/v5/position/trading-stop", undefined, {
      category: "linear",
      ...normalizeTradingStopLinearParams(params),
    });
  }
}
