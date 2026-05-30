import { useEffect, useRef } from "react";
import type { UpdaterAvailable, UpdaterState } from "../lib/use-updater";

/** Tauri's updater `date` is an RFC3339-ish string like
 *  "2026-05-01 12:00:00.000 +00:00:00", which `new Date()` won't reliably
 *  parse. Format the leading date portion if we can; otherwise show it raw. */
function formatReleaseDate(raw: string): string {
  const datePart = raw.slice(0, 10);
  const d = new Date(datePart);
  return Number.isNaN(d.getTime())
    ? raw
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface Props {
  state: UpdaterState;
  /** Used to disable "Install and restart" mid-playback. App passes
   *  `playback.playing === true`; null when no session loaded. */
  playbackBlocked: boolean;
  onInstall: () => void;
  onClose: () => void;
}

export function UpdateModal({ state, playbackBlocked, onInstall, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Capture whatever was focused before the modal opened so we can restore
  // it on close (focus-restore, per the modal a11y recipe).
  const restoreFocusRef = useRef<Element | null>(null);

  const isOpen = state.kind === "available" || state.kind === "downloading" || state.kind === "installing";
  const downloading = state.kind === "downloading";
  const installing  = state.kind === "installing";
  const inFlight     = downloading || installing;

  // Escape-to-close + focus-trap. Escape is gated the same way as the backdrop
  // / footer button so a stray keypress can't dismiss the modal mid-download/
  // -install (the app is about to restart). Tab/Shift+Tab cycle within the
  // dialog so focus can't escape to the module behind it.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !inFlight) {
        // stopPropagation so a stacked context underneath doesn't ALSO close
        // on the same keypress — mirrors ConfirmDialog's Esc handler.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        // Nothing tabbable inside — keep focus on the dialog itself.
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, inFlight, onClose]);

  // Focus management: move focus into the dialog on open, restore it on close.
  useEffect(() => {
    if (!isOpen) return;
    restoreFocusRef.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      const el = restoreFocusRef.current;
      if (el instanceof HTMLElement) el.focus();
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const update: UpdaterAvailable =
    state.kind === "available" ? state.update :
    state.kind === "downloading" ? state.update :
    state.update;

  // Backdrop click closes only when idle — a restart is imminent during
  // download/install and an accidental backdrop click shouldn't dismiss it.
  function handleBackdropClick() {
    if (!inFlight) onClose();
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Update available"
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 outline-none"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-[#0E0E10] border border-[#2A2C32] w-[560px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center justify-between px-3 border-b border-[#2A2C32]">
          <span className="text-xs uppercase tracking-wider text-[#FFC627]">Update available</span>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            disabled={inFlight}
            className="w-5 h-5 flex items-center justify-center text-[#9097A0] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50 disabled:cursor-not-allowed"
          >×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-sm">
            <span className="text-[#D8DCE2] font-semibold">Helios v{update.version}</span>
            <span className="text-[#9097A0]"> — you're on v{update.currentVersion}</span>
          </div>
          {update.date && (
            <div className="text-xs text-[#5A5F66] mt-0.5">Released {formatReleaseDate(update.date)}</div>
          )}
          <pre className="mt-4 whitespace-pre-wrap font-sans text-xs text-[#D8DCE2] bg-[#16171B] border border-[#2A2C32] p-2 rounded-sm overflow-auto max-h-64">
{update.notes || "(no release notes)"}
          </pre>
          {downloading && (
            <DownloadProgressBar
              downloaded={(state as Extract<UpdaterState, { kind: "downloading" }>).downloaded}
              total={(state as Extract<UpdaterState, { kind: "downloading" }>).total}
            />
          )}
          {installing && (
            <div className="mt-3 text-xs text-[#9097A0]">Installing… the app will relaunch automatically.</div>
          )}
          {playbackBlocked && !inFlight && (
            <div className="mt-3 text-xs text-[#FFB800]">
              Pause playback before installing — the app will restart and lose your scrub position.
            </div>
          )}
        </div>
        <div className="h-12 flex items-center justify-end gap-2 px-3 border-t border-[#2A2C32]">
          <button
            type="button"
            onClick={onClose}
            disabled={inFlight}
            className="px-2 py-1 text-xs border border-[#2A2C32] bg-[#16171B] text-[#9097A0] hover:border-[#FFC627] rounded-sm cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50 disabled:cursor-not-allowed"
          >Remind me later</button>
          <button
            type="button"
            onClick={onInstall}
            disabled={inFlight || playbackBlocked}
            className="px-3 py-1 text-xs bg-[#FFC627] text-[#0E0E10] hover:bg-[#FFD24A] rounded-sm cursor-pointer font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50 disabled:cursor-not-allowed"
          >Install and restart</button>
        </div>
      </div>
    </div>
  );
}

function DownloadProgressBar({ downloaded, total }: { downloaded: number; total: number | null }) {
  const pct = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  return (
    <div className="mt-3">
      <div className="h-1.5 bg-[#2A2C32] rounded-sm overflow-hidden">
        <div
          className="h-full bg-[#FFC627] transition-all duration-150"
          style={{ width: pct === null ? "100%" : `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-[10px] text-[#9097A0] font-mono-num">
        {pct === null ? "(unknown size)" : `${pct}% · ${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ""}`}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
