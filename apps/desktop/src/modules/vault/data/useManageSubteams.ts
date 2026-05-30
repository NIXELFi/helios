import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { friendlyPgError } from "./pg-errors";

type Result = { ok: boolean; error: Error | null };

/** Create / delete subteams via the admin-gated RPCs. Authorization (admin or
 *  owner) is enforced server-side; non-admins get an error.
 *
 *  Create and remove track loading independently (`creating` / `removing`) so
 *  a pending remove doesn't disable the Add form, and vice versa. Each call
 *  returns its result+error directly rather than relying on the caller reading
 *  a stale captured `.error` after the await. */
export function useManageSubteams() {
  const client = useSupabaseClient();
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Guard post-await setState against unmount.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const create = useCallback(
    async (name: string): Promise<Result> => {
      if (mounted.current) {
        setCreating(true);
        setError(null);
      }
      const { error: err } = await client.rpc("pdm_create_subteam", { p_name: name });
      if (err) {
        const e = new Error(friendlyPgError(err, "role").message);
        if (mounted.current) {
          setError(e);
          setCreating(false);
        }
        return { ok: false, error: e };
      }
      if (mounted.current) setCreating(false);
      return { ok: true, error: null };
    },
    [client],
  );

  const remove = useCallback(
    async (id: string): Promise<Result> => {
      if (mounted.current) {
        setRemoving(true);
        setError(null);
      }
      const { error: err } = await client.rpc("pdm_delete_subteam", { p_id: id });
      if (err) {
        const e = new Error(friendlyPgError(err, "role").message);
        if (mounted.current) {
          setError(e);
          setRemoving(false);
        }
        return { ok: false, error: e };
      }
      if (mounted.current) setRemoving(false);
      return { ok: true, error: null };
    },
    [client],
  );

  return { create, remove, creating, removing, error };
}
