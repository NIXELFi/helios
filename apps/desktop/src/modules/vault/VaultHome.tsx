import { useMemo, useState } from "react";
import { useUser } from "@helios/auth";
import { NavRail, type VaultScreenId } from "./components/NavRail";
import { DownloadModeWelcome } from "./components/DownloadModeWelcome";
import { ToastHost } from "./components/ToastHost";
import { BrowseScreen } from "./screens/BrowseScreen";
import { InsightsScreen } from "./screens/InsightsScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { WhoHasWhatScreen } from "./screens/WhoHasWhatScreen";
import { RecycleScreen } from "./screens/RecycleScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { useLocks } from "./data/useLocks";

export function VaultHome() {
  const [active, setActive] = useState<VaultScreenId>("browse");
  const user = useUser();
  // Live count of the current user's checkouts, shown as a badge on the
  // "Who has what" rail entry — one glance answers "do I have anything out?".
  // useLocks subscribes to lock-change broadcasts, so the badge updates the
  // moment a checkout/check-in lands anywhere in the module.
  const { data: locks } = useLocks();
  const myCheckouts = useMemo(
    () => (locks ?? []).filter((l) => l.user_id === (user?.id ?? "")).length,
    [locks, user],
  );

  return (
    <div className="flex h-full">
      <NavRail active={active} onSelect={setActive} myCheckouts={myCheckouts} />
      <main className="flex-1 overflow-hidden">
        {active === "browse" ? <BrowseScreen /> : null}
        {active === "insights" ? <InsightsScreen /> : null}
        {active === "history" ? <HistoryScreen /> : null}
        {active === "who" ? <WhoHasWhatScreen /> : null}
        {active === "deleted" ? <RecycleScreen /> : null}
        {active === "settings" ? <SettingsScreen /> : null}
      </main>
      <DownloadModeWelcome />
      <ToastHost />
    </div>
  );
}
