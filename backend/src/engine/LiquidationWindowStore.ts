export type LiquidationWindowEvent = {
  ts: number;
  symbol: string;
  liquidationSide: "LONG" | "SHORT";
  price: number;
  sizeUsd: number;
  count?: number;
};

export type LiquidationWindowSnapshot = {
  symbol: string;
  lastEventAt: number | null;
  shortLiquidationUsd30s: number;
  shortLiquidationUsd60s: number;
  shortLiquidationUsd5m: number;
  longLiquidationUsd30s: number;
  longLiquidationUsd60s: number;
  longLiquidationUsd5m: number;
  shortLiquidationImbalance60s: number | null;
  shortLiquidationBurstRatio60s: number | null;
  events60s: number;
};

function emptySnapshot(symbol: string): LiquidationWindowSnapshot {
  return {
    symbol,
    lastEventAt: null,
    shortLiquidationUsd30s: 0,
    shortLiquidationUsd60s: 0,
    shortLiquidationUsd5m: 0,
    longLiquidationUsd30s: 0,
    longLiquidationUsd60s: 0,
    longLiquidationUsd5m: 0,
    shortLiquidationImbalance60s: null,
    shortLiquidationBurstRatio60s: null,
    events60s: 0,
  };
}

export class LiquidationWindowStore {
  private readonly bySymbol = new Map<string, LiquidationWindowEvent[]>();
  private readonly retentionMs: number;

  constructor(retentionMs = 10 * 60_000) {
    this.retentionMs = Math.max(60_000, Math.floor(Number(retentionMs) || 0));
  }

  note(event: LiquidationWindowEvent): void {
    const symbol = String(event.symbol ?? "").trim().toUpperCase();
    if (!symbol) return;
    if (!Number.isFinite(event.ts) || event.ts <= 0) return;
    if (!Number.isFinite(event.sizeUsd) || event.sizeUsd <= 0) return;
    const list = this.bySymbol.get(symbol) ?? [];
    list.push({
      ...event,
      symbol,
    });
    this.pruneInPlace(list, event.ts);
    this.bySymbol.set(symbol, list);
  }

  getSnapshot(symbolRaw: string, now: number): LiquidationWindowSnapshot {
    const symbol = String(symbolRaw ?? "").trim().toUpperCase();
    if (!symbol) return emptySnapshot("");
    const list = this.bySymbol.get(symbol) ?? [];
    this.pruneInPlace(list, now);
    this.bySymbol.set(symbol, list);
    if (!list.length) return emptySnapshot(symbol);

    let short30 = 0;
    let short60 = 0;
    let short5m = 0;
    let long30 = 0;
    let long60 = 0;
    let long5m = 0;
    let priorShort = 0;
    let events60s = 0;

    for (let index = list.length - 1; index >= 0; index -= 1) {
      const row = list[index]!;
      const ageMs = now - row.ts;
      if (ageMs > 5 * 60_000) break;
      if (ageMs <= 30_000) {
        if (row.liquidationSide === "SHORT") short30 += row.sizeUsd;
        else long30 += row.sizeUsd;
      }
      if (ageMs <= 60_000) {
        events60s += Math.max(1, Math.floor(Number(row.count) || 1));
        if (row.liquidationSide === "SHORT") short60 += row.sizeUsd;
        else long60 += row.sizeUsd;
      }
      if (ageMs <= 5 * 60_000) {
        if (row.liquidationSide === "SHORT") short5m += row.sizeUsd;
        else long5m += row.sizeUsd;
      }
      if (ageMs > 60_000 && ageMs <= 5 * 60_000 && row.liquidationSide === "SHORT") {
        priorShort += row.sizeUsd;
      }
    }

    const total60 = short60 + long60;
    const priorMinutes = 4;
    const priorShortPerMinute = priorShort / priorMinutes;
    const shortLiquidationBurstRatio60s = priorShortPerMinute > 0 ? short60 / priorShortPerMinute : (short60 > 0 ? 999 : null);
    return {
      symbol,
      lastEventAt: list[list.length - 1]?.ts ?? null,
      shortLiquidationUsd30s: short30,
      shortLiquidationUsd60s: short60,
      shortLiquidationUsd5m: short5m,
      longLiquidationUsd30s: long30,
      longLiquidationUsd60s: long60,
      longLiquidationUsd5m: long5m,
      shortLiquidationImbalance60s: total60 > 0 ? (short60 - long60) / total60 : null,
      shortLiquidationBurstRatio60s,
      events60s,
    };
  }

  private pruneInPlace(list: LiquidationWindowEvent[], now: number): void {
    let dropCount = 0;
    while (dropCount < list.length && now - list[dropCount]!.ts > this.retentionMs) {
      dropCount += 1;
    }
    if (dropCount > 0) {
      list.splice(0, dropCount);
    }
  }
}
