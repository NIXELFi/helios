export type ModuleId = "logs" | "vault" | "cfd";

export function ModulePicker(props: {
  active: ModuleId;
  onSelect: (id: ModuleId) => void;
}) {
  const { active, onSelect } = props;
  return (
    // Top padding clears the macOS traffic-lights overlay (window
    // `titleBarStyle: "Overlay"` puts them at ~(14, 14), spanning roughly
    // 14..84 × 14..28). Harmless on Windows/Linux — the rail just starts a
    // touch lower than it used to.
    <nav className="flex w-44 flex-col gap-1 border-r border-helios-line bg-helios-base p-2 pt-12">
      <button
        type="button"
        aria-current={active === "logs" ? "page" : undefined}
        onClick={() => onSelect("logs")}
        className={
          "rounded px-3 py-2 text-left text-sm " +
          (active === "logs"
            ? "bg-helios-line text-helios-text"
            : "text-helios-dim hover:bg-helios-panel")
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
            ? "bg-helios-line text-helios-text"
            : "text-helios-dim hover:bg-helios-panel")
        }
      >
        <span>Vault</span>
        <span className="ml-2 rounded bg-asu-gold px-1.5 py-0.5 text-xs font-bold text-helios-base">
          NEW
        </span>
      </button>
      <button
        type="button"
        aria-current={active === "cfd" ? "page" : undefined}
        onClick={() => onSelect("cfd")}
        className={
          "flex items-center justify-between rounded px-3 py-2 text-left text-sm " +
          (active === "cfd"
            ? "bg-helios-line text-helios-text"
            : "text-helios-dim hover:bg-helios-panel")
        }
      >
        <span>CFD</span>
        <span className="ml-2 rounded bg-asu-gold px-1.5 py-0.5 text-xs font-bold text-helios-base">
          NEW
        </span>
      </button>
    </nav>
  );
}
