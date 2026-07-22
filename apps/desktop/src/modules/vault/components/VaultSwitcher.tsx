import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown, IconPlus } from "@tabler/icons-react";
import { useActiveVault } from "../data/useActiveVault";
import { useCreateVault } from "../data/useCreateVault";
import { useCanCreateVault } from "../data/useVaultRole";

/**
 * Vault picker at the top of the NavRail. Mirrors the PM sidebar's project
 * switcher: a "VAULT" label over the active vault name, a chevron, and a
 * bottom divider; the popover lists every vault the user can see, with an
 * admin-only "New vault" form. Closes on outside click and on Escape.
 */
export function VaultSwitcher() {
  const { activeVault, setActiveVaultId, vaults, refetch } = useActiveVault();
  // Gate the New-vault form on the same predicate as the vaults INSERT policy
  // (bridged is_admin_in), not the legacy-only global pdm_is_admin — a
  // capability-only admin can create vaults server-side and must see the form.
  const isAdmin = useCanCreateVault();
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

  const triggerLabel = activeVault?.name ?? (vaults.length === 0 ? "No vaults" : "Choose vault");

  return (
    <div ref={rootRef} className="relative border-b border-helios-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-helios-base/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-asu-gold"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={activeVault ? `Active vault: ${activeVault.name}. Choose vault` : "Choose vault"}
        title={activeVault?.name ?? "Choose vault"}
      >
        <span className="min-w-0">
          <span className="block text-[10px] font-medium uppercase tracking-widest text-helios-dim">Vault</span>
          <span className="mt-0.5 block truncate text-base font-medium text-helios-text">{triggerLabel}</span>
        </span>
        <IconChevronDown
          size={16}
          strokeWidth={1.5}
          className={"shrink-0 text-helios-dim transition-transform " + (open ? "rotate-180" : "")}
        />
      </button>

      {open && (
        <div
          role="listbox"
          // z-50 keeps the picker above the sync popover (z-30) and on the
          // same layer as the other menus/dropdowns (TreeContextMenu z-50);
          // it was z-10 and got painted under those overlays.
          className="absolute inset-x-2 top-full z-50 mt-1 overflow-hidden rounded-md border border-helios-line bg-helios-panel shadow-lg"
        >
          <div className="max-h-64 overflow-y-auto py-1">
            {vaults.length === 0 && (
              <div className="px-3 py-2 text-xs text-helios-dim">No vaults yet</div>
            )}
            {vaults.map((v) => {
              const active = v.id === activeVault?.id;
              return (
                <div key={v.id} className="px-1">
                  <button
                    role="option"
                    aria-selected={active}
                    onClick={() => { setActiveVaultId(v.id); setOpen(false); }}
                    className={
                      "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors " +
                      (active ? "text-helios-text" : "text-helios-dim hover:bg-helios-base hover:text-asu-gold")
                    }
                  >
                    <span className="truncate">{v.name}</span>
                    {active && <IconCheck size={14} strokeWidth={1.5} className="shrink-0 text-asu-gold" />}
                  </button>
                </div>
              );
            })}
          </div>
          {isAdmin && (
            <div className="border-t border-helios-line p-1">
              {creating ? (
                <form onSubmit={handleCreate} className="flex flex-col gap-2 px-1 py-1">
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
                      className="rounded bg-asu-gold px-2 py-1 text-xs font-semibold text-helios-base hover:bg-asu-gold/90 disabled:opacity-50"
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
                    <p className="text-xs text-helios-danger">{createVault.error.message}</p>
                  )}
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-helios-dim hover:bg-helios-base hover:text-asu-gold"
                >
                  <IconPlus size={14} strokeWidth={1.5} />
                  <span>New vault</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
