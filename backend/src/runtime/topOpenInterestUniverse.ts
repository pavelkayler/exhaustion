import { configStore } from "./configStore.js";
import { requestStreamLifecycleSync } from "../api/wsHub.js";
import type { RuntimeConfig } from "./configStore.js";
import { isHardExcludedShortSymbol } from "./shortSymbolExclusions.js";

const BYBIT_MARKET_TICKERS_URL = "https://api.bybit.com/v5/market/tickers?category=linear";
const HOURLY_REFRESH_MS = 60 * 60 * 1000;
const FIFTEEN_MIN_REFRESH_MS = 15 * 60 * 1000;
const LEGACY_TOP_SYMBOLS_LIMIT = 100;
const HOT_REGIME_TOP_SYMBOLS_LIMIT = 200;
const LEGACY_UNIVERSE_ID = "bybit-linear-usdt-open-interest-top100";
const HOT_REGIME_UNIVERSE_ID = "bybit-linear-usdt-open-interest-top200";

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

export type TopOpenInterestUniverseSettings = {
  mode: "legacy" | "hot_regime";
  limit: number;
  refreshMs: number;
  universeId: string;
};

export function shouldApplyTopOpenInterestUniverseRefresh(args: {
  requestId: number;
  latestRequestId: number;
  startedSettings: TopOpenInterestUniverseSettings;
  currentSettings: TopOpenInterestUniverseSettings;
}): boolean {
  if (args.requestId !== args.latestRequestId) return false;
  return (
    args.startedSettings.mode === args.currentSettings.mode
    && args.startedSettings.limit === args.currentSettings.limit
    && args.startedSettings.refreshMs === args.currentSettings.refreshMs
    && args.startedSettings.universeId === args.currentSettings.universeId
  );
}

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

export function resolveTopOpenInterestUniverseSettings(
  cfg: Pick<RuntimeConfig, "botConfig"> | null | undefined,
): TopOpenInterestUniverseSettings {
  const useHotRegimeTracking = Boolean(
    (cfg?.botConfig as { observe?: { useHotRegimeTracking?: unknown } } | undefined)?.observe?.useHotRegimeTracking,
  );
  if (useHotRegimeTracking) {
    return {
      mode: "hot_regime",
      limit: HOT_REGIME_TOP_SYMBOLS_LIMIT,
      refreshMs: FIFTEEN_MIN_REFRESH_MS,
      universeId: HOT_REGIME_UNIVERSE_ID,
    };
  }
  return {
    mode: "legacy",
    limit: LEGACY_TOP_SYMBOLS_LIMIT,
    refreshMs: HOURLY_REFRESH_MS,
    universeId: LEGACY_UNIVERSE_ID,
  };
}

export function rankTopOpenInterestSymbols(rows: BybitTickerRow[], limit: number): string[] {
  return rows
    .map((row) => ({
      symbol: String(row.symbol ?? "").trim().toUpperCase(),
      score: scoreOpenInterest(row),
    }))
    .filter((row) => isLinearUsdtPerpSymbol(row.symbol) && row.score > 0 && !isHardExcludedShortSymbol(row.symbol))
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .slice(0, Math.max(1, Math.floor(limit)))
    .map((row) => row.symbol);
}

async function fetchTopOpenInterestSymbols(
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const response = await fetchImpl(BYBIT_MARKET_TICKERS_URL, { method: "GET" });
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
  return rankTopOpenInterestSymbols(rows, limit);
}

export function startTopOpenInterestUniverseScheduler(logger: UniverseRefreshLogger): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastMode = resolveTopOpenInterestUniverseSettings(configStore.get()).mode;
  let refreshRequestId = 0;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const scheduleNextRefresh = () => {
    clearTimer();
    if (stopped) return;
    const settings = resolveTopOpenInterestUniverseSettings(configStore.get());
    timer = setTimeout(() => {
      void refresh("interval");
    }, settings.refreshMs);
  };

  const refresh = async (reason: "startup" | "interval" | "mode_change") => {
    const settings = resolveTopOpenInterestUniverseSettings(configStore.get());
    const requestId = ++refreshRequestId;
    try {
      const symbols = await fetchTopOpenInterestSymbols(settings.limit);
      if (stopped || symbols.length === 0) return;
      const currentSettings = resolveTopOpenInterestUniverseSettings(configStore.get());
      if (!shouldApplyTopOpenInterestUniverseRefresh({
        requestId,
        latestRequestId: refreshRequestId,
        startedSettings: settings,
        currentSettings,
      })) {
        return;
      }
      const previous = configStore.get().universe.symbols;
      const changed = JSON.stringify(previous) !== JSON.stringify(symbols);
      configStore.update({
        universe: {
          selectedId: settings.universeId,
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
          mode: settings.mode,
          refreshMs: settings.refreshMs,
          universeId: settings.universeId,
          topSymbolsPreview: symbols.slice(0, 10),
        },
        "top open interest universe refreshed",
      );
    } catch (error) {
      logger.error(
        {
          reason,
          error: String((error as Error)?.stack ?? (error as Error)?.message ?? error),
          mode: settings.mode,
          universeId: settings.universeId,
        },
        "top open interest universe refresh failed",
      );
    } finally {
      scheduleNextRefresh();
    }
  };

  const onConfigChange = (cfg: RuntimeConfig) => {
    const nextMode = resolveTopOpenInterestUniverseSettings(cfg).mode;
    if (nextMode === lastMode) return;
    lastMode = nextMode;
    clearTimer();
    void refresh("mode_change");
  };

  configStore.on("change", onConfigChange);
  void refresh("startup");

  return () => {
    stopped = true;
    clearTimer();
    configStore.off("change", onConfigChange);
  };
}
