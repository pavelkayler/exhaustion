import { Card, Table } from "react-bootstrap";
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
  positions: ExecutionPositionRow[];
  status: string;
  error: string | null;
  updatedAt: number | null;
};

export function ExecutionPositionsCard({
  positions,
  status,
  error,
  updatedAt,
}: Props) {
  return (
    <Card className="genesis-card">
      <Card.Header className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
        <span>Positions</span>
        <small className="text-secondary">updated: {formatUpdatedAt(updatedAt)}</small>
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
            {positions.map((row) => (
              <tr key={row.key}>
                <td>{row.symbol}</td>
                <td>{normalizeReason(row.reason)}</td>
                <td>{formatCurrencyRight(row.value, 2)}</td>
                <td className={rowVariantClass(row)}>
                  {formatCurrencyRight(row.pnl, 2)}
                </td>
                <td>{formatPercent(computeTargetPct(row.tp, row.entryPrice), 2)}</td>
                <td>{formatPercent(computeTargetPct(row.sl, row.entryPrice), 2)}</td>
              </tr>
            ))}
            {positions.length === 0 ? (
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
