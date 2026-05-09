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
    <div className="h-full overflow-auto bg-zinc-900 p-6 text-zinc-200">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>

      <section className="mb-8 max-w-xl space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-zinc-500">Account</h2>
        <div className="rounded border border-zinc-800 bg-zinc-950 p-4 text-sm">
          <div className="mb-2">
            <span className="text-zinc-500">Signed in as: </span>
            <span className="font-mono text-zinc-100">{user?.email ?? "(not signed in)"}</span>
          </div>
          <div className="mb-3">
            <span className="text-zinc-500">Role: </span>
            <span className="text-zinc-100">{role ?? "(no role assigned)"}</span>
          </div>
          <button
            onClick={handleSignOut}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            Sign out
          </button>
        </div>
      </section>

      <section className="max-w-xl space-y-3">
        <h2 className="text-sm uppercase tracking-wider text-zinc-500">Local vault folder</h2>
        <p className="text-xs text-zinc-500">
          Helios syncs vault files into and out of this folder. Pick a directory you'll use as your
          working copy. Defaults will be applied automatically once chosen.
        </p>
        <div className="rounded border border-zinc-800 bg-zinc-950 p-4 text-sm">
          {vaultFolder ? (
            <>
              <div className="mb-3 break-all font-mono text-xs text-zinc-300">{vaultFolder}</div>
              <div className="flex gap-2">
                <button
                  onClick={handlePickFolder}
                  className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                >
                  Change folder
                </button>
                <button
                  onClick={() => clear()}
                  className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                >
                  Clear
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={handlePickFolder}
              className="rounded bg-blue-700 px-3 py-1.5 text-xs text-white hover:bg-blue-600"
            >
              Pick vault folder
            </button>
          )}
          {pickError && <p className="mt-2 text-xs text-red-400">{pickError}</p>}
        </div>
      </section>
    </div>
  );
}
