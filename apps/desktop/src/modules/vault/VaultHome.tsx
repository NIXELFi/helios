import { useEffect, useState } from "react";
import { NavRail, type VaultScreenId } from "./components/NavRail";
import { DownloadModeWelcome } from "./components/DownloadModeWelcome";
import { BrowseScreen } from "./screens/BrowseScreen";
import { InsightsScreen } from "./screens/InsightsScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { WhoHasWhatScreen } from "./screens/WhoHasWhatScreen";
import { RecycleScreen } from "./screens/RecycleScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { AdminScreen } from "./screens/AdminScreen";
import { useIsAdmin } from "./data/useIsAdmin";

export function VaultHome() {
  const [active, setActive] = useState<VaultScreenId>("browse");
  const isAdmin = useIsAdmin();

  // If a non-admin somehow lands on the admin screen (e.g. they were demoted
  // while it was open), bounce them back to Browse so the gated screen can't
  // render without the rail entry that leads to it.
  useEffect(() => {
    if (active === "admin" && !isAdmin) setActive("browse");
  }, [active, isAdmin]);

  return (
    <div className="flex h-full">
      <NavRail active={active} onSelect={setActive} showAdmin={isAdmin} />
      <main className="flex-1 overflow-hidden">
        {active === "browse" ? <BrowseScreen /> : null}
        {active === "insights" ? <InsightsScreen /> : null}
        {active === "history" ? <HistoryScreen /> : null}
        {active === "who" ? <WhoHasWhatScreen /> : null}
        {active === "deleted" ? <RecycleScreen /> : null}
        {active === "settings" ? <SettingsScreen /> : null}
        {active === "admin" && isAdmin ? <AdminScreen /> : null}
      </main>
      <DownloadModeWelcome />
    </div>
  );
}
