import type {
  ExecutionPositionRow,
  ExecutionReason,
} from "../../../features/positions/hooks/usePrivatePositionsFeed";

export function formatCurrencyRight(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value as number)) return "-";
  return `${Number(value).toFixed(digits)} $`;
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value as number)) return "-";
  const numeric = Number(value);
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(digits)}%`;
}

export function formatLeverage(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return "-";
  return `${Number(value).toFixed(Number.isInteger(Number(value)) ? 0 : 2)}x`;
}

export function formatUpdatedAt(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return "-";
  return new Date(Number(value)).toLocaleTimeString();
}

export function formatMoscowDateTime(value: number | null | undefined): string {
  if (!Number.isFinite(value as number)) return "-";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(Number(value)));
}

export function renderExecutionFeedMessage(
  kind: "positions" | "orders",
  status: string,
  error: string | null,
): string {
  if (error) return error;
  if (status === "missing_credentials") {
    return "Bybit private websocket credentials are missing in ./backend/.env.";
  }
  if (
    status === "connecting" ||
    status === "authenticating" ||
    status === "subscribing" ||
    status === "reconnecting"
  ) {
    return `${kind === "positions" ? "Positions" : "Orders"} feed: ${status}.`;
  }
  return kind === "positions" ? "No open positions." : "No placed orders.";
}

export function rowVariantClass(row: Pick<ExecutionPositionRow, "pnl">): string {
  if (!Number.isFinite(row.pnl as number) || Number(row.pnl) === 0) return "";
  return Number(row.pnl) > 0 ? "text-success" : "text-danger";
}

export function normalizeReason(value: ExecutionReason): string {
  return value === "candidate" ? "candidate" : value === "final" ? "final" : "manual";
}

export function computeTargetPct(
  targetPrice: number | null,
  entryPrice: number | null,
): number | null {
  const target = Number(targetPrice);
  const entry = Number(entryPrice);
  if (!(target > 0) || !(entry > 0)) return null;
  return ((target - entry) / entry) * 100;
}
