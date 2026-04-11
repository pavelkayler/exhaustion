export type BybitOrderbookSummary = {
  symbol: string;
  updatedAt: number | null;
  sourceTs: number | null;
  seq: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spreadBps: number | null;
  bidDepthNear: number;
  askDepthNear: number;
  bidDepthNearUsd: number;
  askDepthNearUsd: number;
  totalDepthNearUsd: number;
  imbalanceRatio: number | null;
  askToBidDepthRatio: number | null;
  nearestAskWallBps: number | null;
  nearestBidWallBps: number | null;
  nearestAskWallSize: number | null;
  nearestBidWallSize: number | null;
};

type OrderbookSide = "bids" | "asks";

type BookState = {
  updatedAt: number | null;
  sourceTs: number | null;
  seq: number | null;
  bids: Map<number, number>;
  asks: Map<number, number>;
  summaryCache: Map<string, BybitOrderbookSummary>;
};

function emptySummary(symbol: string): BybitOrderbookSummary {
  return {
    symbol,
    updatedAt: null,
    sourceTs: null,
    seq: null,
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spreadBps: null,
    bidDepthNear: 0,
    askDepthNear: 0,
    bidDepthNearUsd: 0,
    askDepthNearUsd: 0,
    totalDepthNearUsd: 0,
    imbalanceRatio: null,
    askToBidDepthRatio: null,
    nearestAskWallBps: null,
    nearestBidWallBps: null,
    nearestAskWallSize: null,
    nearestBidWallSize: null,
  };
}

function parseLevels(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const rows: Array<[number, number]> = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const price = Number(item[0]);
    const size = Number(item[1]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) continue;
    rows.push([price, size]);
  }
  return rows;
}

function sortLevels(levels: Iterable<[number, number]>, side: OrderbookSide): Array<[number, number]> {
  return Array.from(levels).sort((a, b) => side === "bids" ? b[0] - a[0] : a[0] - b[0]);
}

export class BybitOrderbookStore {
  private readonly books = new Map<string, BookState>();

  upsert(symbolRaw: string, type: "snapshot" | "delta", data: Record<string, unknown>): void {
    const symbol = String(symbolRaw ?? "").trim().toUpperCase();
    if (!symbol) return;
    const state = this.books.get(symbol) ?? {
      updatedAt: null,
      sourceTs: null,
      seq: null,
      bids: new Map<number, number>(),
      asks: new Map<number, number>(),
      summaryCache: new Map<string, BybitOrderbookSummary>(),
    };

    if (type === "snapshot") {
      state.bids.clear();
      state.asks.clear();
    }

    this.applyLevels(state.bids, parseLevels(data.b), "bids");
    this.applyLevels(state.asks, parseLevels(data.a), "asks");
    state.updatedAt = Date.now();
    const sourceTs = Number(data.cts ?? data.ts);
    state.sourceTs = Number.isFinite(sourceTs) && sourceTs > 0 ? Math.floor(sourceTs) : state.sourceTs;
    const seq = Number(data.seq ?? data.u);
    state.seq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : state.seq;
    state.summaryCache.clear();
    this.books.set(symbol, state);
  }

