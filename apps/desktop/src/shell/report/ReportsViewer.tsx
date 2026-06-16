import { useEffect, useRef, useState } from "react";
import { useHeliosAuth } from "../../auth/AuthShell";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useReports } from "./useReports";
import { REPORT_BUCKET } from "./useSubmitReport";
import type { ReportRow } from "./types";

const STATUSES: ReportRow["status"][] = ["new", "triaged", "fixed"];

// --- Color coding -----------------------------------------------------------
// Classes are written as full literals so Tailwind's content scan picks them up.
const KIND_STYLE: Record<ReportRow["kind"], { bar: string; badge: string; label: string }> = {
  bug: { bar: "bg-helios-danger", badge: "bg-helios-danger/15 text-helios-danger", label: "BUG" },
  feature: { bar: "bg-asu-gold", badge: "bg-asu-gold/15 text-asu-gold", label: "FEATURE" },
};

const SEVERITY_STYLE: Record<string, string> = {
  blocker: "bg-helios-danger/15 text-helios-danger",
  annoying: "bg-helios-warn/15 text-helios-warn",
  minor: "bg-helios-line/70 text-helios-dim",
  important: "bg-asu-gold/15 text-asu-gold",
  "nice-to-have": "bg-helios-info/15 text-helios-info",
};
const SEVERITY_FALLBACK = "bg-helios-line/70 text-helios-dim";

const STATUS_STYLE: Record<ReportRow["status"], { dot: string; text: string }> = {
  new: { dot: "bg-helios-info", text: "text-helios-info" },
  triaged: { dot: "bg-helios-warn", text: "text-helios-warn" },
  fixed: { dot: "bg-helios-success", text: "text-helios-success" },
};

function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

function reporterLine(row: ReportRow): string {
  const name = row.reporter_name?.trim() || "Unknown";
  const subteam = row.reporter_subteam?.trim();
  return subteam ? `${name} · ${subteam}` : name;
}

export function ReportsViewer({ onClose }: { onClose: () => void }) {
  const { reports, loading, error, setStatus, remove } = useReports();
  const [statusFilter, setStatusFilter] = useState<"all" | ReportRow["status"]>("all");
  const [kindFilter, setKindFilter] = useState<"all" | "bug" | "feature">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ReportRow | null>(null);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 helios-overlay-in" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Submitted reports"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[80vh] w-[46rem] max-w-[94vw] flex-col rounded-sm border border-helios-line bg-helios-panel text-helios-text helios-elevate helios-modal-in"
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

        {error && <div className="border-b border-helios-danger bg-helios-danger/10 px-4 py-1 text-xs text-helios-danger">{error}</div>}

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
              onDelete={() => setPendingDelete(r)}
            />
          ))}
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete report"
          body={`Permanently delete "${pendingDelete.title}"${pendingDelete.screenshot_path ? " and its screenshot" : ""}? This can't be undone.`}
          confirmLabel="Delete"
          confirmTone="danger"
          cancelLabel="Cancel"
          onConfirm={() => void remove(pendingDelete.id, pendingDelete.screenshot_path)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function ReportRowView({
  row, expanded, onToggle, onStatus, onDelete,
}: {
  row: ReportRow;
  expanded: boolean;
  onToggle: () => void;
  onStatus: (s: ReportRow["status"]) => void;
  onDelete: () => void;
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

  const kind = KIND_STYLE[row.kind];
  const sevClass = SEVERITY_STYLE[row.severity] ?? SEVERITY_FALLBACK;
  const status = STATUS_STYLE[row.status];

  return (
    <div className="flex items-stretch border-b border-helios-line/60">
      <div className={"w-1 shrink-0 " + kind.bar} aria-hidden />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-helios-base"
        >
          <div className="flex items-center gap-2">
            <span className={"shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide " + kind.badge}>{kind.label}</span>
            <span className={"shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold capitalize " + sevClass}>{row.severity}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-helios-text">{row.title}</span>
            <span className={"flex shrink-0 items-center gap-1 text-[11px] font-semibold " + status.text}>
              <span className={"h-1.5 w-1.5 rounded-full " + status.dot} aria-hidden />
              {row.status}
            </span>
            <span aria-hidden className="shrink-0 text-helios-dim">{expanded ? "▾" : "▸"}</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-helios-dim">
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-helios-line bg-helios-base text-[8px] font-bold text-helios-text"
              aria-hidden
            >
              {initials(row.reporter_name)}
            </span>
            <span className="min-w-0 truncate text-helios-text/80">{reporterLine(row)}</span>
            <span className="ml-auto shrink-0">{row.module ?? "—"}</span>
            <span className="shrink-0">{new Date(row.created_at).toLocaleDateString()}</span>
          </div>
        </button>

        {expanded && (
          <div className="space-y-2 px-3 pb-3 text-[11px] text-helios-dim">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>severity: <span className="text-helios-text">{row.severity}</span></span>
              <span>· v{row.app_version} · {row.os}</span>
              {row.reporter_email && <span>· <span className="text-helios-text/80">{row.reporter_email}</span></span>}
              <label className="ml-auto flex items-center gap-1">
                status:
                <select value={row.status} onChange={(e) => onStatus(e.target.value as ReportRow["status"])}
                  className={"rounded-sm border border-helios-line bg-helios-base px-1.5 py-0.5 font-semibold outline-none focus:border-asu-gold " + status.text}>
                  {STATUSES.map((s) => <option key={s} value={s} className="text-helios-text">{s}</option>)}
                </select>
              </label>
            </div>
            {row.what_doing && <div><span className="text-helios-text">What they were doing:</span> {row.what_doing}</div>}
            {row.details && <div><span className="text-helios-text">Details:</span> {row.details}</div>}
            {row.last_error && <div className="text-helios-danger">last error: {row.last_error.message}</div>}
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
            <div className="flex justify-end border-t border-helios-line/60 pt-2">
              <button
                type="button"
                onClick={onDelete}
                className="rounded-sm border border-transparent px-2 py-0.5 text-[11px] text-helios-dim hover:border-helios-danger/40 hover:bg-helios-danger/10 hover:text-helios-danger"
              >
                Delete report
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
