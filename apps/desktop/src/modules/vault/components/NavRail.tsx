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
    <nav className="flex w-40 flex-col gap-1 border-r border-helios-line bg-helios-base p-2">
      {ENTRIES.map((e) => (
        <button
          key={e.id}
          type="button"
          aria-current={active === e.id ? "page" : undefined}
          onClick={() => onSelect(e.id)}
          className={
            "rounded px-3 py-2 text-left text-sm " +
            (active === e.id ? "bg-helios-line text-helios-text" : "text-helios-dim hover:bg-helios-panel")
          }
        >
          {e.label}
        </button>
      ))}
    </nav>
  );
}
