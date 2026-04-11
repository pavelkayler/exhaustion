import { BybitMarketCache } from "./BybitMarketCache.js";

export type CandleRefs = {
    prevCandleClose: number | null;
    prevCandleOiClose: number | null;
    prevCandleOivClose: number | null;
    confirmedAt: number | null;
};

/**
 * Tracks candle boundaries using Bybit kline stream.
 *
 * Rule:
 * - When we receive kline with confirm=true, we snapshot:
 *   - prevCandleClose = kline.close
 *   - prevCandleOiClose = last known comparable open interest at that moment
 *   - prevCandleOivClose = kept for backwards compatibility with existing UI/contracts
 */
export class CandleTracker {
    private readonly cache: BybitMarketCache;
    private readonly refs = new Map<string, CandleRefs>();

    constructor(cache: BybitMarketCache) {
        this.cache = cache;
    }

    /**
     * Ingest one kline row for one symbol.
     * Returns updated refs when confirm=true, otherwise null.
     */
    ingestKline(symbol: string, kline: Record<string, any>): CandleRefs | null {
        const confirmRaw = kline?.confirm;
        const isConfirm =
            confirmRaw === true ||
            confirmRaw === "true" ||
            confirmRaw === 1 ||
            confirmRaw === "1";

        if (!isConfirm) return null;

        const closeRaw = kline?.close ?? kline?.c ?? kline?.closePrice ?? null;
        const close = closeRaw == null ? null : Number(closeRaw);

        const oi = this.cache.getComparableOpenInterest(symbol);

        const next: CandleRefs = {
            prevCandleClose: Number.isFinite(close as number) ? (close as number) : null,
            prevCandleOiClose: Number.isFinite(oi as number) ? (oi as number) : null,
            prevCandleOivClose: Number.isFinite(oi as number) ? (oi as number) : null,
            confirmedAt: Date.now()
        };

        this.refs.set(symbol, next);
        return next;
    }

    getRefs(symbol: string): CandleRefs {
        return (
            this.refs.get(symbol) ?? {
                prevCandleClose: null,
                prevCandleOiClose: null,
                prevCandleOivClose: null,
                confirmedAt: null
            }
        );
    }
}