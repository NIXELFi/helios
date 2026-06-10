// Report composer: pick exactly which studies go into the engineering report
// (the comparison section compares the picked designs — not everything on the
// machine), then print straight to PDF or save the HTML. Opened by
// ReportButton on every screen, pre-selecting that screen's natural scope.

import { useEffect, useMemo, useRef, useState } from "react";

import { useCfd } from "../state/CfdContext";
import { buildMasterReportHtml } from "../lib/export/masterReport";
import { printHtml } from "../lib/export/printReport";
import { saveTextFile, fileTimestamp } from "../lib/export/io";
import { studyName } from "../lib/studyName";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Studies pre-checked when the dialog opens (omit = all). */
  defaultSelected?: string[];
  title?: string;
}

export function ReportDialog({ open, onClose, defaultSelected, title }: Props) {
  const { state } = useCfd();
  const studies = useMemo(
    () => Object.values(state.studies).sort((a, b) => b.startedAt - a.startedAt),
    [state.studies],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement | null>(null);

  // Re-seed the selection each time the dialog opens.
  useEffect(() => {
    if (open) {
      setSelected(new Set(defaultSelected ?? studies.map((s) => s.id)));
      setMsg(null);
      setTimeout(() => firstRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const build = () =>
    buildMasterReportHtml({
      generatedAt: new Date().toISOString(),
      studies: state.studies,
      vehicleConfig: state.vehicleConfig,
      referenceBaseline: state.referenceBaseline,
      only: selected.size === studies.length ? undefined : [...selected],
      title,
    });

  async function printPdf() {
    setBusy(true);
    try {
      await printHtml(build());
      setMsg("Print dialog opened — choose “Save as PDF”.");
    } catch {
      // Webview refused to print → fall back to saving the HTML.
      const path = await saveTextFile(`helios-cfd-report-${fileTimestamp()}`, "html", build());
      setMsg(path == null ? "Cancelled" : `Printing unavailable — saved ${path.split(/[\\/]/).pop()}; open it and print to PDF.`);
    }
    setBusy(false);
  }

  async function saveHtml() {
    setBusy(true);
    try {
      const path = await saveTextFile(`helios-cfd-report-${fileTimestamp()}`, "html", build());
      setMsg(path == null ? "Cancelled" : `Saved → ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const kindChip: Record<string, string> = {
    sweep: "Sweep",
    optimization: "Optim",
    "single-rpm": "1-RPM",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cfd-report-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div className="w-[460px] max-w-[92vw] rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-4 text-helios-text">
        <div id="cfd-report-title" className="text-[11px] uppercase tracking-wider text-[#FFC627]">
          Engineering report
        </div>
        <p className="mt-1 text-[10px] text-[#5A5F66]">
          Pick the studies to include — the comparison section compares exactly the designs you pick.
        </p>

        <div className="mt-2 flex gap-2 text-[9px] uppercase tracking-wider">
          <button type="button" className="text-[#9097A0] hover:text-[#FFC627]"
            onClick={() => setSelected(new Set(studies.map((s) => s.id)))}>All</button>
          <button type="button" className="text-[#9097A0] hover:text-[#FFC627]"
            onClick={() => setSelected(new Set())}>None</button>
        </div>

        <div className="mt-1 max-h-[300px] overflow-y-auto rounded-sm border border-[#2A2C32]">
          {studies.length === 0 ? (
            <p className="p-3 text-[10px] text-[#5A5F66]">No studies yet.</p>
          ) : (
            studies.map((s, i) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-2 border-b border-[#16171B] px-2 py-1.5 text-[11px] hover:bg-[#16171B]"
              >
                <input
                  ref={i === 0 ? firstRef : undefined}
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={() => toggle(s.id)}
                  className="accent-[#FFC627]"
                />
                <span className="rounded-sm border border-[#2A2C32] px-1 py-[1px] text-[8px] uppercase tracking-wider text-[#5A5F66]">
                  {kindChip[s.kind] ?? s.kind}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[#D8DCE2]">{studyName(s)}</span>
                <span className="text-[9px] text-[#5A5F66]">{new Date(s.startedAt).toLocaleDateString()}</span>
              </label>
            ))
          )}
        </div>

        {msg && <p role="status" className="mt-2 text-[10px] text-[#D8DCE2]">{msg}</p>}

        <div className="mt-3 flex items-center justify-end gap-2">
          <span className="mr-auto text-[10px] text-[#5A5F66]">{selected.size} selected</span>
          <button type="button" onClick={onClose}
            className="rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#9097A0]">
            Close
          </button>
          <button type="button" disabled={selected.size === 0 || busy} onClick={() => void saveHtml()}
            className="rounded-sm border border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627] disabled:opacity-40">
            Save HTML
          </button>
          <button type="button" disabled={selected.size === 0 || busy} onClick={() => void printPdf()}
            className="rounded-sm bg-[#FFC627] px-3 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300 disabled:opacity-40">
            Print → PDF
          </button>
        </div>
      </div>
    </div>
  );
}
