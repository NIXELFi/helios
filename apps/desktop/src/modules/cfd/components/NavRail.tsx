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
    <nav className="flex w-32 flex-shrink-0 flex-col border-r border-[#2A2C32] bg-[#0E0E10] py-2">
      {entries.map((e) => {
        const isActive = active === e.id;
        const base =
          "flex items-center justify-between px-3 py-1.5 text-left text-[11px] uppercase tracking-wider border-l-2 ";
        const variant = e.disabled
          ? "cursor-not-allowed border-transparent text-[#5A5F66] opacity-60"
          : isActive
            ? "border-[#FFC627] bg-[#16171B] text-[#FFC627]"
            : "border-transparent text-[#9097A0] hover:bg-[#16171B] hover:text-[#D8DCE2]";
        return (
          <button
            key={e.id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            aria-disabled={e.disabled || undefined}
            disabled={e.disabled}
            onClick={() => onSelect(e.id)}
            title={e.description}
            className={base + variant}
          >
            <span>{e.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
