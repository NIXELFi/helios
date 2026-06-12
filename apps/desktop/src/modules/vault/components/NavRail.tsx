import { VaultSwitcher } from "./VaultSwitcher";

export type VaultScreenId = "browse" | "insights" | "history" | "who" | "deleted" | "settings" | "admin";

const ENTRIES: { id: VaultScreenId; label: string }[] = [
  { id: "browse", label: "Browse" },
  { id: "insights", label: "Insights" },
  { id: "history", label: "History" },
  { id: "who", label: "Who has what" },
  { id: "deleted", label: "Deleted" },
  { id: "settings", label: "Settings" },
];

// The Admin entry is appended only for admins (gated by the caller via
// `showAdmin`), so non-admins never even see the user-management screen.
const ADMIN_ENTRY: { id: VaultScreenId; label: string } = { id: "admin", label: "Admin" };

export function NavRail(props: {
  active: VaultScreenId;
  onSelect: (id: VaultScreenId) => void;
  showAdmin?: boolean;
  /** Current user's active checkout count — badged on "Who has what" so a
   *  glance at the rail answers "do I have anything out?". */
  myCheckouts?: number;
}) {
  const { active, onSelect, showAdmin, myCheckouts = 0 } = props;
  const entries = showAdmin ? [...ENTRIES, ADMIN_ENTRY] : ENTRIES;
  return (
    // Same button language as the Log workspace tabs in App.tsx — small
    // rounded-sm pills with bg-helios-panel + border-helios-line, gold
    // border on hover, solid gold fill on active. Keeps Log / Vault / CFD
    // visually in the same family.
    <nav className="flex w-44 flex-col border-r border-helios-line bg-helios-base p-2">
      <div className="mb-2">
        <VaultSwitcher />
      </div>
      <div className="flex flex-col gap-1">
        {entries.map((e) => {
          const isActive = active === e.id;
          return (
            <button
              key={e.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelect(e.id)}
              className={
                "flex items-center justify-between rounded-sm border px-3 py-1.5 text-left text-sm transition-colors " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
                (isActive
                  ? "border-asu-gold bg-asu-gold font-semibold text-helios-base hover:bg-asu-gold/90"
                  : "border-helios-line bg-helios-panel text-helios-text hover:border-asu-gold hover:bg-helios-line")
              }
            >
              <span>{e.label}</span>
              {e.id === "who" && myCheckouts > 0 && (
                <span
                  title={`You have ${myCheckouts} file${myCheckouts === 1 ? "" : "s"} checked out`}
                  className={
                    "ml-2 rounded-full px-1.5 py-px font-mono-num text-[10px] leading-4 " +
                    (isActive
                      ? "bg-helios-base/20 text-helios-base"
                      : "bg-asu-gold/20 text-asu-gold")
                  }
                >
                  {myCheckouts}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
