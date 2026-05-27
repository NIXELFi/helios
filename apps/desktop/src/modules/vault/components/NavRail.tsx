import { VaultSwitcher } from "./VaultSwitcher";

export type VaultScreenId = "browse" | "history" | "who" | "settings";

const ENTRIES: { id: VaultScreenId; label: string }[] = [
  { id: "browse", label: "Browse" },
  { id: "history", label: "History" },
  { id: "who", label: "Who has what" },
  { id: "settings", label: "Settings" },
];

export function NavRail(props: { active: VaultScreenId; onSelect: (id: VaultScreenId) => void }) {
  const { active, onSelect } = props;
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
        {ENTRIES.map((e) => {
          const isActive = active === e.id;
          return (
            <button
              key={e.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelect(e.id)}
              className={
                "rounded-sm border px-3 py-1.5 text-left text-sm transition-colors " +
                (isActive
                  ? "border-asu-gold bg-asu-gold font-semibold text-helios-base"
                  : "border-helios-line bg-helios-panel text-helios-text hover:border-asu-gold")
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
