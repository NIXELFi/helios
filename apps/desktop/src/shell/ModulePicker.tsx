export type ModuleId = "logs" | "vault";

export function ModulePicker(props: {
  active: ModuleId;
  onSelect: (id: ModuleId) => void;
}) {
  const { active, onSelect } = props;
  return (
    <nav className="flex w-44 flex-col gap-1 border-r border-zinc-800 bg-zinc-950 p-2">
      <button
        type="button"
        aria-current={active === "logs" ? "page" : undefined}
        onClick={() => onSelect("logs")}
        className={
          "rounded px-3 py-2 text-left text-sm " +
          (active === "logs"
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-900")
        }
      >
        Logs
      </button>
      <button
        type="button"
        aria-current={active === "vault" ? "page" : undefined}
        onClick={() => onSelect("vault")}
        className={
          "flex items-center justify-between rounded px-3 py-2 text-left text-sm " +
          (active === "vault"
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-900")
        }
      >
        <span>Vault</span>
        <span className="ml-2 rounded bg-yellow-500 px-1.5 py-0.5 text-xs font-bold text-zinc-900">
          NEW
        </span>
      </button>
    </nav>
  );
}
