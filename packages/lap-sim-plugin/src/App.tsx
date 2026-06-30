import { useEffect } from "react";
import { ready, log } from "@helios/plugin-sdk";
import { SDM26_VEHICLE } from "@helios/lapsim-core";
import { LapSimScreen } from "./LapSimScreen";
import { DEFAULT_SOURCES } from "./sources";

export function App() {
  // Wait for the host handshake (no-op when running outside Helios).
  useEffect(() => {
    void ready()
      .then((ctx) => log("Lap Sim ready", ctx))
      .catch(() => {});
  }, []);

  // The screen owns its own full-height layout; the app shell just fills the
  // iframe viewport so it can stretch into it.
  return (
    <div className="app-root">
      <LapSimScreen sources={DEFAULT_SOURCES} vehicleConfig={SDM26_VEHICLE} />
    </div>
  );
}
