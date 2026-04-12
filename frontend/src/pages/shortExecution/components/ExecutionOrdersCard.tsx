import { Card, Table } from "react-bootstrap";
import type { ExecutionOrderRow } from "../../../features/positions/hooks/usePrivatePositionsFeed";
import {
  formatCurrencyRight,
  formatLeverage,
  formatMoscowDateTime,
  normalizeReason,
  renderExecutionFeedMessage,
} from "./executionUi";

type ActionKeyMap = Record<string, true>;

type Props = {
  orders: ExecutionOrderRow[];
  status: string;
  error: string | null;
  orderPendingKeys: ActionKeyMap;
  orderFailedKeys: ActionKeyMap;
  orderActionError: string | null;
  onCancel: (key: string) => void;
};

export function ExecutionOrdersCard({
  orders,
  status,
  error,
  orderPendingKeys,
  orderFailedKeys,
  orderActionError,
  onCancel,
}: Props) {
  return (
    <Card className="genesis-card">
      <Card.Header>Placed Orders</Card.Header>

      {orderActionError ? (
        <div className="px-3 pt-2 small text-danger">{orderActionError}</div>
      ) : null}

      <Card.Body className="p-0">
        <Table hover className="mb-0" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "12%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "12%" }} />
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
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((row) => {
              const isPending = Boolean(orderPendingKeys[row.key]);
              const isFailed = Boolean(orderFailedKeys[row.key]);
              const isDisabled = isPending || isFailed;

              return (
                <tr key={row.key}>
                  <td>{row.symbol}</td>
                  <td>{normalizeReason(row.reason)}</td>
                  <td>{formatCurrencyRight(row.value, 2)}</td>
                  <td>{formatCurrencyRight(row.margin, 2)}</td>
                  <td>{formatLeverage(row.leverage)}</td>
                  <td>{formatCurrencyRight(row.entryPrice, 2)}</td>
                  <td>{formatMoscowDateTime(row.placedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-link btn-sm p-0 text-decoration-none"
                      disabled={isDisabled}
                      onClick={() => onCancel(row.key)}
                    >
                      {isPending ? "Cancelling..." : "cancel"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {orders.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center text-secondary py-4">
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
