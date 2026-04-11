type BybitOpenInterestItem = {
  openInterest?: string;
  timestamp?: string;
};

type BybitOpenInterestResponse = {
  retCode?: number;
  retMsg?: string;
  result?: {
    list?: BybitOpenInterestItem[];
  };
};

export type ShortBybitOiSeedSnapshot = {
  symbol: string;
  asOfTs: number;
  seededAtMs: number;
  refOi5m: number | null;
  refOi15m: number | null;
  refOi1h: number | null;
  source: "bybit_api";
};

type CacheEntry = {
  snapshot: ShortBybitOiSeedSnapshot | null;
  error: string | null;
  fetchedAtMs: number;
  inFlight: boolean;
};

const BYBIT_BASE_URL = process.env.BYBIT_REST_URL ?? "https://api.bybit.com";
const LOOKBACK_WINDOW_MS = 75 * 60_000;
const SEED_TTL_MS = 5 * 60_000;
const MIN_REQUEST_GAP_MS = 1_000;
const QUEUE_IDLE_MS = 250;

function normalizeSymbol(input: string): string {
  return String(input ?? "").trim().toUpperCase();
}

function finiteOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function pickReferenceValue(
  points: Array<{ ts: number; oi: number }>,
  targetTs: number,
): number | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (!point) continue;
    if (point.ts <= targetTs && point.oi > 0) return point.oi;
  }
  return null;
}

async function fetchOpenInterestRefs(symbol: string, nowMs: number): Promise<ShortBybitOiSeedSnapshot> {
  const url = new URL(`${BYBIT_BASE_URL.replace(/\/+$/g, "")}/v5/market/open-interest`);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("intervalTime", "5min");
  url.searchParams.set("startTime", String(nowMs - LOOKBACK_WINDOW_MS));
  url.searchParams.set("endTime", String(nowMs));
  url.searchParams.set("limit", "200");

  const response = await fetch(url.toString(), { method: "GET" });
  const json = (await response.json()) as BybitOpenInterestResponse;
  const retCode = Number(json?.retCode ?? 0);
  if (!(response.ok && retCode === 0)) {
    const message = String(json?.retMsg ?? `http_${response.status}`);
    throw new Error(`bybit_oi_seed_failed:${symbol}:${retCode}:${message}`);
  }

  const points = (Array.isArray(json?.result?.list) ? json.result!.list! : [])
    .map((item) => ({
      ts: finiteOrNull(item?.timestamp),
      oi: finiteOrNull(item?.openInterest),
    }))
    .filter((item): item is { ts: number; oi: number } => item.ts != null && item.oi != null && item.oi > 0)
    .sort((left, right) => left.ts - right.ts);

  const latest = points[points.length - 1] ?? null;
  const asOfTs = latest?.ts ?? nowMs;

  return {
    symbol,
    asOfTs,
    seededAtMs: nowMs,
    refOi5m: pickReferenceValue(points, asOfTs - (5 * 60_000)),
    refOi15m: pickReferenceValue(points, asOfTs - (15 * 60_000)),
    refOi1h: pickReferenceValue(points, asOfTs - (60 * 60_000)),
    source: "bybit_api",
  };
}

export class ShortBybitOiSeedStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly queue: string[] = [];
  private queueTimer: NodeJS.Timeout | null = null;
  private lastRequestAtMs = 0;

  read(symbolInput: string): ShortBybitOiSeedSnapshot | null {
    const symbol = normalizeSymbol(symbolInput);
    if (!symbol) return null;
    const nowMs = Date.now();
    const entry = this.entries.get(symbol);
    if (!entry || nowMs - entry.fetchedAtMs >= SEED_TTL_MS) {
      this.enqueue(symbol);
    }
    return entry?.snapshot ?? null;
  }

  private enqueue(symbol: string): void {
    const existing = this.entries.get(symbol);
    if (existing?.inFlight) return;
    if (this.queue.includes(symbol)) return;
    this.queue.push(symbol);
    this.ensureQueuePump();
  }

  private ensureQueuePump(): void {
    if (this.queueTimer) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      void this.pumpQueue();
    }, QUEUE_IDLE_MS);
  }

  private async pumpQueue(): Promise<void> {
    const symbol = this.queue.shift();
    if (!symbol) return;
    const waitMs = Math.max(0, MIN_REQUEST_GAP_MS - (Date.now() - this.lastRequestAtMs));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const current = this.entries.get(symbol);
    this.entries.set(symbol, {
      snapshot: current?.snapshot ?? null,
      error: current?.error ?? null,
      fetchedAtMs: current?.fetchedAtMs ?? 0,
      inFlight: true,
    });

    try {
      this.lastRequestAtMs = Date.now();
      const snapshot = await fetchOpenInterestRefs(symbol, this.lastRequestAtMs);
      this.entries.set(symbol, {
        snapshot,
        error: null,
        fetchedAtMs: Date.now(),
        inFlight: false,
      });
    } catch (error: any) {
      this.entries.set(symbol, {
        snapshot: current?.snapshot ?? null,
        error: String(error?.message ?? error),
        fetchedAtMs: Date.now(),
        inFlight: false,
      });
    } finally {
      if (this.queue.length > 0) {
        this.ensureQueuePump();
      }
    }
  }
}

export const shortBybitOiSeedStore = new ShortBybitOiSeedStore();
