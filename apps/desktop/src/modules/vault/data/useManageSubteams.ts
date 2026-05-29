import { useCallback, useState } from "react";
import { useSupabaseClient } from "@helios/auth";

/** Create / delete subteams via the admin-gated RPCs. Authorization (admin or
 *  owner) is enforced server-side; non-admins get an error. */
export function useManageSubteams() {
  const client = useSupabaseClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const create = useCallback(
    async (name: string): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const { error: err } = await client.rpc("pdm_create_subteam", { p_name: name });
      setLoading(false);
      if (err) {
        setError(new Error(err.message ?? String(err)));
        return false;
      }
      return true;
    },
    [client],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setLoading(true);
      setError(null);
      const { error: err } = await client.rpc("pdm_delete_subteam", { p_id: id });
      setLoading(false);
      if (err) {
        setError(new Error(err.message ?? String(err)));
        return false;
      }
      return true;
    },
    [client],
  );

  return { create, remove, loading, error };
}
