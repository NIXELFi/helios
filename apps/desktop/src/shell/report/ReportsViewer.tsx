import { useEffect, useRef, useState } from "react";
import { useHeliosAuth } from "../../auth/AuthShell";
import { useReports } from "./useReports";
import { REPORT_BUCKET } from "./useSubmitReport";
import type { ReportRow } from "./types";

const STATUSES: ReportRow["status"][] = ["new", "triaged", "fixed"];

export function ReportsViewer({ onClose }: { onClose: () => void }) {
  const { reports, loading, error, setStatus } = useReports();
  const [statusFilter, setStatusFilter] = useState<"all" | ReportRow["status"]>("all");
  const [kindFilter, setKindFilter] = useState<"all" | "bug" | "feature">("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = reports.filter(
    (r) => (statusFilter === "all" || r.status === statusFilter) && (kindFilter === "all" || r.kind === kindFilter),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Submitted reports"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[80vh] w-[44rem] max-w-[94vw] flex-col rounded-sm border border-helios-line bg-helios-panel text-helios-text shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-helios-line px-4 py-2">
          <h3 className="text-sm font-semibold">Reports {loading ? "…" : `(${rows.length})`}</h3>
          <div className="flex items-center gap-2 text-xs">
            <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="rounded-sm border border-helios-line bg-helios-base px-1.5 py-0.5 outline-none focus:border-asu-gold">
              <option value="all">all statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select aria-label="Filter by type" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
              className="rounded-sm border border-helios-line bg-helios-base px-1.5 py-0.5 outline-none focus:border-asu-gold">
              <option value="all">all types</option>
              <option value="bug">bug</option>
              <option value="feature">feature</option>
            </select>
            <button type="button" onClick={onClose} className="rounded-sm px-2 py-0.5 text-helios-dim hover:bg-helios-line">Close</button>
          </div>
        </div>

        {error && <div className="border-b border-[#EF5350] bg-[#EF5350]/10 px-4 py-1 text-xs text-[#EF5350]">{error}</div>}

        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 && !loading && (
            <div className="px-4 py-8 text-center text-xs text-helios-dim">No reports.</div>
          )}
          {rows.map((r) => (
            <ReportRowView
              key={r.id}
              row={r}
              expanded={expanded === r.id}
              onToggle={() => setExpanded((e) => (e === r.id ? null : r.id))}
              onStatus={(s) => void setStatus(r.id, s)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReportRowView({
  row, expanded, onToggle, onStatus,
}: {
  row: ReportRow;
  expanded: boolean;
  onToggle: () => void;
  onStatus: (s: ReportRow["status"]) => void;
}) {
  const { client } = useHeliosAuth();
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const fetched = useRef(false);

  useEffect(() => {
    if (!expanded || fetched.current || !row.screenshot_path || !client) return;
    fetched.current = true;
    (client as any).storage
      .from(REPORT_BUCKET)
      .createSignedUrl(row.screenshot_path, 300)
      .then((res: { data?: { signedUrl?: string } }) => setShotUrl(res?.data?.signedUrl ?? null))
      .catch(() => setShotUrl(null));
  }, [expanded, row.screenshot_path, client]);

  return (
    <div className="border-b border-helios-line/60">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs hover:bg-helios-base">
        <span className={"rounded-sm px-1.5 py-0.5 text-[10px] font-bold uppercase " + (row.kind === "bug" ? "bg-[#EF5350]/20 text-[#EF5350]" : "bg-asu-gold/20 text-asu-gold")}>
          {row.kind}
        </span>
        <span className="min-w-0 flex-1 truncate text-helios-text">{row.title}</span>
        <span className="text-helios-dim">{row.module ?? "—"}</span>
        <span className="text-helios-dim">{new Date(row.created_at).toLocaleDateString()}</span>
        <span aria-hidden className="text-helios-dim">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="space-y-2 px-4 pb-3 text-[11px] text-helios-dim">
          <div className="flex items-center gap-2">
            <span>severity: {row.severity}</span>
            <span>· v{row.app_version} · {row.os}</span>
            <label className="ml-auto flex items-center gap-1">
              status:
              <select value={row.status} onChange={(e) => onStatus(e.target.value as ReportRow["status"])}
                className="rounded-sm border border-helios-line bg-helios-base px-1.5 py-0.5 outline-none focus:border-asu-gold">
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          {row.what_doing && <div><span className="text-helios-text">What they were doing:</span> {row.what_doing}</div>}
          {row.details && <div><span className="text-helios-text">Details:</span> {row.details}</div>}
          {row.last_error && <div className="text-red-300">last error: {row.last_error.message}</div>}
          {row.breadcrumbs.length > 0 && (
            <div>
              <span className="text-helios-text">Breadcrumbs:</span>
              <ul className="mt-0.5 max-h-32 overflow-y-auto font-mono-num">
                {row.breadcrumbs.map((b, i) => (
                  <li key={i}>{b.t.slice(11, 19)} {b.category}: {b.message}</li>
                ))}
              </ul>
            </div>
          )}
          {row.screenshot_path && (
            shotUrl
              ? <a href={shotUrl} target="_blank" rel="noreferrer"><img src={shotUrl} alt="Report screenshot" className="max-h-48 rounded-sm border border-helios-line" /></a>
              : <div className="italic">loading screenshot…</div>
          )}
        </div>
      )}
    </div>
  );
}
