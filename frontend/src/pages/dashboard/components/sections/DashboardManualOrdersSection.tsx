import { ManualTestOrderCard } from "../ManualTestOrderCard";
import { useDashboardPageContext } from "../../context/DashboardPageContext";

export function DashboardManualOrdersSection() {
  const {
    status,
    rows,
    availableWsSymbols,
    availableWsRows,
    runtimeConfig,
    requestRowsRefresh,
    requestEventsTail,
  } = useDashboardPageContext();

  return (
    <ManualTestOrderCard
      sessionState={status.sessionState}
      availableSymbols={availableWsSymbols.length ? availableWsSymbols : rows.map((row) => row.symbol)}
      availableRows={rows}
      availableWsRows={availableWsRows}
      paperDefaults={runtimeConfig?.paper}
      onRequestRowsRefresh={requestRowsRefresh}
      onRequestEventsTail={requestEventsTail}
    />
  );
}
