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
    <nav className="flex w-40 flex-col gap-1 border-r border-zinc-800 bg-zinc-950 p-2">
      {ENTRIES.map((e) => (
        <button
          key={e.id}
          type="button"
          aria-current={active === e.id ? "page" : undefined}
          onClick={() => onSelect(e.id)}
          className={
            "rounded px-3 py-2 text-left text-sm " +
            (active === e.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900")
          }
        >
          {e.label}
        </button>
      ))}
    </nav>
  );
}
