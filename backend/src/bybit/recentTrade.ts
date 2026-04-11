export type BybitRecentTradeRow = {
  symbol: string;
  side: "Buy" | "Sell";
  price: number;
  size: number;
  ts: number;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function fetchBybitRecentLinearTrades(args: {
  symbol: string;
  limit?: number;
  restBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<BybitRecentTradeRow[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const restBaseUrl = (args.restBaseUrl ?? process.env.BYBIT_REST_URL ?? "https://api.bybit.com").replace(/\/+$/g, "");
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(args.limit ?? 1000))));
  const symbol = String(args.symbol ?? "").trim().toUpperCase();
  if (!symbol) return [];

  const url = `${restBaseUrl}/v5/market/recent-trade?category=linear&symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  const res = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`recent_trade_http_${res.status}`);
  const payload = (await res.json()) as any;
  const retCode = Number(payload?.retCode ?? 0);
  if (retCode !== 0) throw new Error(String(payload?.retMsg ?? `recent_trade_ret_${retCode}`));
  const list = Array.isArray(payload?.result?.list) ? payload.result.list : [];

  const rows: BybitRecentTradeRow[] = [];
  for (const item of list) {
    const sideRaw = String(item?.side ?? item?.S ?? "");
    const side = sideRaw === "Buy" ? "Buy" : sideRaw === "Sell" ? "Sell" : null;
    const price = Number(item?.price ?? item?.p);
    const size = Number(item?.size ?? item?.v);
    const ts = Number(item?.time ?? item?.T);
    if (!side || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0 || !Number.isFinite(ts) || ts <= 0) continue;
    rows.push({ symbol, side, price, size, ts });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

