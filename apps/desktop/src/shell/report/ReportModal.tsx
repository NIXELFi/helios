import { useEffect, useMemo, useRef, useState } from "react";
import { getBreadcrumbs, getLastError } from "../../lib/breadcrumbs";
import { captureScreenshot } from "../../lib/screenshot";
import { useSubmitReport } from "./useSubmitReport";
import type { ReportDiagnostics, ReportKind } from "./types";

const SEVERITIES: Record<ReportKind, string[]> = {
  bug: ["blocker", "annoying", "minor"],
  feature: ["important", "nice-to-have"],
};
const DEFAULT_SEVERITY: Record<ReportKind, string> = { bug: "annoying", feature: "important" };

function currentOs(): string {
  try {
    return (navigator.platform || navigator.userAgent || "unknown").slice(0, 80);
  } catch {
    return "unknown";
  }
}

export function ReportModal({
  kind: initialKind,
  module,
  appVersion,
  onClose,
}: {
  kind: ReportKind;
  module: string;
  appVersion: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ReportKind>(initialKind);
  const [severity, setSeverity] = useState<string>(DEFAULT_SEVERITY[initialKind]);
  const [title, setTitle] = useState("");
  const [whatDoing, setWhatDoing] = useState("");
  const [details, setDetails] = useState("");
  const [shot, setShot] = useState<Blob | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const [sent, setSent] = useState(false);

  // Snapshot diagnostics ONCE when the modal opens so the read-only preview the
  // user reviews is exactly what gets submitted (a late console.error or module
  // switch while the modal is open won't change it).
  const [diag] = useState<ReportDiagnostics>(() => ({
    module,
    app_version: appVersion,
    os: currentOs(),
    breadcrumbs: getBreadcrumbs(),
    last_error: getLastError(),
  }));

  const { submit, submitting, error } = useSubmitReport();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreTo?.focus?.();
    };
  }, [onClose]);

  const shotUrl = useMemo(() => (shot ? URL.createObjectURL(shot) : null), [shot]);
  useEffect(() => () => { if (shotUrl) URL.revokeObjectURL(shotUrl); }, [shotUrl]);

  function pickKind(k: ReportKind) {
    setKind(k);
    setSeverity(DEFAULT_SEVERITY[k]);
  }

  async function attachShot() {
    setCapturing(true);
    try {
      const blob = await captureScreenshot();
      if (blob) setShot(blob);
    } finally {
      setCapturing(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    const ok = await submit({ kind, severity, title, what_doing: whatDoing, details }, diag, shot);
    if (ok) {
      setSent(true);
      setTimeout(onClose, 1200);
    }
  }

  const sevOptions = SEVERITIES[kind];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Report a bug or request a feature"
        onClick={(e) => e.stopPropagation()}
        className="w-[28rem] max-w-[90vw] max-h-[88vh] overflow-y-auto rounded-sm border border-helios-line bg-helios-panel p-4 text-helios-text shadow-xl"
      >
        {sent ? (
          <div className="flex flex-col items-center gap-2 py-8 text-sm">
            <span className="text-2xl text-asu-gold">✓</span>
            <span>Thanks — your report was sent.</span>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={onSubmit}>
            <h3 className="text-sm font-semibold">Report a bug or request a feature</h3>

            <div className="flex gap-2" role="group" aria-label="Report type">
              {(["bug", "feature"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => pickKind(k)}
                  aria-pressed={kind === k}
                  className={
                    "flex-1 rounded-sm border px-2 py-1 text-xs capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
                    (kind === k ? "border-asu-gold bg-asu-gold font-semibold text-helios-base" : "border-helios-line bg-helios-base text-helios-text hover:border-asu-gold")
                  }
                >
                  {k}
                </button>
              ))}
            </div>

            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-helios-dim">Severity</span>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
                aria-label="Severity"
                className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-sm outline-none focus:border-asu-gold"
              >
                {sevOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-helios-dim">Title</span>
              <input
                ref={firstRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={kind === "bug" ? "Short summary of the problem" : "Short summary of the idea"}
                className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-sm outline-none focus:border-asu-gold"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-helios-dim">What were you doing?</span>
              <textarea
                value={whatDoing}
                onChange={(e) => setWhatDoing(e.target.value)}
                rows={2}
                placeholder={`In ${module} — what led up to this?`}
                className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-sm outline-none focus:border-asu-gold"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-helios-dim">Details (optional)</span>
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                className="w-full rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-sm outline-none focus:border-asu-gold"
              />
            </label>

            <div className="flex items-center gap-2">
              {shotUrl ? (
                <>
                  <img src={shotUrl} alt="Screenshot preview" className="h-12 w-20 rounded-sm border border-helios-line object-cover" />
                  <button type="button" onClick={() => setShot(null)} className="text-xs text-helios-dim hover:text-red-300">
                    Remove screenshot
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={attachShot}
                  disabled={capturing}
                  className="rounded-sm border border-helios-line bg-helios-base px-2 py-1 text-xs text-helios-text hover:border-asu-gold disabled:opacity-50"
                >
                  {capturing ? "Capturing…" : "Attach screenshot"}
                </button>
              )}
            </div>

            <div className="rounded-sm border border-helios-line">
              <button
                type="button"
                onClick={() => setShowDiag((s) => !s)}
                aria-expanded={showDiag}
                className="flex w-full items-center justify-between px-2 py-1 text-left text-[11px] text-helios-dim hover:text-helios-text"
              >
                <span>Diagnostics included ({diag.breadcrumbs.length} events)</span>
                <span aria-hidden>{showDiag ? "▾" : "▸"}</span>
              </button>
              {showDiag && (
                <div className="max-h-40 overflow-y-auto border-t border-helios-line px-2 py-1 text-[10px] text-helios-dim">
                  <div>v{diag.app_version} · {diag.os} · module={diag.module}</div>
                  {diag.last_error && <div className="mt-1 text-red-300">last error: {diag.last_error.message}</div>}
                  <ul className="mt-1 space-y-0.5 font-mono-num">
                    {diag.breadcrumbs.map((b, i) => (
                      <li key={i}>{b.t.slice(11, 19)} {b.category}: {b.message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {error && <div className="rounded-sm border border-[#EF5350] bg-[#EF5350]/10 px-2 py-1 text-xs text-[#EF5350]">{error}</div>}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} disabled={submitting} className="rounded-sm px-3 py-1 text-xs text-helios-dim hover:bg-helios-line disabled:opacity-50">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim() || submitting}
                className="rounded-sm bg-asu-gold px-3 py-1 text-xs font-semibold text-helios-base hover:bg-asu-gold/90 disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Send report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
