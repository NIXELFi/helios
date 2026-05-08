import { useUser, useSupabaseClient } from "@helios/auth";

export function VaultHome() {
  const user = useUser();
  const client = useSupabaseClient();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-900 text-zinc-100">
      <h1 className="text-2xl font-semibold">Helios Vault</h1>
      <p className="text-sm text-zinc-400">
        Signed in as <span className="font-mono">{user?.email}</span>
      </p>
      <p className="max-w-md text-center text-sm text-zinc-500">
        Browse, history, and admin views are coming soon (Plan 4).
      </p>
      <button
        onClick={() => void client.auth.signOut()}
        className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
      >
        Sign out
      </button>
    </div>
  );
}
