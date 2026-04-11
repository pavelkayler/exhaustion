import { configStore } from "./configStore.js";
import { requestStreamLifecycleSync } from "../api/wsHub.js";

const BYBIT_MARKET_TICKERS_URL = "https://api.bybit.com/v5/market/tickers?category=linear";
const HOURLY_REFRESH_MS = 60 * 60 * 1000;
const TOP_SYMBOLS_LIMIT = 100;
const UNIVERSE_ID = "bybit-linear-usdt-open-interest-top100";

type UniverseRefreshLogger = {
  info: (payload: Record<string, unknown>, message: string) => void;
  warn: (payload: Record<string, unknown>, message: string) => void;
  error: (payload: Record<string, unknown>, message: string) => void;
};

type BybitTickerRow = {
  symbol?: string;
  openInterest?: string | number;
  openInterestValue?: string | number;
  lastPrice?: string | number;
};

function finite(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isLinearUsdtPerpSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{2,28}USDT$/.test(symbol);
}

function scoreOpenInterest(row: BybitTickerRow): number {
  const openInterestValue = finite(row.openInterestValue);
  if ((openInterestValue ?? 0) > 0) return openInterestValue as number;
  const openInterest = finite(row.openInterest);
  const lastPrice = finite(row.lastPrice);
  if ((openInterest ?? 0) > 0 && (lastPrice ?? 0) > 0) {
    return (openInterest as number) * (lastPrice as number);
  }
  return 0;
}

async function fetchTopOpenInterestSymbols(): Promise<string[]> {
  const response = await fetch(BYBIT_MARKET_TICKERS_URL, { method: "GET" });
  if (!response.ok) {
    throw new Error(`bybit_market_tickers_http_${response.status}`);
  }
  const payload = await response.json() as {
    retCode?: number;
    retMsg?: string;
    result?: { list?: BybitTickerRow[] };
  };
  if (Number(payload?.retCode ?? -1) !== 0) {
    throw new Error(`bybit_market_tickers_ret_${String(payload?.retCode ?? "unknown")}:${String(payload?.retMsg ?? "unknown")}`);
  }
  const rows = Array.isArray(payload?.result?.list) ? payload.result.list : [];
  return rows
    .map((row) => ({
      symbol: String(row.symbol ?? "").trim().toUpperCase(),
      score: scoreOpenInterest(row),
    }))
    .filter((row) => isLinearUsdtPerpSymbol(row.symbol) && row.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .slice(0, TOP_SYMBOLS_LIMIT)
    .map((row) => row.symbol);
}

export function startTopOpenInterestUniverseScheduler(logger: UniverseRefreshLogger): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const refresh = async (reason: "startup" | "interval") => {
    try {
      const symbols = await fetchTopOpenInterestSymbols();
      if (stopped || symbols.length === 0) return;
      const previous = configStore.get().universe.symbols;
      const changed = JSON.stringify(previous) !== JSON.stringify(symbols);
      configStore.update({
        universe: {
          selectedId: UNIVERSE_ID,
          symbols,
        },
      });
      configStore.persist();
      requestStreamLifecycleSync();
      logger.info(
        {
          reason,
          symbolsCount: symbols.length,
          changed,
          universeId: UNIVERSE_ID,
          topSymbolsPreview: symbols.slice(0, 10),
        },
        "top open interest universe refreshed",
      );
    } catch (error) {
      logger.error(
        {
          reason,
          error: String((error as Error)?.stack ?? (error as Error)?.message ?? error),
          universeId: UNIVERSE_ID,
        },
        "top open interest universe refresh failed",
      );
    }
  };

  void refresh("startup");
  timer = setInterval(() => {
    void refresh("interval");
  }, HOURLY_REFRESH_MS);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
}
