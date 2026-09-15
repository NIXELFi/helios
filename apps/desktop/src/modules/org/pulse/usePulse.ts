import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { OpsDay, OpsHourCell, OpsOverview, OpsPerson } from "./types";

// All four reads are global-admin gated SECURITY DEFINER RPCs in the `pdm`
// schema (the client's default), exposed via the house pdm_admin_ops_* proxies.
// A non-admin gets a 42501 from the server; the panel is hidden for them
// anyway (OrgModule gates the tab on the global role), so an error here is
// surfaced verbatim rather than retried.

export interface PulseData {
  overview: OpsOverview | null;
  series: OpsDay[];
  people: OpsPerson[];
  hourly: OpsHourCell[];
}

export interface PulseState extends PulseData {
  loading: boolean;
  error: string | null;
  refreshedAt: number | null;
  refresh: () => void;
}

const REFRESH_MS = 60_000;
const SERIES_DAYS = 365;

export function usePulse(): PulseState {
  const client = useSupabaseClient();
  const [data, setData] = useState<PulseData>({ overview: null, series: [], people: [], hourly: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // No in-flight dedupe on purpose: StrictMode double-invokes effects in dev,
  // and a guard that skips the second run leaves the first run's result
  // discarded by its own unmount flag (the panel then never leaves the
  // skeleton). Four cheap RPCs twice on mount is fine.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [ov, se, pe, ho] = await Promise.all([
        client.rpc("pdm_admin_ops_overview"),
        client.rpc("pdm_admin_ops_series", { p_days: SERIES_DAYS }),
        client.rpc("pdm_admin_ops_people"),
        client.rpc("pdm_admin_ops_hourly"),
      ]);
      if (!mounted) return;
      const err = ov.error ?? se.error ?? pe.error ?? ho.error;
      if (err) {
        setError(err.message ?? String(err));
        setLoading(false);
        return;
      }
      setError(null);
      // The series RPC returns finalized (past) days only; the overview
      // carries today's live row so it is computed once per refresh.
      const overview = (ov.data as OpsOverview) ?? null;
      const past = ((se.data as OpsDay[]) ?? []).map(normalizeDay);
      const todayRow = overview?.today ? normalizeDay(overview.today) : null;
      const series = todayRow ? [...past.filter((d) => d.day !== todayRow.day), todayRow] : past;
      setData({
        overview,
        series,
        people: (pe.data as OpsPerson[]) ?? [],
        hourly: (ho.data as OpsHourCell[]) ?? [],
      });
      setRefreshedAt(Date.now());
      setLoading(false);
    })().catch((e: unknown) => {
      if (!mounted) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [client, tick]);

  // Keep "online now" and today's numbers live while the tab is open.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  return { ...data, loading, error, refreshedAt, refresh };
}

/** PostgREST returns bigint columns as strings; coerce the numeric fields so
 *  the charts never do string arithmetic. */
function normalizeDay(d: OpsDay): OpsDay {
  return {
    ...d,
    users_total: Number(d.users_total),
    users_new: Number(d.users_new),
    active_users: Number(d.active_users),
    vault_actions: Number(d.vault_actions),
    pm_actions: Number(d.pm_actions),
    games_plays: Number(d.games_plays),
    notify_sent: Number(d.notify_sent),
    notify_failed: Number(d.notify_failed),
    files_total: Number(d.files_total),
    versions_total: Number(d.versions_total),
    content_bytes: Number(d.content_bytes),
    storage_bytes: d.storage_bytes == null ? null : Number(d.storage_bytes),
    db_bytes: d.db_bytes == null ? null : Number(d.db_bytes),
    vault_files: d.vault_files ?? {},
  };
}
