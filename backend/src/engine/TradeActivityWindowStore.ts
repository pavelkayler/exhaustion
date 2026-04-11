export type TradeActivityWindowEvent = {
  ts: number;
  symbol: string;
  side: "Buy" | "Sell";
  price: number;
  size: number;
  count?: number;
};

export type TradeActivityWindowSnapshot = {
  symbol: string;
  lastTradeAt: number | null;
  volume30s: number;
  volume1m: number;
  volume3m: number;
  volume5m: number;
  volume15m: number;
  turnover30s: number;
  turnover1m: number;
  turnover3m: number;
  turnover5m: number;
  turnover15m: number;
  trades30s: number;
  trades1m: number;
  trades3m: number;
  trades5m: number;
  trades15m: number;
  volumeBurst1mVs15m: number | null;
  volumeBurst3mVs15m: number | null;
  turnoverBurst1mVs15m: number | null;
  turnoverBurst3mVs15m: number | null;
};

const THIRTY_SEC_MS = 30_000;
const ONE_MIN_MS = 60_000;
const THREE_MIN_MS = 3 * 60_000;
const FIVE_MIN_MS = 5 * 60_000;
const FIFTEEN_MIN_MS = 15 * 60_000;

function emptySnapshot(symbol: string): TradeActivityWindowSnapshot {
  return {
    symbol,
    lastTradeAt: null,
    volume30s: 0,
    volume1m: 0,
    volume3m: 0,
    volume5m: 0,
    volume15m: 0,
    turnover30s: 0,
    turnover1m: 0,
    turnover3m: 0,
    turnover5m: 0,
    turnover15m: 0,
    trades30s: 0,
    trades1m: 0,
    trades3m: 0,
    trades5m: 0,
    trades15m: 0,
    volumeBurst1mVs15m: null,
    volumeBurst3mVs15m: null,
    turnoverBurst1mVs15m: null,
    turnoverBurst3mVs15m: null,
  };
}

function burstRatio(windowValue: number, windowMinutes: number, baselineValue: number, baselineMinutes: number): number | null {
  if (!(windowValue > 0)) return baselineValue > 0 ? 0 : null;
  if (!(baselineValue > 0) || !(baselineMinutes > 0) || !(windowMinutes > 0)) return 999;
  const windowPerMinute = windowValue / windowMinutes;
  const baselinePerMinute = baselineValue / baselineMinutes;
  if (!(baselinePerMinute > 0)) return 999;
  return windowPerMinute / baselinePerMinute;
}

export class TradeActivityWindowStore {
  private readonly bySymbol = new Map<string, TradeActivityWindowEvent[]>();
  private readonly retentionMs: number;

  constructor(retentionMs = 20 * 60_000) {
    this.retentionMs = Math.max(FIFTEEN_MIN_MS, Math.floor(Number(retentionMs) || 0));
  }

  note(event: TradeActivityWindowEvent): void {
    const symbol = String(event.symbol ?? "").trim().toUpperCase();
    if (!symbol) return;
    if (!Number.isFinite(event.ts) || event.ts <= 0) return;
    if (!Number.isFinite(event.price) || event.price <= 0) return;
    if (!Number.isFinite(event.size) || event.size <= 0) return;
    const side = event.side === "Sell" ? "Sell" : "Buy";
    const list = this.bySymbol.get(symbol) ?? [];
    list.push({
      ...event,
      symbol,
      side,
    });
    this.pruneInPlace(list, event.ts);
    this.bySymbol.set(symbol, list);
  }

  getSnapshot(symbolRaw: string, now: number): TradeActivityWindowSnapshot {
    const symbol = String(symbolRaw ?? "").trim().toUpperCase();
    if (!symbol) return emptySnapshot("");
    const list = this.bySymbol.get(symbol) ?? [];
    this.pruneInPlace(list, now);
    this.bySymbol.set(symbol, list);
    if (!list.length) return emptySnapshot(symbol);

    let volume30s = 0;
    let volume1m = 0;
    let volume3m = 0;
    let volume5m = 0;
    let volume15m = 0;
    let turnover30s = 0;
    let turnover1m = 0;
    let turnover3m = 0;
    let turnover5m = 0;
    let turnover15m = 0;
    let trades30s = 0;
    let trades1m = 0;
    let trades3m = 0;
    let trades5m = 0;
    let trades15m = 0;

    for (let index = list.length - 1; index >= 0; index -= 1) {
      const row = list[index]!;
      const ageMs = now - row.ts;
      if (ageMs > FIFTEEN_MIN_MS) break;
      const notional = row.price * row.size;
      if (ageMs <= THIRTY_SEC_MS) {
        volume30s += row.size;
        turnover30s += notional;
        trades30s += Math.max(1, Math.floor(Number(row.count) || 1));
      }
      if (ageMs <= ONE_MIN_MS) {
        volume1m += row.size;
        turnover1m += notional;
        trades1m += Math.max(1, Math.floor(Number(row.count) || 1));
      }
      if (ageMs <= THREE_MIN_MS) {
        volume3m += row.size;
        turnover3m += notional;
        trades3m += Math.max(1, Math.floor(Number(row.count) || 1));
      }
      if (ageMs <= FIVE_MIN_MS) {
        volume5m += row.size;
        turnover5m += notional;
        trades5m += Math.max(1, Math.floor(Number(row.count) || 1));
      }
      if (ageMs <= FIFTEEN_MIN_MS) {
        volume15m += row.size;
        turnover15m += notional;
        trades15m += Math.max(1, Math.floor(Number(row.count) || 1));
      }
    }

    return {
      symbol,
      lastTradeAt: list[list.length - 1]?.ts ?? null,
      volume30s,
      volume1m,
      volume3m,
      volume5m,
      volume15m,
      turnover30s,
      turnover1m,
      turnover3m,
      turnover5m,
      turnover15m,
      trades30s,
      trades1m,
      trades3m,
      trades5m,
      trades15m,
      volumeBurst1mVs15m: burstRatio(volume1m, 1, volume15m, 15),
      volumeBurst3mVs15m: burstRatio(volume3m, 3, volume15m, 15),
      turnoverBurst1mVs15m: burstRatio(turnover1m, 1, turnover15m, 15),
      turnoverBurst3mVs15m: burstRatio(turnover3m, 3, turnover15m, 15),
    };
  }

  private pruneInPlace(list: TradeActivityWindowEvent[], now: number): void {
    let dropCount = 0;
    while (dropCount < list.length && now - list[dropCount]!.ts > this.retentionMs) {
      dropCount += 1;
    }
    if (dropCount > 0) {
      list.splice(0, dropCount);
    }
  }
}
