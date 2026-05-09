import { useState } from "react";
import { NavRail, type VaultScreenId } from "./components/NavRail";
import { BrowseScreen } from "./screens/BrowseScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { WhoHasWhatScreen } from "./screens/WhoHasWhatScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export function VaultHome() {
  const [active, setActive] = useState<VaultScreenId>("browse");

  return (
    <div className="flex h-full">
      <NavRail active={active} onSelect={setActive} />
      <main className="flex-1 overflow-hidden">
        {active === "browse" ? <BrowseScreen /> : null}
        {active === "history" ? <HistoryScreen /> : null}
        {active === "who" ? <WhoHasWhatScreen /> : null}
        {active === "settings" ? <SettingsScreen /> : null}
      </main>
    </div>
  );
}
