import { useCallback, useEffect, useState } from "react";
import { useHeliosAuth } from "../../auth/AuthShell";
import type { ReportRow } from "./types";

/** Admin/owner list of submitted reports + status triage. Reads from the
 *  `support` schema via the per-call override (the client defaults to `pdm`).
 *  RLS is the real gate; non-admins simply get no rows. */
export function useReports() {
  const { client } = useHeliosAuth();
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await (client as any)
      .schema("support")
      .from("reports")
      .select("*")
      .order("created_at", { ascending: false });
    if (err) setError(err.message);
    else setReports((data ?? []) as ReportRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const setStatus = useCallback(
    async (id: string, status: ReportRow["status"]): Promise<boolean> => {
      if (!client) return false;
      const { error: err } = await (client as any)
        .schema("support")
        .from("reports")
        .update({ status })
        .eq("id", id);
      if (err) {
        setError(err.message);
        return false;
      }
      setReports((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
      return true;
    },
    [client],
  );

  return { reports, loading, error, refetch, setStatus };
}
