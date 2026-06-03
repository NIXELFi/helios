"use client";

import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { criticalityFill, type TaskPriority } from "@helios/pm-ui";
import { FloatingWindow } from "@pm/components/ui/FloatingWindow";
import { usePmStore } from "@pm/lib/pmStore";
import {
  buildDeadlineReport,
  reportToMarkdown,
  reportToPlainText,
  type DeadlineReport,
  type ReportTask,
} from "@pm/lib/deadlineReport";

interface DeadlineReportWindowProps {
  open: boolean;
  onClose: () => void;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

// "in 3 days" / "today" / "5 days overdue".
function duePhrase(daysUntilDue: number): string {
  if (daysUntilDue === 0) return "today";
  if (daysUntilDue > 0) return `in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}`;
  const late = -daysUntilDue;
  return `${late} day${late === 1 ? "" : "s"} overdue`;
}

export function DeadlineReportWindow({ open, onClose }: DeadlineReportWindowProps) {
  // The report is SNAPSHOT once per open: we read tasks imperatively (getState,
  // not a subscription) and pass a freshly constructed calendar date as `now`,
  // so the numbers stay frozen while the window is open. Re-snapshot only when
  // the window transitions closed→open.
  const [report, setReport] = useState<DeadlineReport | null>(null);
  // Transient "Copied!" feedback keyed by which button fired.
  const [copied, setCopied] = useState<"md" | "txt" | null>(null);

  useEffect(() => {
    if (!open) {
      setReport(null);
      setCopied(null);
      return;
    }
    // Imperative read — NOT usePmStore((s) => s.tasks). Constructed at click time.
    const tasks = usePmStore.getState().tasks;
    setReport(buildDeadlineReport(tasks, new Date()));
  }, [open]);

  async function copyText(text: string, which: "md" | "txt") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch {
      // Clipboard denied (rare in the desktop shell) — silently no-op; the
      // Export buttons remain a reliable fallback.
    }
  }

  // Mirrors the file-save pattern in src/lib/csv-export.ts: pick a path via the
  // Tauri dialog, then writeTextFile. Returns silently if the user cancels.
  async function exportFile(text: string, ext: "md" | "txt") {
    const path = await save({
      defaultPath: `deadlines-report.${ext}`,
      filters: [{ name: ext === "md" ? "Markdown" : "Text", extensions: [ext] }],
    });
    if (!path) return;
    await writeTextFile(path, text);
  }

  const markdown = report ? reportToMarkdown(report) : "";
  const plain = report ? reportToPlainText(report) : "";

  return (
    <FloatingWindow
      open={open}
      title="Deadlines report"
      onClose={onClose}
      initialWidth={760}
      initialHeight={640}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-xs text-helios-dim">
            {copied === "md"
              ? "Markdown copied"
              : copied === "txt"
                ? "Text copied"
                : report
                  ? `${report.upcoming.length} upcoming · ${report.overdue.length} overdue`
                  : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!report}
              onClick={() => void copyText(markdown, "md")}
              className="rounded border border-helios-line bg-transparent px-3 py-1.5 text-sm font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              Copy as Markdown
            </button>
            <button
              type="button"
              disabled={!report}
              onClick={() => void copyText(plain, "txt")}
              className="rounded border border-helios-line bg-transparent px-3 py-1.5 text-sm font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              Copy as text
            </button>
            <button
              type="button"
              disabled={!report}
              onClick={() => void exportFile(markdown, "md")}
              className="rounded border border-helios-line bg-transparent px-3 py-1.5 text-sm font-normal text-helios-dim hover:bg-helios-base hover:text-helios-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              Export .md
            </button>
            <button
              type="button"
              disabled={!report}
              onClick={() => void exportFile(plain, "txt")}
              className="rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-black hover:bg-asu-gold/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Export .txt
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-6 p-5">
        <p className="text-xs text-helios-dim">
          {report
            ? `Generated ${formatGenerated(report.generatedAt)} · reference date ${report.refDate}`
            : "Building report…"}
        </p>

        <ReportSection
          title={`Upcoming (next ${report?.windowDays ?? 14} days)`}
          emptyLabel="Nothing due in the window."
          rows={report?.upcoming ?? []}
        />

        <ReportSection
          title="Overdue"
          emptyLabel="Nothing overdue."
          rows={report?.overdue ?? []}
        />
      </div>
    </FloatingWindow>
  );
}

function ReportSection({
  title,
  emptyLabel,
  rows,
}: {
  title: string;
  emptyLabel: string;
  rows: ReportTask[];
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-widest text-helios-dim">
        {title} <span className="text-helios-dim/70">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="px-1 py-2 text-sm text-helios-dim">{emptyLabel}</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-helios-line">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-helios-line bg-helios-base/30 text-left text-[10px] font-medium uppercase tracking-widest text-helios-dim">
                <th className="px-3 py-2">Task</th>
                <th className="px-3 py-2">Due date</th>
                <th className="px-3 py-2">Days</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2">Subteam</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-helios-line/60 last:border-b-0">
                  <td className="px-3 py-2 text-helios-text">{t.title}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-helios-dim">{t.due_date}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-helios-dim">
                    {duePhrase(t.daysUntilDue)}
                  </td>
                  <td className="px-3 py-2">
                    {(() => {
                      const fill = criticalityFill(t.priority);
                      return (
                        <span
                          className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
                          style={{ backgroundColor: fill.background, color: fill.color }}
                        >
                          {PRIORITY_LABEL[t.priority]}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-helios-dim">
                    {t.ownerName ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 text-helios-dim">
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.subteamColor ?? "#6B7280" }}
                      />
                      <span className="truncate">{t.subteamName}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// The ISO timestamp formatted for the on-screen header (local, readable).
function formatGenerated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
