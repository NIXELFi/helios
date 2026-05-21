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
}

export function NavRail({ entries = DEFAULT_NAV_ENTRIES, active, onSelect }: NavRailProps) {
  return (
    <nav className="flex w-40 flex-col gap-1 border-r border-helios-line bg-helios-base p-2">
      {entries.map((e) => (
        <button
          key={e.id}
          type="button"
          aria-current={active === e.id ? "page" : undefined}
          aria-disabled={e.disabled || undefined}
          disabled={e.disabled}
          onClick={() => onSelect(e.id)}
          title={e.description}
          className={
            "rounded px-3 py-2 text-left text-sm " +
            (e.disabled
              ? "cursor-not-allowed text-helios-dim opacity-50"
              : active === e.id
              ? "bg-helios-line text-helios-text"
              : "text-helios-dim hover:bg-helios-panel")
          }
        >
          {e.label}
        </button>
      ))}
    </nav>
  );
}
