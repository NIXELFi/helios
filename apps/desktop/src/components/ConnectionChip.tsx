import { useEffect, useState } from "react";
import { useConnectionState } from "../lib/connection-status";

/** How long the link has to stay down before the chip appears — a single
 *  socket hiccup that reconnects inside this window never shows. */
export const CONNECTION_GRACE_MS = 5000;

/**
 * Title-bar chip for a lost live connection. Reads lib/connection-status
 * (fed by the presence channel) plus the browser's own online/offline
 * signal, and only appears once the link has been down for a grace period.
 * Without it a dropped realtime socket was silent: PM stopped updating,
 * the presence roster went stale, and nothing said why.
 */
export function ConnectionChip() {
  const realtime = useConnectionState();
  const [offline, setOffline] = useState(
    typeof navigator !== "undefined" && navigator.onLine === false,
  );
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const down = offline || realtime === "down";
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!down) {
      setShown(false);
      return;
    }
    const id = window.setTimeout(() => setShown(true), CONNECTION_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [down]);

  if (!shown) return null;
  const label = offline ? "Offline" : "Reconnecting…";
  return (
    <span
      role="status"
      title={
        offline
          ? "No network connection. Helios will resume live updates when it's back."
          : "Lost the live connection to the Helios server. Trying to reconnect — data may be stale until then."
      }
      aria-label={`Connection: ${label}`}
      className="mr-2 flex h-[22px] items-center gap-1.5 rounded px-2 text-[11px] text-[#EF5350]"
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#EF5350] animate-pulse" />
      <span className="font-mono-num">{label}</span>
    </span>
  );
}
