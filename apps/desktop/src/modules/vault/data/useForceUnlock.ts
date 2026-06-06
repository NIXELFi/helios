import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId, LockId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";
import { setLockOverlay, clearLockOverlay } from "./lock-overlay";

export function useForceUnlock() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // `file_id` is needed (alongside the lock_id the RPC takes) so the optimistic
  // overlay — keyed by file — can clear the pill this frame.
  const run = useCallback(
    async (lock_id: LockId, file_id: FileId, reason: string): Promise<boolean> => {
      setLoading(true);
      setError(null);
      setLockOverlay(file_id, { kind: "remove" }); // optimistic clear
      const { error: err } = await client.rpc("pdm_force_unlock", {
        p_lock_id: lock_id,
        p_reason: reason,
      });
      setLoading(false);
      if (err) {
        clearLockOverlay(file_id); // restore the pill — the unlock failed
        setError(new Error(friendlyPgError(err, "lock").message));
        return false;
      }
      // Broadcast so every mounted useLocks() refetches immediately rather
      // than waiting on the realtime channel.
      notifyLockChange();
      return true;
    },
    [client],
  );

  return { run, loading, error };
}
