export type BybitLongShortRatioPoint = {
  symbol: string;
  buyRatio: number;
  sellRatio: number;
  longShortRatio: number | null;
  ts: number;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function fetchBybitLongShortRatio(args: {
  symbol: string;
  period?: "5min" | "15min" | "30min" | "1h" | "4h" | "1d";
  limit?: number;
  restBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<BybitLongShortRatioPoint[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const restBaseUrl = (args.restBaseUrl ?? process.env.BYBIT_REST_URL ?? "https://api.bybit.com").replace(/\/+$/g, "");
  const symbol = String(args.symbol ?? "").trim().toUpperCase();
  if (!symbol) return [];

  const period = args.period ?? "5min";
  const limit = Math.max(1, Math.min(500, Math.floor(Number(args.limit ?? 1))));
  const url = `${restBaseUrl}/v5/market/account-ratio?category=linear&symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&limit=${limit}`;
  const res = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`long_short_ratio_http_${res.status}`);

  const payload = (await res.json()) as any;
  const retCode = Number(payload?.retCode ?? 0);
  if (retCode !== 0) throw new Error(String(payload?.retMsg ?? `long_short_ratio_ret_${retCode}`));

  const list = Array.isArray(payload?.result?.list) ? payload.result.list : [];
  const rows: BybitLongShortRatioPoint[] = [];
  for (const item of list) {
    const buyRatio = Number(item?.buyRatio);
    const sellRatio = Number(item?.sellRatio);
    const ts = Number(item?.timestamp);
    if (!Number.isFinite(buyRatio) || !Number.isFinite(sellRatio) || !Number.isFinite(ts) || ts <= 0) continue;
    const longShortRatio = sellRatio > 0 ? buyRatio / sellRatio : null;
    rows.push({
      symbol,
      buyRatio,
      sellRatio,
      longShortRatio: Number.isFinite(longShortRatio as number) ? longShortRatio : null,
      ts: Math.floor(ts),
    });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}
