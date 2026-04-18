import { Card, Table } from "react-bootstrap";
import type { ExecutionOrderRow } from "../../../features/positions/hooks/usePrivatePositionsFeed";
import {
  formatCurrencyRight,
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
  onCancel: (keys: string[]) => void;
};

type AggregatedExecutionOrderRow = {
  groupKey: string;
  symbol: string;
  reason: ExecutionOrderRow["reason"];
  value: number | null;
  entries: Array<number | null>;
  placedAt: number | null;
  orderKeys: string[];
};

function assignEntryPrice(
  entries: Array<number | null>,
  row: ExecutionOrderRow,
): void {
  const price = row.entryPrice ?? null;
  if (price == null) return;

  const slot = Number(row.entrySlot);
  if (Number.isInteger(slot) && slot >= 1 && slot <= entries.length) {
    entries[slot - 1] = price;
    return;
  }

  const nextIndex = entries.findIndex((value) => value == null);
  if (nextIndex >= 0) {
    entries[nextIndex] = price;
  }
}

function aggregateOrders(
  orders: ExecutionOrderRow[],
): AggregatedExecutionOrderRow[] {
  const groups = new Map<string, AggregatedExecutionOrderRow>();

  for (const row of orders) {
    const groupKey = `${row.symbol}:${row.reason}:${row.entryBatch ?? "default"}`;
    const existing = groups.get(groupKey);
    if (!existing) {
      const entries = [null, null, null];
      assignEntryPrice(entries, row);
      groups.set(groupKey, {
        groupKey,
        symbol: row.symbol,
        reason: row.reason,
        value: row.value ?? null,
        entries,
        placedAt: row.placedAt ?? null,
        orderKeys: [row.key],
      });
      continue;
    }

    assignEntryPrice(existing.entries, row);
    existing.orderKeys.push(row.key);
    existing.value =
      Number.isFinite(existing.value as number) || Number.isFinite(row.value as number)
        ? Number(existing.value ?? 0) + Number(row.value ?? 0)
        : null;
    if (
      Number.isFinite(row.placedAt as number)
      && (
        !Number.isFinite(existing.placedAt as number)
        || Number(row.placedAt) < Number(existing.placedAt)
      )
    ) {
      existing.placedAt = row.placedAt ?? null;
    }
  }

  return Array.from(groups.values())
    .sort((left, right) => {
      const bySymbol = left.symbol.localeCompare(right.symbol);
      if (bySymbol !== 0) return bySymbol;
      const byReason = left.reason.localeCompare(right.reason);
      if (byReason !== 0) return byReason;
      return left.groupKey.localeCompare(right.groupKey);
    });
}

export function ExecutionOrdersCard({
  orders,
  status,
  error,
  orderPendingKeys,
  orderFailedKeys,
  orderActionError,
  onCancel,
}: Props) {
  const aggregatedOrders = aggregateOrders(orders);

  return (
    <Card className="genesis-card">
      <Card.Header>Placed Orders</Card.Header>

      {orderActionError ? (
        <div className="px-3 pt-2 small text-danger">{orderActionError}</div>
      ) : null}

      <Card.Body className="p-0">
        <Table hover className="mb-0" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "14%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Reason</th>
              <th>Value</th>
              <th>Entry 1</th>
              <th>Entry 2</th>
              <th>Entry 3</th>
              <th>Placed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {aggregatedOrders.map((row) => {
              const isPending = row.orderKeys.some((key) => Boolean(orderPendingKeys[key]));
              const isFailed = row.orderKeys.some((key) => Boolean(orderFailedKeys[key]));
              const isDisabled = isPending || isFailed;

              return (
                <tr key={row.groupKey}>
                  <td>{row.symbol}</td>
                  <td>{normalizeReason(row.reason)}</td>
                  <td>{formatCurrencyRight(row.value, 2)}</td>
                  <td>{formatCurrencyRight(row.entries[0] ?? null, 2)}</td>
                  <td>{formatCurrencyRight(row.entries[1] ?? null, 2)}</td>
                  <td>{formatCurrencyRight(row.entries[2] ?? null, 2)}</td>
                  <td>{formatMoscowDateTime(row.placedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-link btn-sm p-0 text-decoration-none"
                      disabled={isDisabled}
                      onClick={() => onCancel(row.orderKeys)}
                    >
                      {isPending ? "Cancelling..." : "cancel"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {aggregatedOrders.length === 0 ? (
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
