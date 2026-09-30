import { useEffect, useState } from "react";
import { IconCloud, IconCloudOff, IconLoader2, IconLogin } from "@tabler/icons-react";

/**
 * Where the team's half of the module stands.
 *
 * The module is two archives merged: this machine's disk, which always works,
 * and the team's, which needs an account and a network. A driver looking at
 * the board has to be able to tell which one they are looking at -- "nobody
 * has beaten my time" and "this rig is offline" look identical otherwise.
 */
export type SyncState =
  | { kind: "signed-out" }
  /** A sync is under way; `at` is the last one that succeeded, if any. */
  | { kind: "syncing"; at: number | null }
  | { kind: "ok"; at: number }
  | { kind: "offline"; at: number | null; message: string };

/** "just now", "2 min ago", "3 h ago", "2 days ago". */
export function fmtAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function SyncPill({
  state, fetching, onSignIn, onRetry,
}: {
  state: SyncState;
  /** "Fetching Jordan's lap…" while a teammate's run is being brought here. */
  fetching: string | null;
  onSignIn: () => void;
  onRetry: () => void;
}) {
  // Re-render twice a minute so "2 min ago" does not freeze at "just now".
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const base = "inline-flex max-w-[360px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition";

  if (fetching) {
    return (
      <span className={base + " border-asu-gold/40 bg-asu-gold/10 text-asu-gold"} role="status" data-testid="sync-pill">
        <IconLoader2 size={12} className="shrink-0 animate-spin" />
        <span className="truncate">{fetching}</span>
      </span>
    );
  }
  if (state.kind === "signed-out") {
    return (
      <button
        type="button"
        className={base + " border-helios-line text-helios-dim hover:border-asu-gold hover:text-helios-text"}
        title="Runs are shared with the team once you sign in to Helios"
        onClick={onSignIn}
        data-testid="sync-pill"
      >
        <IconLogin size={12} className="shrink-0" />
        <span className="truncate">Signed out — showing this machine only</span>
      </button>
    );
  }
  if (state.kind === "offline") {
    return (
      <button
        type="button"
        className={base + " border-helios-warn/40 bg-helios-warn/10 text-helios-warn hover:brightness-110"}
        title={`${state.message}${state.at ? ` · last synced ${fmtAgo(state.at, now)}` : ""}. Click to try again.`}
        onClick={onRetry}
        data-testid="sync-pill"
      >
        <IconCloudOff size={12} className="shrink-0" />
        <span className="truncate">Offline — showing this machine only</span>
      </button>
    );
  }
  if (state.kind === "syncing" && state.at == null) {
    return (
      <span className={base + " border-helios-line text-helios-dim"} role="status" data-testid="sync-pill">
        <IconLoader2 size={12} className="shrink-0 animate-spin" />
        Syncing with the team…
      </span>
    );
  }
  return (
    <button
      type="button"
      className={base + " border-helios-line text-helios-dim hover:border-asu-gold hover:text-helios-text"}
      title="Team runs are read once a minute and whenever a run is written. Click to sync now."
      onClick={onRetry}
      data-testid="sync-pill"
    >
      {state.kind === "syncing"
        ? <IconLoader2 size={12} className="shrink-0 animate-spin" />
        : <IconCloud size={12} className="shrink-0 text-helios-success" />}
      Synced {fmtAgo(state.at!, now)}
    </button>
  );
}
