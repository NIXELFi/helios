import { useEffect, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";

/** True when the signed-in user holds the `owner` role. Drives the admin
 *  panel's ability to grant/revoke the admin role (owner-only). Mirrors
 *  useIsAdmin's RPC pattern. */
export function useIsOwner(): boolean {
  const client = useSupabaseClient();
  const user = useUser();
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsOwner(false);
      return;
    }
    let mounted = true;
    (async () => {
      const { data } = await client.rpc("pdm_is_owner");
      if (mounted) setIsOwner(Boolean(data));
    })();
    return () => {
      mounted = false;
    };
  }, [client, user]);

  return isOwner;
}
