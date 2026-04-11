import { DashboardContentSection } from "./components/sections/DashboardContentSection";
import { DashboardHeaderSection } from "./components/sections/DashboardHeaderSection";
import { DashboardPageProvider } from "./context/DashboardPageContext";

export function DashboardPage() {
  return (
    <DashboardPageProvider>
      <DashboardHeaderSection />
      <DashboardContentSection />
    </DashboardPageProvider>
  );
}
