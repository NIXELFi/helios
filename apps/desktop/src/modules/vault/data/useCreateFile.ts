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
      // (you made it, you hold the lock until you check it in). Best-effort —
      // the file already exists, so a failed auto-checkout just means the user
      // can check it out manually; we don't fail the create over it.
      if (user) {
        const { error: lockErr } = await (client.from("locks") as any)
          .insert({ file_id: file.id, user_id: user.id });
        if (lockErr) {
          console.warn(`[vault] auto-checkout of new file ${file.id} failed:`, lockErr.message);
        } else {
          notifyLockChange();
        }
      }
      setLoading(false);
      return file;
    },
    [client, user],
  );

  return { run, loading, error };
}
