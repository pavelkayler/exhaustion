import { BotSummaryBar } from "../BotSummaryBar";
import { useDashboardPageContext } from "../../context/DashboardPageContext";

export function DashboardOverviewSection() {
  const { status, botStats, uptimeText } = useDashboardPageContext();

  return (
    <BotSummaryBar sessionState={status.sessionState} botStats={botStats} uptimeText={uptimeText} />
  );
}
