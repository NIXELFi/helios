import { useState } from "react";
import { useUser, useSupabaseClient } from "@helios/auth";
import { useMyRole } from "../data/useMyRole";
import { useVaultFolder } from "../data/useVaultFolder";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";

export function SettingsScreen() {
  const user = useUser();
  const role = useMyRole();
  const client = useSupabaseClient();
  const { path: vaultFolder, setPath, clear } = useVaultFolder();
  const [pickError, setPickError] = useState<string | null>(null);

  async function handlePickFolder() {
    setPickError(null);
    try {
      const result = await openDirDialog({ directory: true, multiple: false });
      if (typeof result === "string") setPath(result);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSignOut() {
    await client.auth.signOut();
  }

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
            onClick={handleSignOut}
            className="rounded border border-helios-line px-3 py-1 text-xs text-helios-text hover:bg-helios-line"
          >
            Sign out
          </button>
        </div>
      </section>

      <section className="max-w-xl space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-helios-dim">Local vault folder</h2>
        <p className="text-xs text-helios-dim">
          Helios syncs vault files into and out of this folder. Pick a directory you'll use as your
          working copy. Defaults will be applied automatically once chosen.
        </p>
        <div className="rounded border border-helios-line bg-helios-base p-4 text-sm">
          {vaultFolder ? (
            <>
              <div className="mb-3 break-all font-mono-num text-xs text-helios-text">{vaultFolder}</div>
              <div className="flex gap-2">
                <button
                  onClick={handlePickFolder}
                  className="rounded border border-helios-line px-3 py-1 text-xs text-helios-text hover:bg-helios-line"
                >
                  Change folder
                </button>
                <button
                  onClick={() => clear()}
                  className="rounded border border-helios-line px-3 py-1 text-xs text-helios-dim hover:bg-helios-line"
                >
                  Clear
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={handlePickFolder}
              className="rounded bg-asu-gold px-3 py-1.5 text-xs text-white hover:bg-asu-gold"
            >
              Pick vault folder
            </button>
          )}
          {pickError && <p className="mt-2 text-xs text-[#EF5350]">{pickError}</p>}
        </div>
      </section>
    </div>
  );
}
