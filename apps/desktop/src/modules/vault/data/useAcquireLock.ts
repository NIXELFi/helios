import { useCallback, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";
import type { FileId, Lock } from "./types";
import { friendlyPgError } from "./pg-errors";
import { notifyLockChange } from "./lock-events";

export function useAcquireLock() {
  const client = useSupabaseClient();
  const user = useUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<Lock | null>(null);

  const run = useCallback(
    async (file_id: FileId): Promise<Lock | null> => {
      if (!user) {
        setError(new Error("Your session has expired — please sign in again."));
        // Clear any result from a prior successful acquire so hook state
        // reflects this (failed) attempt rather than a stale lock.
        setResult(null);
        return null;
      }
      setLoading(true);
      setError(null);
      const { data, error: err } = await (client.from("locks") as any)
        .insert({ file_id, user_id: user.id })
        .select()
        .single();
      setLoading(false);
      if (err) {
        // 23505 from the locks table is "this file is already checked out
        // (by someone, possibly this user holding a stale lock)" — friendly
        // mapping gives a readable string instead of a raw FK / unique
        // constraint violation.
        setError(new Error(friendlyPgError(err, "lock").message));
        return null;
      }
      setResult(data);
      // Broadcast so every mounted useLocks() refetches immediately
      // rather than waiting on the realtime channel.
      notifyLockChange();
      return data;
    },
    [client, user],
  );

  return { run, loading, error, result };
}