  getSummary(symbolRaw: string, args?: { radiusBps?: number; wallMultiplier?: number }): BybitOrderbookSummary {
    const symbol = String(symbolRaw ?? "").trim().toUpperCase();
    if (!symbol) return emptySummary("");
    const state = this.books.get(symbol);
    if (!state) return emptySummary(symbol);
    const radiusBps = Math.max(1, Number(args?.radiusBps ?? 20));
    const wallMultiplier = Math.max(1, Number(args?.wallMultiplier ?? 2.5));
    const cacheKey = `${radiusBps}:${wallMultiplier}`;
    const cached = state.summaryCache.get(cacheKey);
    if (cached) return cached;

    const bids = sortLevels(state.bids.entries(), "bids");
    const asks = sortLevels(state.asks.entries(), "asks");
    const bestBid = bids[0]?.[0] ?? null;
    const bestAsk = asks[0]?.[0] ?? null;
    if (!(Number.isFinite(bestBid as number) && Number.isFinite(bestAsk as number) && Number(bestBid) > 0 && Number(bestAsk) > 0)) {
      const empty = {
        ...emptySummary(symbol),
        updatedAt: state.updatedAt,
        sourceTs: state.sourceTs,
        seq: state.seq,
      };
      state.summaryCache.set(cacheKey, empty);
      return empty;
    }

    const midPrice = (Number(bestBid) + Number(bestAsk)) / 2;
    const spreadBps = midPrice > 0 ? ((Number(bestAsk) - Number(bestBid)) / midPrice) * 10_000 : null;
    const bidDepthNear = bids
      .filter(([price]) => ((midPrice - price) / midPrice) * 10_000 <= radiusBps)
      .reduce((sum, [, size]) => sum + size, 0);
    const askDepthNear = asks
      .filter(([price]) => ((price - midPrice) / midPrice) * 10_000 <= radiusBps)
      .reduce((sum, [, size]) => sum + size, 0);
    const bidDepthNearUsd = bidDepthNear * midPrice;
    const askDepthNearUsd = askDepthNear * midPrice;
    const depthTotal = bidDepthNear + askDepthNear;
    const imbalanceRatio = depthTotal > 0 ? (bidDepthNear - askDepthNear) / depthTotal : null;
    const askToBidDepthRatio = bidDepthNear > 0 ? askDepthNear / bidDepthNear : null;

    const askWall = this.findWall(asks, midPrice, wallMultiplier, "asks");
    const bidWall = this.findWall(bids, midPrice, wallMultiplier, "bids");

    const summary = {
      symbol,
      updatedAt: state.updatedAt,
      sourceTs: state.sourceTs,
      seq: state.seq,
      bestBid: Number(bestBid),
      bestAsk: Number(bestAsk),
      midPrice,
      spreadBps,
      bidDepthNear,
      askDepthNear,
      bidDepthNearUsd,
      askDepthNearUsd,
      totalDepthNearUsd: bidDepthNearUsd + askDepthNearUsd,
      imbalanceRatio,
      askToBidDepthRatio,
      nearestAskWallBps: askWall?.distanceBps ?? null,
      nearestBidWallBps: bidWall?.distanceBps ?? null,
      nearestAskWallSize: askWall?.size ?? null,
      nearestBidWallSize: bidWall?.size ?? null,
    };
    state.summaryCache.set(cacheKey, summary);
    return summary;
  }

  private applyLevels(target: Map<number, number>, levels: Array<[number, number]>, side: OrderbookSide): void {
    for (const [price, size] of levels) {
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!Number.isFinite(size) || size <= 0) {
        target.delete(price);
        continue;
      }
      target.set(price, size);
    }
    const sorted = sortLevels(target.entries(), side);
    const limit = 50;
    if (sorted.length <= limit) return;
    const remove = sorted.slice(limit);
    for (const [price] of remove) target.delete(price);
  }

  private findWall(levels: Array<[number, number]>, midPrice: number, wallMultiplier: number, side: OrderbookSide): { distanceBps: number; size: number } | null {
    if (!levels.length || !(midPrice > 0)) return null;
    const baselineSlice = levels.slice(0, Math.min(10, levels.length));
    const avgSize = baselineSlice.reduce((sum, [, size]) => sum + size, 0) / Math.max(1, baselineSlice.length);
    if (!(avgSize > 0)) return null;
    for (const [price, size] of levels) {
      if (size < avgSize * wallMultiplier) continue;
      const distanceBps = side === "asks"
        ? ((price - midPrice) / midPrice) * 10_000
        : ((midPrice - price) / midPrice) * 10_000;
      if (!Number.isFinite(distanceBps) || distanceBps < 0) continue;
      return { distanceBps, size };
    }
    return null;
  }
}
