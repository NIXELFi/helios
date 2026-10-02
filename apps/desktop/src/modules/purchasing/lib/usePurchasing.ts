import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import {
  fetchApprovals, fetchBudgets, fetchCaps, fetchCarSubteams, fetchItems, fetchNotifications, fetchProjects, fetchSubteams,
  type Approval, type BudgetRow, type Caps, type CarSubteam, type Item, type Notification, type Project, type Subteam,
} from "./api";
import type { VendorRule } from "../finance/importers";

/** Everything the module shows, loaded together and refreshed after each write. */
export interface PurchasingData {
  items: Item[];
  approvals: Approval[];
  subteams: Subteam[];
  projects: Project[];
  budgets: BudgetRow[];
  notifications: Notification[];
  caps: Caps | null;
  vendors: VendorRule[];   // the vendor list, for fixing spellings on import
  carSubteams: CarSubteam[];   // which subteams each car has (Admin > Org Structure)
}

const EMPTY: PurchasingData = {
  items: [], approvals: [], subteams: [], projects: [], budgets: [], notifications: [], caps: null, vendors: [], carSubteams: [],
};

/** How often to refresh while the module is on screen (other people's edits). */
const REFRESH_MS = 60_000;

export function usePurchasing(client: SupabaseClient | null, active: boolean) {
  const [data, setData] = useState<PurchasingData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!client) return;
    try {
      const [items, approvals, subteams, projects, budgets, notifications, caps, vendors, carSubteams] = await Promise.all([
        fetchItems(client), fetchApprovals(client), fetchSubteams(client), fetchProjects(client),
        fetchBudgets(client), fetchNotifications(client), fetchCaps(client),
        // optional: an older database without the finance schema just has no vendor list
        client.schema("finance").from("vendors").select("*").then((r) => (r.data ?? []) as VendorRule[], () => []),
        // optional: without the org structure map every car shows every subteam
        fetchCarSubteams(client).catch(() => [] as CarSubteam[]),
      ]);
      setData({ items, approvals, subteams, projects, budgets, notifications, caps, vendors, carSubteams });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!active) return;
    void reload();
    const t = window.setInterval(() => void reload(), REFRESH_MS);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [active, reload]);

  return { data, loading, error, reload };
}
