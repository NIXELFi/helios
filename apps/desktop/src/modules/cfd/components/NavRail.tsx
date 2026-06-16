// Internal nav rail for the CFD module. Data-driven so adding new
// screens (sweep, optimization) in later phases is appending an entry.

import {
  IconAdjustments,
  IconFlask,
  IconGauge,
  IconGitCompare,
  IconReportAnalytics,
  IconSteeringWheel,
  IconTrash,
  type TablerIcon,
} from "@tabler/icons-react";
import type { NavId } from "../state/types";

export interface NavEntry {
  id: NavId;
  label: string;
  disabled?: boolean;
  description?: string;
  Icon?: TablerIcon;
}

export const DEFAULT_NAV_ENTRIES: NavEntry[] = [
  { id: "config", label: "Config", Icon: IconAdjustments },
  { id: "studies", label: "Studies", Icon: IconFlask },
  { id: "results", label: "Results", Icon: IconReportAnalytics },
  { id: "performance", label: "Performance", Icon: IconGauge },
  { id: "lapsim", label: "Lap Sim", Icon: IconSteeringWheel },
  { id: "compare", label: "Compare", Icon: IconGitCompare },
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
    // Shared secondary-sidebar language with the Vault NavRail + PM sidebar:
    // a grey (bg-helios-panel) rail with borderless icon rows — dim by default,
    // a soft gold-tint fill + gold text when active.
    //
    // Clear-data sits ABOVE the screen nav (per user request) with the current
    // capture-dir size, separated by a divider so it reads as a system action.
    <nav className="flex w-44 flex-shrink-0 flex-col border-r border-helios-line bg-helios-panel p-2">
      <button
        type="button"
        onClick={onRequestClearData}
        title="Delete every study capture under <Documents>/Helios/cfd/captures. Configs are NEVER touched."
        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-helios-dim transition-colors hover:bg-helios-danger/10 hover:text-helios-danger"
      >
        <IconTrash size={16} strokeWidth={1.5} className="shrink-0" />
        <span className="flex-1 text-left">Clear data</span>
        <span className="font-mono-num text-[10px] tabular-nums">
          {dataUsageBytes === null ? "…" : formatDataSize(dataUsageBytes)}
        </span>
      </button>
      <div className="-mx-2 my-2 border-b border-helios-line" aria-hidden />
      <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">Screens</p>
      <div className="flex flex-col gap-0.5">
        {entries.map((e) => {
          const isActive = active === e.id;
          const Icon = e.Icon;
          let variant: string;
          if (e.disabled) {
            variant = "cursor-not-allowed text-helios-dim/50";
          } else if (isActive) {
            variant = "bg-asu-gold/15 text-asu-gold";
          } else {
            variant = "text-helios-dim hover:bg-helios-base/60 hover:text-asu-gold";
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
                "flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
                variant
              }
            >
              {Icon && <Icon size={16} strokeWidth={1.5} className="shrink-0" />}
              <span className="flex-1 truncate text-left">{e.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
