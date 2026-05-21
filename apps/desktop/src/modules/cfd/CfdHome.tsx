import { CfdProvider, useCfd } from "./state/CfdContext";
import { NavRail } from "./components/NavRail";
import { ConfigScreen } from "./screens/ConfigScreen";
import { StudiesScreen } from "./screens/StudiesScreen";
import { ResultsScreen } from "./screens/ResultsScreen";

function CfdShell() {
  const { state, navigateTo } = useCfd();
  return (
    <div className="flex h-full w-full bg-[#0B0B0D]">
      <NavRail active={state.activeScreen} onSelect={navigateTo} />
      <div className="min-w-0 flex-1">
        {state.activeScreen === "config" && <ConfigScreen />}
        {state.activeScreen === "studies" && <StudiesScreen />}
        {state.activeScreen === "results" && <ResultsScreen />}
      </div>
    </div>
  );
}

export function CfdHome() {
  return (
    <CfdProvider>
      <CfdShell />
    </CfdProvider>
  );
}
