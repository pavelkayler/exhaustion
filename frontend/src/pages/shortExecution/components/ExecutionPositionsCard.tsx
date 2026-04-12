import { useMemo } from "react";
import { Card, Table } from "react-bootstrap";
import type { SymbolRow } from "../../../shared/types/domain";
import type { ExecutionPositionRow } from "../../../features/positions/hooks/usePrivatePositionsFeed";
import {
  computeTargetPct,
  formatCurrencyRight,
  formatPercent,
  formatUpdatedAt,
  normalizeReason,
  renderExecutionFeedMessage,
  rowVariantClass,
} from "./executionUi";

type Props = {
  rows: SymbolRow[];
  positions: ExecutionPositionRow[];
  status: string;
  error: string | null;
  updatedAt: number | null;
  marketUpdatedAt: number | null;
};

type DisplayPositionRow = ExecutionPositionRow & {
  displayValue: number | null;
  displayPnl: number | null;
};

function computeLivePnl(args: {
  side: string | null;
  size: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  fallbackPnl: number | null;
}): number | null {
  const size = Number(args.size);
  const entryPrice = Number(args.entryPrice);
  const currentPrice = Number(args.currentPrice);
  const side = String(args.side ?? "").trim().toUpperCase();

  if (!(size > 0) || !(entryPrice > 0) || !(currentPrice > 0)) {
    return args.fallbackPnl;
  }

  if (side === "SELL") return (entryPrice - currentPrice) * size;
  if (side === "BUY") return (currentPrice - entryPrice) * size;

  return args.fallbackPnl;
}

export function ExecutionPositionsCard({
  rows,
  positions,
  status,
  error,
  updatedAt,
  marketUpdatedAt,
}: Props) {
  const effectiveUpdatedAt = Math.max(
    Number(updatedAt ?? 0),
    Number(marketUpdatedAt ?? 0),
  ) || null;

  const marketPriceBySymbol = useMemo(() => {
    const out = new Map<string, number>();
    for (const row of rows) {
      const symbol = String(row.symbol ?? "").trim().toUpperCase();
      const markPrice = Number(row.markPrice ?? row.lastPrice ?? 0);
      if (!symbol || !(markPrice > 0)) continue;
      out.set(symbol, markPrice);
    }
    return out;
  }, [rows, marketUpdatedAt]);

  const displayRows = useMemo<DisplayPositionRow[]>(() => {
    return positions.map((row) => {
      const currentPrice = marketPriceBySymbol.get(row.symbol) ?? row.markPrice ?? null;
      const size = Number(row.size ?? 0);

      return {
        ...row,
        displayValue:
          size > 0 && Number(currentPrice) > 0 ? size * Number(currentPrice) : row.value ?? null,
        displayPnl: computeLivePnl({
          side: row.side,
          size: row.size,
          entryPrice: row.entryPrice,
          currentPrice,
          fallbackPnl: row.pnl,
        }),
      };
    });
  }, [marketPriceBySymbol, positions, marketUpdatedAt]);

  return (
    <Card className="genesis-card">
      <Card.Header className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
        <span>Positions</span>
        <small className="text-secondary">updated: {formatUpdatedAt(effectiveUpdatedAt)}</small>
      </Card.Header>
      <Card.Body className="p-0">
        <Table responsive hover className="mb-0" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "20%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "16%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Reason</th>
              <th>Value</th>
              <th>PnL</th>
              <th>TP</th>
              <th>SL</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <tr key={row.key}>
                <td>{row.symbol}</td>
                <td>{normalizeReason(row.reason)}</td>
                <td>{formatCurrencyRight(row.displayValue, 2)}</td>
                <td className={rowVariantClass({ pnl: row.displayPnl })}>
                  {formatCurrencyRight(row.displayPnl, 2)}
                </td>
                <td>{formatPercent(computeTargetPct(row.tp, row.entryPrice), 2)}</td>
                <td>{formatPercent(computeTargetPct(row.sl, row.entryPrice), 2)}</td>
              </tr>
            ))}
            {displayRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center text-secondary py-4">
                  {renderExecutionFeedMessage("positions", status, error)}
                </td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card.Body>
    </Card>
  );
}
