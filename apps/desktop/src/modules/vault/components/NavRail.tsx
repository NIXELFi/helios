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
}) {
  const { active, onSelect, showAdmin } = props;
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
                "rounded-sm border px-3 py-1.5 text-left text-sm transition-colors " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
                (isActive
                  ? "border-asu-gold bg-asu-gold font-semibold text-helios-base hover:bg-asu-gold/90"
                  : "border-helios-line bg-helios-panel text-helios-text hover:border-asu-gold hover:bg-helios-line")
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
