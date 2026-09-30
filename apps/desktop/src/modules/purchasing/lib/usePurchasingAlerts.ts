import { useEffect, useRef, useState } from "react";
import { useSupabaseClientOrNull, useUser } from "@helios/auth";
import { osNotify } from "../../../lib/os-notify";

/** How often the shell checks for new purchasing notifications. */
const POLL_MS = 60_000;

/**
 * Shell-level: checks the signed-in user's purchasing notifications every
 * minute, whatever module is open, and raises a desktop notification for new
 * ones (new request to approve, approved, shipped, delivered to your place).
 * Returns the unread count for the rail badge. Silent when signed out or when
 * the purchasing schema isn't deployed.
 */
export function usePurchasingAlerts(): number {
  const client = useSupabaseClientOrNull();
  const user = useUser();
  const userId = user?.id ?? null;
  const [unread, setUnread] = useState(0);
  const lastSeen = useRef<number | null>(null);

  useEffect(() => {
    setUnread(0);
    lastSeen.current = null;
    if (!client || !userId) return;
    let on = true;
    async function check() {
      let rows: Array<{ id: number; message: string }>;
      try {
        const { data, error } = await client!
          .schema("purchasing")
          .from("notifications")
          .select("id,message,read_at")
          .is("read_at", null)
          .order("id", { ascending: false })
          .limit(20);
        if (!on || error) return;
        rows = (data ?? []) as Array<{ id: number; message: string }>;
      } catch {
        // Offline, schema not deployed, or a stub client in tests: skip this
        // round quietly; the next poll tries again.
        return;
      }
      setUnread(rows.length);
      const newest = rows[0]?.id ?? 0;
      if (lastSeen.current !== null) {
        for (const n of rows.filter((r) => r.id > lastSeen.current!).slice(0, 3).reverse()) {
          void osNotify("purchasing", "Purchasing", n.message);
        }
      }
      lastSeen.current = Math.max(lastSeen.current ?? 0, newest);
    }
    void check();
    const t = window.setInterval(() => void check(), POLL_MS);
    return () => { on = false; window.clearInterval(t); };
  }, [client, userId]);

  return unread;
}
