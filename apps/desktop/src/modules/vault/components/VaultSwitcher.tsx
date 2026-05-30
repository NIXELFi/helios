import { useEffect, useRef, useState } from "react";
import { useActiveVault } from "../data/useActiveVault";
import { useCreateVault } from "../data/useCreateVault";
import { useIsAdmin } from "../data/useIsAdmin";

/**
 * Vault picker that lives at the top of the NavRail. Trigger shows the active
 * vault name; the popover lists every vault the user can see, with an admin-
 * only "New vault" form at the bottom. Closes on outside click and on Escape.
 */
export function VaultSwitcher() {
  const { activeVault, setActiveVaultId, vaults, refetch } = useActiveVault();
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const createVault = useCreateVault();
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click outside / Escape closes the popover. The popover is a sibling of
  // the trigger inside `rootRef`, so anything outside that div closes us.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const created = await createVault.run(trimmed);
    if (created) {
      setName("");
      setCreating(false);
      refetch();
      setActiveVaultId(created.id);
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-helios-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={activeVault ? `Active vault: ${activeVault.name}. Choose vault` : "Choose vault"}
        title={activeVault?.name ?? "Choose vault"}
      >
        <span className="truncate text-helios-text">
          {activeVault?.name ?? (vaults.length === 0 ? "No vaults" : "Choose vault")}
        </span>
        <span className="ml-2 text-helios-dim">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div
          role="listbox"
          // z-50 keeps the picker above the sync popover (z-30) and on the
          // same layer as the other menus/dropdowns (TreeContextMenu z-50);
          // it was z-10 and got painted under those overlays.
          className="absolute left-0 right-0 top-full z-50 mt-1 rounded border border-helios-line bg-helios-panel py-1 shadow-lg"
        >
          {vaults.length === 0 && (
            <div className="px-3 py-2 text-xs text-helios-dim">No vaults yet</div>
          )}
          {vaults.map((v) => {
            const active = v.id === activeVault?.id;
            return (
              <button
                key={v.id}
                role="option"
                aria-selected={active}
                onClick={() => { setActiveVaultId(v.id); setOpen(false); }}
                className={
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm " +
                  (active ? "text-helios-text" : "text-helios-dim hover:bg-helios-line hover:text-helios-text")
                }
              >
                <span className="w-3 text-asu-gold">{active ? "✓" : ""}</span>
                <span className="truncate">{v.name}</span>
              </button>
            );
          })}
          {isAdmin && (
            <>
              <div className="my-1 border-t border-helios-line" />
              {creating ? (
                <form onSubmit={handleCreate} className="flex flex-col gap-2 px-2 py-2">
                  <input
                    autoFocus
                    type="text"
                    value={name}
                    placeholder="Vault name"
                    onChange={(e) => setName(e.target.value)}
                    className="rounded border border-helios-line bg-helios-base px-2 py-1 text-xs text-helios-text placeholder-helios-dim focus:outline-none focus:ring-1 focus:ring-asu-gold"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={createVault.loading || !name.trim()}
                      className="rounded bg-asu-gold px-2 py-1 text-xs text-white hover:bg-asu-gold/90 disabled:opacity-50"
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      onClick={() => { setCreating(false); setName(""); }}
                      className="rounded px-2 py-1 text-xs text-helios-dim hover:text-helios-text"
                    >
                      Cancel
                    </button>
                  </div>
                  {createVault.error && (
                    <p className="text-xs text-[#EF5350]">{createVault.error.message}</p>
                  )}
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-helios-dim hover:bg-helios-line hover:text-helios-text"
                >
                  <span className="w-3">+</span>
                  <span>New vault</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
