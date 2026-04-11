type TickerCacheRow = {
  symbol: string;

  markPrice: number | null;
  lastPrice: number | null;
  bid1: number | null;
  ask1: number | null;
  openInterest: number | null;
  openInterestValue: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  fundingIntervalHour: number | null;
  turnover24hUsd: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;

  updatedAt: number;
};

export class BybitMarketCache {
  private readonly map = new Map<string, TickerCacheRow>();

  upsertFromTicker(symbol: string, delta: Record<string, any>) {
    const row =
      this.map.get(symbol) ??
      ({
        symbol,
        markPrice: null,
        lastPrice: null,
        bid1: null,
        ask1: null,
        openInterest: null,
        openInterestValue: null,
        fundingRate: null,
        nextFundingTime: null,
        fundingIntervalHour: null,
        turnover24hUsd: null,
        highPrice24h: null,
        lowPrice24h: null,
        updatedAt: Date.now(),
      } satisfies TickerCacheRow);

    if (delta.markPrice != null) row.markPrice = Number(delta.markPrice);
    if (delta.lastPrice != null) row.lastPrice = Number(delta.lastPrice);
    if (delta.bid1Price != null) row.bid1 = Number(delta.bid1Price);
    if (delta.ask1Price != null) row.ask1 = Number(delta.ask1Price);
    if (delta.openInterest != null) row.openInterest = Number(delta.openInterest);
    if (delta.openInterestValue != null) row.openInterestValue = Number(delta.openInterestValue);
    if (delta.fundingRate != null) row.fundingRate = Number(delta.fundingRate);
    if (delta.nextFundingTime != null) row.nextFundingTime = Number(delta.nextFundingTime);
    if (delta.fundingIntervalHour != null) row.fundingIntervalHour = Number(delta.fundingIntervalHour);
    const turnover24hUsd = Number(delta.turnover24h);
    if (Number.isFinite(turnover24hUsd)) row.turnover24hUsd = turnover24hUsd;
    const highPrice24h = Number(delta.highPrice24h);
    if (Number.isFinite(highPrice24h)) row.highPrice24h = highPrice24h;
    const lowPrice24h = Number(delta.lowPrice24h);
    if (Number.isFinite(lowPrice24h)) row.lowPrice24h = lowPrice24h;

    row.updatedAt = Date.now();
    this.map.set(symbol, row);
  }

  getOpenInterestValue(symbol: string): number | null {
    const r = this.map.get(symbol);
    return r?.openInterestValue ?? null;
  }

  getOpenInterest(symbol: string): number | null {
    const r = this.map.get(symbol);
    return r?.openInterest ?? null;
  }

  getComparableOpenInterest(symbol: string): number | null {
    const r = this.map.get(symbol);
    if (!r) return null;
    if (typeof r.openInterest === "number" && Number.isFinite(r.openInterest) && r.openInterest > 0) return r.openInterest;
    if (typeof r.openInterestValue === "number" && Number.isFinite(r.openInterestValue) && r.openInterestValue > 0 && typeof r.markPrice === "number" && Number.isFinite(r.markPrice) && r.markPrice > 0) {
      return r.openInterestValue / r.markPrice;
    }
    return null;
  }

  getMarkPrice(symbol: string): number | null {
    const r = this.map.get(symbol);
    return r?.markPrice ?? null;
  }


  getRawRow(symbol: string): {
    symbol: string;
    markPrice: number | null;
    lastPrice: number | null;
    bid1: number | null;
    ask1: number | null;
    openInterest: number | null;
  openInterestValue: number | null;
    fundingRate: number | null;
    nextFundingTime: number | null;
    fundingIntervalHour: number | null;
    turnover24hUsd: number | null;
    highPrice24h: number | null;
    lowPrice24h: number | null;
    updatedAt: number;
  } | null {
    const r = this.map.get(symbol);
    if (!r) return null;
    return {
      symbol: r.symbol,
      markPrice: r.markPrice,
      lastPrice: r.lastPrice,
      bid1: r.bid1,
      ask1: r.ask1,
      openInterest: r.openInterest,
      openInterestValue: r.openInterestValue,
      fundingRate: r.fundingRate,
      nextFundingTime: r.nextFundingTime,
      fundingIntervalHour: r.fundingIntervalHour,
      turnover24hUsd: r.turnover24hUsd,
      highPrice24h: r.highPrice24h,
      lowPrice24h: r.lowPrice24h,
      updatedAt: r.updatedAt,
    };
  }

  getRowsForUi(): Array<{
    symbol: string;
    markPrice: number;
    lastPrice: number | null;
    bid1: number | null;
    ask1: number | null;
    openInterest: number | null;
    openInterestValue: number;
    fundingRate: number;
    nextFundingTime: number;
    fundingIntervalHour: number | null;
    turnover24hUsd: number | null;
    highPrice24h: number | null;
    lowPrice24h: number | null;
    updatedAt: number;
  }> {
    const out: any[] = [];
    for (const r of this.map.values()) {
      if (r.markPrice == null || r.openInterestValue == null || r.fundingRate == null || r.nextFundingTime == null) {
        continue;
      }
      out.push({
        symbol: r.symbol,
        markPrice: r.markPrice,
        lastPrice: r.lastPrice,
        bid1: r.bid1,
        ask1: r.ask1,
        openInterest: r.openInterest,
        openInterestValue: r.openInterestValue,
        fundingRate: r.fundingRate,
        nextFundingTime: r.nextFundingTime,
        fundingIntervalHour: r.fundingIntervalHour ?? null,
        turnover24hUsd: r.turnover24hUsd,
        highPrice24h: r.highPrice24h,
        lowPrice24h: r.lowPrice24h,
        updatedAt: r.updatedAt,
      });
    }

    out.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return out;
  }

  getSymbolsByMinTurnover(minTurnoverUsd: number): string[] {
    const threshold = Number.isFinite(minTurnoverUsd) ? Math.max(0, Number(minTurnoverUsd)) : 0;
    const out: string[] = [];
    for (const row of this.map.values()) {
      if (!row.symbol) continue;
      if (!Number.isFinite(row.turnover24hUsd as number)) continue;
      if (Number(row.turnover24hUsd) < threshold) continue;
      out.push(row.symbol);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }
}
