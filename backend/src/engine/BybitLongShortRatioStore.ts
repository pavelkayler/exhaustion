import { fetchBybitLongShortRatio } from "../bybit/longShortRatio.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type BybitLongShortRatioSnapshot = {
  symbol: string;
  buyRatio: number | null;
  sellRatio: number | null;
  longShortRatio: number | null;
  updatedAt: number | null;
  sourceTs: number | null;
  period: "5min" | "15min" | "30min" | "1h" | "4h" | "1d";
};

const EMPTY_SNAPSHOT = (symbol: string, period: BybitLongShortRatioSnapshot["period"]): BybitLongShortRatioSnapshot => ({
  symbol,
  buyRatio: null,
  sellRatio: null,
  longShortRatio: null,
  updatedAt: null,
  sourceTs: null,
  period,
});

export class BybitLongShortRatioStore {
  private readonly restBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly period: BybitLongShortRatioSnapshot["period"];
  private readonly minRefreshMs: number;
  private readonly maxSymbolsPerRefresh: number;
  private readonly snapshots = new Map<string, BybitLongShortRatioSnapshot>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(args?: {
    restBaseUrl?: string;
    fetchImpl?: FetchLike;
    period?: BybitLongShortRatioSnapshot["period"];
    minRefreshMs?: number;
    maxSymbolsPerRefresh?: number;
  }) {
    this.restBaseUrl = (args?.restBaseUrl ?? process.env.BYBIT_REST_URL ?? "https://api.bybit.com").replace(/\/+$/g, "");
    this.fetchImpl = args?.fetchImpl ?? fetch;
    this.period = args?.period ?? "5min";
    this.minRefreshMs = Math.max(5_000, Math.floor(Number(args?.minRefreshMs ?? 55_000)));
    this.maxSymbolsPerRefresh = Math.max(1, Math.floor(Number(args?.maxSymbolsPerRefresh ?? 25)));
  }

  getSnapshot(symbolRaw: string): BybitLongShortRatioSnapshot {
    const symbol = String(symbolRaw ?? "").trim().toUpperCase();
    if (!symbol) return EMPTY_SNAPSHOT("", this.period);
    return this.snapshots.get(symbol) ?? EMPTY_SNAPSHOT(symbol, this.period);
  }

  async refreshSymbols(symbolsRaw: string[]): Promise<void> {
    const now = Date.now();
    const symbols = Array.from(new Set((Array.isArray(symbolsRaw) ? symbolsRaw : [])
      .map((symbol) => String(symbol ?? "").trim().toUpperCase())
      .filter(Boolean)));
    let scheduled = 0;
    const work: Promise<void>[] = [];
    for (const symbol of symbols) {
      if (scheduled >= this.maxSymbolsPerRefresh) break;
      const snapshot = this.snapshots.get(symbol);
      const updatedAt = Number(snapshot?.updatedAt ?? 0);
      const freshEnough = Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt < this.minRefreshMs;
      if (freshEnough) continue;
      const existing = this.inFlight.get(symbol);
      if (existing) {
        work.push(existing);
        continue;
      }
      const task = this.refreshSymbol(symbol);
      this.inFlight.set(symbol, task);
      work.push(task);
      scheduled += 1;
    }
    await Promise.allSettled(work);
  }

  private async refreshSymbol(symbol: string): Promise<void> {
    try {
      const rows = await fetchBybitLongShortRatio({
        symbol,
        period: this.period,
        limit: 1,
        restBaseUrl: this.restBaseUrl,
        fetchImpl: this.fetchImpl,
      });
      const latest = rows[rows.length - 1] ?? null;
      this.snapshots.set(symbol, {
        symbol,
        buyRatio: latest?.buyRatio ?? null,
        sellRatio: latest?.sellRatio ?? null,
        longShortRatio: latest?.longShortRatio ?? null,
        updatedAt: Date.now(),
        sourceTs: latest?.ts ?? null,
        period: this.period,
      });
    } catch {
      const previous = this.snapshots.get(symbol) ?? EMPTY_SNAPSHOT(symbol, this.period);
      this.snapshots.set(symbol, {
        ...previous,
        updatedAt: Date.now(),
      });
    } finally {
      this.inFlight.delete(symbol);
    }
  }
}
