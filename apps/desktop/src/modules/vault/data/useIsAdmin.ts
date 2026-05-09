import { useEffect, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";

export function useIsAdmin(): boolean {
  const client = useSupabaseClient();
  const user = useUser();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    let mounted = true;
    (async () => {
      const { data } = await client.rpc("pdm_is_admin");
      if (mounted) setIsAdmin(Boolean(data));
    })();
    return () => {
      mounted = false;
    };
  }, [client, user]);

  return isAdmin;
}
