import {
  IconChartBar,
  IconFolders,
  IconHistory,
  IconSettings,
  IconTrash,
  IconUsers,
  type TablerIcon,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { VaultSwitcher } from "./VaultSwitcher";

// User & role management moved OUT of the Vault into the top-level Admin module
// (it governs both Vault and PM), so the Vault rail no longer has an Admin entry.
export type VaultScreenId = "browse" | "insights" | "history" | "who" | "deleted" | "settings";

const ENTRIES: { id: VaultScreenId; label: string; Icon: TablerIcon }[] = [
  { id: "browse", label: "Browse", Icon: IconFolders },
  { id: "insights", label: "Insights", Icon: IconChartBar },
  { id: "history", label: "History", Icon: IconHistory },
  { id: "who", label: "Checkouts", Icon: IconUsers },
  { id: "deleted", label: "Deleted", Icon: IconTrash },
  { id: "settings", label: "Settings", Icon: IconSettings },
];

export function NavRail(props: {
  active: VaultScreenId;
  onSelect: (id: VaultScreenId) => void;
  /** Current user's active checkout count — badged on "Who has what" so a
   *  glance at the rail answers "do I have anything out?". */
  myCheckouts?: number;
  /** Rendered at the bottom of the rail — the NotificationFeed bell widget.
   *  Passed as a slot so NavRail stays free of hook dependencies. */
  notificationFeed?: ReactNode;
}) {
  const { active, onSelect, myCheckouts = 0, notificationFeed } = props;
  const entries = ENTRIES;
  return (
    // Shared secondary-sidebar language (CFD NavRail + PM sidebar): a grey
    // (bg-helios-panel) rail with borderless icon rows — dim by default, a
    // soft gold-tint fill + gold text when active, gold text on hover.
    <nav className="flex w-44 flex-col border-r border-helios-line bg-helios-panel">
      <VaultSwitcher />
      <div className="p-2">
        <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">Screens</p>
        <div className="flex flex-col gap-0.5">
        {entries.map((e) => {
          const isActive = active === e.id;
          const Icon = e.Icon;
          return (
            <button
              key={e.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelect(e.id)}
              className={
                "flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
                (isActive
                  ? "bg-asu-gold/15 text-asu-gold"
                  : "text-helios-dim hover:bg-helios-base/60 hover:text-asu-gold")
              }
            >
              <Icon size={16} strokeWidth={1.5} className="shrink-0" />
              <span className="flex-1 truncate text-left">{e.label}</span>
              {e.id === "who" && myCheckouts > 0 && (
                <span
                  title={`You have ${myCheckouts} file${myCheckouts === 1 ? "" : "s"} checked out`}
                  className="ml-1 shrink-0 rounded-full bg-asu-gold/20 px-1.5 py-px font-mono-num text-[10px] leading-4 text-asu-gold"
                >
                  {myCheckouts}
                </span>
              )}
            </button>
          );
        })}
        </div>
      </div>
      {/* Notification bell — rendered at the bottom of the rail so it stays
          visually separated from screen navigation. */}
      {notificationFeed && (
        <div className="mt-auto border-t border-helios-line p-2">
          {notificationFeed}
        </div>
      )}
    </nav>
  );
}
