import { useEffect, useState } from "react";
import { useVaultSyncStatus } from "../lib/vault-sync-status";

/** How long the "Pulled N" / "Up to date" result stays in the bar after a
 *  pass finishes before the chip hides itself. Failures don't time out. */
export const RESULT_LINGER_MS = 6000;

/**
 * Title-bar chip mirroring the Vault's auto-sync pill so a running sync stays
 * visible after the user clicks off the Vault. Reads lib/vault-sync-status
 * (published by useAutoSync) and renders nothing when there's nothing to say:
 * no sync hook mounted, or idle with no recent result.
 *
 *   busy       → gold pulse, "Syncing 3/12", thin progress underline
 *   failed     → red "2 failed" (stays until the next pass)
 *   just done  → green "Pulled 5" / dim "Up to date" for RESULT_LINGER_MS
 *
 * Clicking jumps to the Vault, where the full pill + popover live.
 */
export function SyncStatusChip({ onClick }: { onClick: () => void }) {
  const status = useVaultSyncStatus();
  const busy = status?.busy ?? false;
  const lastRunAt = status?.lastRunAt ?? null;

  // Linger the result of a pass that finished while this chip was mounted.
  // Keyed on lastRunAt so a pass that ends with nothing to pull ("Up to date")
  // still flashes once, and a second pass restarts the timer.
  const [lingerFor, setLingerFor] = useState<string | null>(null);
  useEffect(() => {
    if (busy || !lastRunAt) return;
    setLingerFor(lastRunAt);
    const id = window.setTimeout(() => {
      setLingerFor((cur) => (cur === lastRunAt ? null : cur));
    }, RESULT_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [busy, lastRunAt]);

  if (!status) return null;

  let label: string;
  let tone: string;
  let dot: string;
  let title: string;
  if (busy) {
    const { completedTasks, totalTasks, activeFiles, completedBytes, totalBytes } = status;
    label = totalTasks > 0 ? `Syncing ${completedTasks}/${totalTasks}` : "Syncing…";
    tone = "text-asu-gold";
    dot = "bg-asu-gold animate-pulse";
    const pct = totalBytes > 0 ? Math.floor((completedBytes / totalBytes) * 100) : 0;
    title = `Vault sync ${pct}%` + (activeFiles.length ? `\n${activeFiles.join("\n")}` : "") + "\nClick to open the Vault";
  } else if (status.lastFailed > 0) {
    label = `${status.lastFailed} failed`;
    tone = "text-[#EF5350]";
    dot = "bg-[#EF5350]";
    title = "Vault sync: some files failed to download. Click to open the Vault";
  } else if (lingerFor && lingerFor === lastRunAt) {
    if (status.lastDownloaded > 0) {
      label = `Pulled ${status.lastDownloaded}`;
      tone = "text-green-400";
      dot = "bg-green-400";
    } else {
      label = "Up to date";
      tone = "text-helios-dim";
      dot = "bg-helios-line";
    }
    title = "Vault sync finished. Click to open the Vault";
  } else {
    return null;
  }

  const pct = busy && status.totalBytes > 0
    ? Math.min(100, Math.floor((status.completedBytes / status.totalBytes) * 100))
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`Vault sync: ${label}`}
      className={
        "relative mr-2 flex h-[22px] cursor-pointer items-center gap-1.5 overflow-hidden rounded px-2 text-[11px] transition-colors hover:bg-white/[0.07] " +
        tone
      }
    >
      <span className={"inline-block h-1.5 w-1.5 rounded-full " + dot} />
      <span className="font-mono-num tabular-nums">Vault · {label}</span>
      {pct != null && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[2px] bg-asu-gold/70 transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      )}
    </button>
  );
}
