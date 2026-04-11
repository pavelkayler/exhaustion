import { Container } from "react-bootstrap";
import { DashboardOverviewSection } from "./DashboardOverviewSection";
import { DashboardEventsSection } from "./DashboardEventsSection";
import { DashboardManualOrdersSection } from "./DashboardManualOrdersSection";

export function DashboardContentSection() {
  return (
    <Container fluid className="py-2 px-2">
      <DashboardOverviewSection />
      <DashboardEventsSection />
      <DashboardManualOrdersSection />
    </Container>
  );
}
