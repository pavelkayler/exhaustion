import { useEffect, useMemo, useState } from "react";
import type { ExecutionPositionRow } from "../../../features/positions/hooks/usePrivatePositionsFeed";
import type { SymbolRow } from "../../../shared/types/domain";

const MARK_PRICE_PROJECT_INTERVAL_MS = 10_000;
const MARK_PRICE_PROJECT_MAX_AGE_MS = 60_000;

export type DisplayExecutionPositionRow = ExecutionPositionRow & {
  displayValue: number | null;
  displayPnl: number | null;
  displayUpdatedAt: number | null;
};

function buildMarketPriceBySymbol(rows: SymbolRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    const markPrice = Number(row.markPrice ?? row.lastPrice ?? 0);
    if (!symbol || !(markPrice > 0)) continue;
    out.set(symbol, markPrice);
  }
  return out;
}

function computeProjectedPnl(args: {
  side: string | null;
  size: number | null;
  basePnl: number | null;
  baseMarkPrice: number | null;
  currentMarkPrice: number | null;
}): number | null {
  const size = Number(args.size);
  const basePnl = Number(args.basePnl);
  const baseMarkPrice = Number(args.baseMarkPrice);
  const currentMarkPrice = Number(args.currentMarkPrice);
  const side = String(args.side ?? "").trim().toUpperCase();

  if (!(size > 0) || !Number.isFinite(basePnl) || !(baseMarkPrice > 0) || !(currentMarkPrice > 0)) {
    return args.basePnl;
  }

  if (side === "SELL") {
    return basePnl + (baseMarkPrice - currentMarkPrice) * size;
  }

  if (side === "BUY") {
    return basePnl + (currentMarkPrice - baseMarkPrice) * size;
  }

  return args.basePnl;
}

export function useExecutionProjectedPositions(args: {
  positions: ExecutionPositionRow[];
  marketRows: SymbolRow[];
  marketUpdatedAt: number | null;
  feedUpdatedAt: number | null;
}) {
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const marketPriceBySymbol = useMemo(
    () => buildMarketPriceBySymbol(args.marketRows),
    [args.marketRows, args.marketUpdatedAt],
  );

  const projectedRows = useMemo<DisplayExecutionPositionRow[]>(() => {
    return args.positions.map((row) => {
      const actualUpdatedAt = Number(row.updatedAt ?? 0);
      const currentMarkPrice = marketPriceBySymbol.get(row.symbol) ?? row.markPrice ?? null;
      const canProject =
        actualUpdatedAt > 0 &&
        (clockMs - actualUpdatedAt) >= MARK_PRICE_PROJECT_INTERVAL_MS &&
        (clockMs - actualUpdatedAt) < MARK_PRICE_PROJECT_MAX_AGE_MS &&
        Number(row.size ?? 0) > 0 &&
        Number(row.markPrice ?? 0) > 0 &&
        Number(currentMarkPrice ?? 0) > 0;

      if (!canProject) {
        return {
          ...row,
          displayValue: row.value,
          displayPnl: row.pnl,
          displayUpdatedAt: row.updatedAt,
        };
      }

      const elapsedMs = clockMs - actualUpdatedAt;
      const projectionSteps = Math.floor(elapsedMs / MARK_PRICE_PROJECT_INTERVAL_MS);

      if (projectionSteps <= 0 || projectionSteps >= 6) {
        return {
          ...row,
          displayValue: row.value,
          displayPnl: row.pnl,
          displayUpdatedAt: row.updatedAt,
        };
      }

      const displayUpdatedAt = actualUpdatedAt + projectionSteps * MARK_PRICE_PROJECT_INTERVAL_MS;
      const displayValue =
        Number(row.size ?? 0) > 0 && Number(currentMarkPrice ?? 0) > 0
          ? Number(row.size) * Number(currentMarkPrice)
          : row.value;

      const displayPnl = computeProjectedPnl({
        side: row.side,
        size: row.size,
        basePnl: row.pnl,
        baseMarkPrice: row.markPrice,
        currentMarkPrice,
      });

      return {
        ...row,
        markPrice: currentMarkPrice,
        displayValue,
        displayPnl,
        displayUpdatedAt,
      };
    });
  }, [args.positions, clockMs, marketPriceBySymbol]);

  const displayUpdatedAt = useMemo(() => {
    let maxValue = Number(args.feedUpdatedAt ?? 0);
    for (const row of projectedRows) {
      const candidate = Number(row.displayUpdatedAt ?? 0);
      if (candidate > maxValue) maxValue = candidate;
    }
    return maxValue > 0 ? maxValue : null;
  }, [args.feedUpdatedAt, projectedRows]);

  return {
    projectedRows,
    displayUpdatedAt,
  };
}
