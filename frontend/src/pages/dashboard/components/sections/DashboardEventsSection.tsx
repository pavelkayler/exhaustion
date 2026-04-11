import { EventsTail } from "../../../../features/events/components/EventsTail";
import { useDashboardPageContext } from "../../context/DashboardPageContext";

export function DashboardEventsSection() {
  const { status, events, requestEventsTail } = useDashboardPageContext();

  return <EventsTail enabled={status.sessionState === "RUNNING"} events={events} onRequestTail={requestEventsTail} />;
}
