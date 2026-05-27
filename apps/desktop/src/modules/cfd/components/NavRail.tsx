// Internal nav rail for the CFD module. Data-driven so adding new
// screens (sweep, optimization) in later phases is appending an entry.

import type { NavId } from "../state/types";

export interface NavEntry {
  id: NavId;
  label: string;
  disabled?: boolean;
  description?: string;
}

export const DEFAULT_NAV_ENTRIES: NavEntry[] = [
  { id: "config", label: "Config" },
  { id: "studies", label: "Studies" },
  { id: "results", label: "Results" },
];

interface NavRailProps {
  entries?: NavEntry[];
  active: NavId;
  onSelect: (id: NavId) => void;
  /** Total bytes consumed by `<Documents>/Helios/cfd/captures`. Surfaced
   *  in the "Clear data" button so the user can see how much disk the
   *  accumulated runs are eating before deciding to wipe them. `null`
   *  while the size is still loading. */
  dataUsageBytes: number | null;
  /** Triggered by the Clear-data button. Opens the confirm modal in
   *  CfdShell; CfdShell calls bridge.clearAllData() on confirm. */
  onRequestClearData: () => void;
}

/** Format a byte count for the Clear-data button. Picks GB / MB / KB / B
 *  based on magnitude, capped to two decimals. Zero renders as "0 B" so
 *  the chrome stays the same width whether or not data exists. */
export function formatDataSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const KB = 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function NavRail(props: NavRailProps) {
  const { entries = DEFAULT_NAV_ENTRIES, active, onSelect, dataUsageBytes, onRequestClearData } = props;
  return (
    // Mirrors the Vault NavRail + the Log workspace tabs: helios-* tokens,
    // small rounded-sm pills, gold-on-hover, solid gold fill when active.
    // Kept the uppercase tracking-wider tab labels since CFD's screens use
    // the same micro-header treatment ("Engine config", "Studies"), so the
    // typography reads as one consistent family.
    //
    // Clear-data button sits ABOVE the main nav entries (per user request)
    // and shows the current capture-dir size so the user has a sense of
    // what they're about to wipe. Visually separated with a border-b
    // divider so it reads as "system action", not "screen nav".
    <nav className="flex w-44 flex-shrink-0 flex-col border-r border-helios-line bg-helios-base p-2">
      <button
        type="button"
        onClick={onRequestClearData}
        title="Delete every study capture under <Documents>/Helios/cfd/captures. Configs are NEVER touched."
        className={
          "mb-2 rounded-sm border border-helios-line bg-helios-panel px-3 py-1.5 text-left " +
          "text-[10px] uppercase tracking-wider text-helios-dim transition-colors " +
          "hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-200"
        }
      >
        <div className="flex items-baseline justify-between gap-1">
          <span>Clear data</span>
          <span className="font-mono-num text-[9px] tabular-nums">
            {dataUsageBytes === null ? "…" : formatDataSize(dataUsageBytes)}
          </span>
        </div>
        <div className="mt-0.5 text-[8px] normal-case tracking-normal text-[#5A5F66]">
          configs preserved
        </div>
      </button>
      <div className="-mx-2 mb-2 border-b border-helios-line" aria-hidden />
      <div className="flex flex-col gap-1">
        {entries.map((e) => {
          const isActive = active === e.id;
          let variant: string;
          if (e.disabled) {
            variant = "cursor-not-allowed border-helios-line bg-helios-panel text-helios-dim opacity-60";
          } else if (isActive) {
            variant = "border-asu-gold bg-asu-gold font-semibold text-helios-base";
          } else {
            variant = "border-helios-line bg-helios-panel text-helios-text hover:border-asu-gold";
          }
          return (
            <button
              key={e.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              aria-disabled={e.disabled || undefined}
              disabled={e.disabled}
              onClick={() => onSelect(e.id)}
              title={e.description}
              className={
                "rounded-sm border px-3 py-1.5 text-left text-[11px] uppercase tracking-wider transition-colors " +
                variant
              }
            >
              {e.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
