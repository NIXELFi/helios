import { useCallback, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import type { FolderId, VaultFile, VaultId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";

export function useCreateFile() {
  const client = useSupabaseClient();
  const user = useUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (
      vault_id: VaultId,
      folder_id: FolderId | null,
      name: string,
    ): Promise<VaultFile | null> => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await (client.from("files") as any)
        .insert({ vault_id, folder_id, name })
        .select()
        .single();
      if (err) {
        setLoading(false);
        setError(new Error(friendlyPgError(err, "file").message));
        return null;
      }
      const file = data as VaultFile;
      // Real-vault default: a newly created file is checked out to its creator
      // (you made it, you hold the lock until you check it in).
      if (user) {
        const { error: lockErr } = await (client.from("locks") as any)
          .insert({ file_id: file.id, user_id: user.id });
        if (lockErr) {
          // The create and the lock are two round-trips (no atomic create-locked
          // RPC yet — tracked for the backend pass). If the lock failed, the file
          // row exists but is UNLOCKED, so it would surface to every vault member
          // as an empty, un-owned draft nobody can complete. Don't report success:
          // best-effort remove the orphan row (succeeds for callers who can delete
          // it; a harmless no-op otherwise) and surface the failure so the user can
          // retry cleanly instead of being handed a file they don't actually hold.
          console.warn(`[vault] auto-checkout of new file ${file.id} failed:`, lockErr.message);
          await (client.from("files") as any).delete().eq("id", file.id);
          setLoading(false);
          setError(new Error("Couldn't check out the new file — please try again."));
          return null;
        }
        notifyLockChange();
      }
      setLoading(false);
      return file;
    },
    [client, user],
  );

  return { run, loading, error };
}
