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
import { useExecutionProjectedPositions } from "../hooks/useExecutionProjectedPositions";

type ActionKeyMap = Record<string, true>;

type Props = {
  positions: ExecutionPositionRow[];
  status: string;
  error: string | null;
  updatedAt: number | null;
  marketRows: SymbolRow[];
  marketUpdatedAt: number | null;
  positionPendingKeys: ActionKeyMap;
  positionFailedKeys: ActionKeyMap;
  positionActionError: string | null;
  onCloseMarket: (key: string) => void;
};

export function ExecutionPositionsCard({
  positions,
  status,
  error,
  updatedAt,
  marketRows,
  marketUpdatedAt,
  positionPendingKeys,
  positionFailedKeys,
  positionActionError,
  onCloseMarket,
}: Props) {
  const { projectedRows, displayUpdatedAt } = useExecutionProjectedPositions({
    positions,
    marketRows,
    marketUpdatedAt,
    feedUpdatedAt: updatedAt,
  });

  return (
    <Card className="genesis-card">
      <Card.Header className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
        <span>Positions</span>
        <small className="text-secondary">updated: {formatUpdatedAt(displayUpdatedAt)}</small>
      </Card.Header>

      {positionActionError ? (
        <div className="px-3 pt-2 small text-danger">{positionActionError}</div>
      ) : null}

      <Card.Body className="p-0">
        <Table hover className="mb-0" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "18%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "20%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Reason</th>
              <th>Value</th>
              <th>PnL</th>
              <th>TP</th>
              <th>SL</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {projectedRows.map((row) => {
              const isPending = Boolean(positionPendingKeys[row.key]);
              const isFailed = Boolean(positionFailedKeys[row.key]);
              const isDisabled = isPending || isFailed;

              return (
                <tr key={row.key}>
                  <td>{row.symbol}</td>
                  <td>{normalizeReason(row.reason)}</td>
                  <td>{formatCurrencyRight(row.displayValue, 2)}</td>
                  <td className={rowVariantClass({ pnl: row.displayPnl })}>
                    {formatCurrencyRight(row.displayPnl, 2)}
                  </td>
                  <td>{formatPercent(computeTargetPct(row.tp, row.entryPrice), 2)}</td>
                  <td>{formatPercent(computeTargetPct(row.sl, row.entryPrice), 2)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-link btn-sm p-0 text-decoration-none"
                      disabled={isDisabled}
                      onClick={() => onCloseMarket(row.key)}
                    >
                      {isPending ? "Closing..." : "Close Market"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {projectedRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-secondary py-4">
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
