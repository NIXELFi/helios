import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { FileId } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";
import { setLockOverlay, clearLockOverlay } from "./lock-overlay";

export function useReleaseLock() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (file_id: FileId): Promise<boolean> => {
      setLoading(true);
      setError(null);
      // Optimistic: clear the lock pill this frame. This also shortens the
      // stale-"locked by me" window that lock-events.ts exists to guard against
      // (auto-sync clobber) — safer than today, not just faster.
      setLockOverlay(file_id, { kind: "remove" });
      const { error: err } = await client.rpc("pdm_cancel_checkout", {
        p_file_id: file_id,
      });
      setLoading(false);
      if (err) {
        clearLockOverlay(file_id); // restore the pill — the cancel failed
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
