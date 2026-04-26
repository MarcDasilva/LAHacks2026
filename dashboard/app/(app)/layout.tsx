import Navbar from "../components/Navbar";
import DashboardThemeScope from "../components/DashboardThemeScope";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dashboard-shell">
      <DashboardThemeScope />
      <Navbar />
      <div className="pt-[57px] pl-14 h-screen overflow-hidden">{children}</div>
    </div>
  );
}
