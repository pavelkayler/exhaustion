export type MarketWindowPoint = {
  ts: number;
  symbol: string;
  markPrice: number | null;
  openInterest: number | null;
};

export type MarketWindowSnapshot = {
  symbol: string;
  markPrice30sAgo: number | null;
  markPrice1mAgo: number | null;
  openInterest30sAgo: number | null;
  openInterest1mAgo: number | null;
  latestAt: number | null;
};

const THIRTY_SEC_MS = 30_000;
const ONE_MIN_MS = 60_000;

function emptySnapshot(symbol: string): MarketWindowSnapshot {
  return {
    symbol,
    markPrice30sAgo: null,
    markPrice1mAgo: null,
    openInterest30sAgo: null,
    openInterest1mAgo: null,
    latestAt: null,
  };
}

export class MarketWindowStore {
  private readonly bySymbol = new Map<string, MarketWindowPoint[]>();
  private readonly retentionMs: number;

  constructor(retentionMs = 3 * 60_000) {
    this.retentionMs = Math.max(ONE_MIN_MS, Math.floor(Number(retentionMs) || 0));
  }

  note(point: MarketWindowPoint): void {
    const symbol = String(point.symbol ?? "").trim().toUpperCase();
    if (!symbol) return;
    if (!Number.isFinite(point.ts) || point.ts <= 0) return;
    const list = this.bySymbol.get(symbol) ?? [];
    list.push({
      ...point,
      symbol,
      markPrice: Number.isFinite(point.markPrice as number) && Number(point.markPrice) > 0 ? Number(point.markPrice) : null,
      openInterest: Number.isFinite(point.openInterest as number) && Number(point.openInterest) > 0 ? Number(point.openInterest) : null,
    });
    this.pruneInPlace(list, point.ts);
    this.bySymbol.set(symbol, list);
  }

  getSnapshot(symbolRaw: string, now: number): MarketWindowSnapshot {
    const symbol = String(symbolRaw ?? "").trim().toUpperCase();
    if (!symbol) return emptySnapshot("");
    const list = this.bySymbol.get(symbol) ?? [];
    this.pruneInPlace(list, now);
    this.bySymbol.set(symbol, list);
    if (!list.length) return emptySnapshot(symbol);

    const fallback = list[0] ?? null;
    let ref30s: MarketWindowPoint | null = null;
    let ref1m: MarketWindowPoint | null = null;
    const target30s = now - THIRTY_SEC_MS;
    const target1m = now - ONE_MIN_MS;

    for (let index = list.length - 1; index >= 0; index -= 1) {
      const row = list[index];
      if (!row) continue;
      if (!ref30s && row.ts <= target30s) ref30s = row;
      if (!ref1m && row.ts <= target1m) {
        ref1m = row;
        if (ref30s) break;
      }
    }

    ref30s ??= fallback;
    ref1m ??= fallback;

    return {
      symbol,
      markPrice30sAgo: ref30s?.markPrice ?? null,
      markPrice1mAgo: ref1m?.markPrice ?? null,
      openInterest30sAgo: ref30s?.openInterest ?? null,
      openInterest1mAgo: ref1m?.openInterest ?? null,
      latestAt: list[list.length - 1]?.ts ?? null,
    };
  }

  private pruneInPlace(list: MarketWindowPoint[], now: number): void {
    let dropCount = 0;
    while (dropCount < list.length && now - list[dropCount]!.ts > this.retentionMs) {
      dropCount += 1;
    }
    if (dropCount > 0) {
      list.splice(0, dropCount);
    }
  }
}
