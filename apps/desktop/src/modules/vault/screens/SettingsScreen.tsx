import { useState } from "react";
import { useUser, useSupabaseClient } from "@helios/auth";
import { useActiveVault } from "../data/useActiveVault";
import { useMyRole } from "../data/useMyRole";
import { useVaultFolder, sanitizeVaultName } from "../data/useVaultFolder";
import { useDownloadMode } from "../data/useDownloadMode";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";

export function SettingsScreen() {
  const user = useUser();
  const role = useMyRole();
  const client = useSupabaseClient();
  const { activeVault, activeVaultId, vaults } = useActiveVault();
  // Folder is now a single shared root; per-vault paths are derived as
  // `<root>/<sanitize(vault.name)>`. The active vault's effective path is
  // returned as `path` for the auto-sync / download-target convenience.
  const { root, setRoot, clear } = useVaultFolder({ vaultName: activeVault?.name ?? null });
  const { mode, setMode } = useDownloadMode(activeVaultId);
  const [pickError, setPickError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handlePickFolder() {
    setPickError(null);
    try {
      const result = await openDirDialog({ directory: true, multiple: false });
      if (typeof result === "string") setRoot(result);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSignOut() {
    if (signingOut) return; // guard against a double-click re-entrancy
    setSigningOut(true);
    setSignOutError(null);
    try {
      const { error } = await client.auth.signOut();
      if (error) setSignOutError(error.message);
    } catch (e) {
      // signOut can reject (network down) — surface it instead of leaving an
      // unhandled rejection.
      setSignOutError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningOut(false);
    }
  }

  const vaultLabel = activeVault?.name ?? "(no vault selected)";

  return (
    <div className="h-full overflow-auto bg-helios-panel p-6 text-helios-text">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>

      <section className="mb-8 max-w-xl space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-helios-dim">Account</h2>
        <div className="rounded border border-helios-line bg-helios-base p-4 text-sm">
          <div className="mb-2">
            <span className="text-helios-dim">Signed in as: </span>
            <span className="font-mono-num text-helios-text">{user?.email ?? "(not signed in)"}</span>
          </div>
          <div className="mb-3">
            <span className="text-helios-dim">Role: </span>
            <span className="text-helios-text">{role ?? "(no role assigned)"}</span>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="rounded border border-helios-line px-3 py-1 text-xs text-helios-text hover:bg-helios-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          {signOutError && <p className="mt-2 text-xs text-[#EF5350]" role="alert">{signOutError}</p>}
        </div>
      </section>

      <section className="mb-8 max-w-xl space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-helios-dim">Helios folder</h2>
        <p className="text-xs text-helios-dim">
          Pick one folder on this machine — Helios will create a subfolder named after
          each vault inside it (e.g. <code className="font-mono-num">SDM26/</code>,{" "}
          <code className="font-mono-num">SDM27/</code>) and sync each vault into its own
          subfolder. The vaults stay isolated; you keep one tidy parent directory.
        </p>
        <div className="rounded border border-helios-line bg-helios-base p-4 text-sm">
          {root ? (
            <>
              <div className="mb-2 break-all font-mono-num text-xs text-helios-text">{root}</div>
              {vaults.length > 0 && (
                <div className="mb-3 space-y-1 rounded border border-helios-line bg-helios-panel/40 p-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-helios-dim">
                    Each vault syncs into
                  </div>
                  {vaults.map((v) => (
                    <div key={v.id} className="flex items-baseline gap-2 text-[11px]">
                      <span className="w-16 shrink-0 truncate text-helios-text">{v.name}</span>
                      <span className="truncate font-mono-num text-helios-dim">
                        {root.replace(/\/+$/, "")}/{sanitizeVaultName(v.name)}/
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handlePickFolder}
                  className="rounded border border-helios-line px-3 py-1 text-xs text-helios-text hover:bg-helios-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
                >
                  Change folder
                </button>
                <button
                  type="button"
                  onClick={() => clear()}
                  className="rounded border border-helios-line px-3 py-1 text-xs text-helios-dim hover:bg-helios-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
                >
                  Clear
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={handlePickFolder}
              className="rounded bg-asu-gold px-3 py-1.5 text-xs text-helios-base hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              Pick Helios folder
            </button>
          )}
          {pickError && <p className="mt-2 text-xs text-[#EF5350]">{pickError}</p>}
        </div>
      </section>

      <section className="max-w-xl space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-helios-dim">
          Download mode for {vaultLabel}
        </h2>
        <p className="text-xs text-helios-dim">
          <span className="text-helios-text">Auto</span> mirrors every file in this vault to your
          local folder in the background. <span className="text-helios-text">Manual</span> shows
          the file list but only downloads bytes when you click Download on a row — useful when
          you can't open the file types in this vault on your machine (e.g. SolidWorks parts on a Mac).
        </p>
        <div className="rounded border border-helios-line bg-helios-base p-4 text-sm">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("auto")}
              disabled={!activeVaultId}
              aria-pressed={mode === "auto"}
              className={
                "rounded px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50 " +
                (mode === "auto"
                  ? "bg-asu-gold text-helios-base"
                  : "border border-helios-line text-helios-dim hover:bg-helios-line hover:text-helios-text")
              }
            >
              Auto — download everything
            </button>
            <button
              type="button"
              onClick={() => setMode("manual")}
              disabled={!activeVaultId}
              aria-pressed={mode === "manual"}
              className={
                "rounded px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50 " +
                (mode === "manual"
                  ? "bg-asu-gold text-helios-base"
                  : "border border-helios-line text-helios-dim hover:bg-helios-line hover:text-helios-text")
              }
            >
              Manual — download on click
            </button>
          </div>
          {!activeVaultId && (
            <p className="mt-2 text-xs text-helios-dim">Select a vault to change its download mode.</p>
          )}
        </div>
      </section>
    </div>
  );
}
