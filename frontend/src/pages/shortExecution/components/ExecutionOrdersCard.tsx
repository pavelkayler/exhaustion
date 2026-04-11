import { Card, Table } from "react-bootstrap";
import type { ExecutionOrderRow } from "../../../features/positions/hooks/usePrivatePositionsFeed";
import {
  formatCurrencyRight,
  formatLeverage,
  formatMoscowDateTime,
  normalizeReason,
  renderExecutionFeedMessage,
} from "./executionUi";

type Props = {
  orders: ExecutionOrderRow[];
  status: string;
  error: string | null;
};

export function ExecutionOrdersCard({ orders, status, error }: Props) {
  return (
    <Card className="genesis-card">
      <Card.Header>Placed Orders</Card.Header>
      <Card.Body className="p-0">
        <Table responsive hover className="mb-0" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "16%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "15%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Reason</th>
              <th>Value</th>
              <th>Margin</th>
              <th>Leverage</th>
              <th>Entry Price</th>
              <th>Placed</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((row) => (
              <tr key={row.key}>
                <td>{row.symbol}</td>
                <td>{normalizeReason(row.reason)}</td>
                <td>{formatCurrencyRight(row.value, 2)}</td>
                <td>{formatCurrencyRight(row.margin, 2)}</td>
                <td>{formatLeverage(row.leverage)}</td>
                <td>{formatCurrencyRight(row.entryPrice, 2)}</td>
                <td>{formatMoscowDateTime(row.placedAt)}</td>
              </tr>
            ))}
            {orders.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-secondary py-4">
                  {renderExecutionFeedMessage("orders", status, error)}
                </td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card.Body>
    </Card>
  );
}
