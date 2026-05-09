import { useEffect, useState } from "react";
import { useSupabaseClient, useUser } from "@helios/auth";

export type MyRole = "admin" | "editor" | "viewer" | null;

export function useMyRole(): MyRole {
  const client = useSupabaseClient();
  const user = useUser();
  const [role, setRole] = useState<MyRole>(null);

  useEffect(() => {
    if (!user) {
      setRole(null);
      return;
    }
    let mounted = true;
    (async () => {
      const { data } = await (client.from("user_roles") as any)
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();
      if (mounted) setRole((data?.role as MyRole) ?? null);
    })();
    return () => {
      mounted = false;
    };
  }, [client, user]);

  return role;
}
