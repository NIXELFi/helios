import type { UpdaterAvailable, UpdaterState } from "../lib/use-updater";

interface Props {
  state: UpdaterState;
  /** Used to disable "Install and restart" mid-playback. App passes
   *  `playback.playing === true`; null when no session loaded. */
  playbackBlocked: boolean;
  onInstall: () => void;
  onClose: () => void;
}

export function UpdateModal({ state, playbackBlocked, onInstall, onClose }: Props) {
  if (state.kind !== "available" && state.kind !== "downloading" && state.kind !== "installing") {
    return null;
  }

  const update: UpdaterAvailable =
    state.kind === "available" ? state.update :
    state.kind === "downloading" ? state.update :
    state.update;

  const downloading = state.kind === "downloading";
  const installing  = state.kind === "installing";
  const inFlight    = downloading || installing;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#0E0E10] border border-[#2A2C32] w-[560px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center justify-between px-3 border-b border-[#2A2C32]">
          <span className="text-xs uppercase tracking-wider text-[#FFC627]">Update available</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          >×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-sm">
            <span className="text-[#D8DCE2] font-semibold">Helios v{update.version}</span>
            <span className="text-[#7B8088]"> — you're on v{update.currentVersion}</span>
          </div>
          {update.date && (
            <div className="text-xs text-[#5A5F66] mt-0.5">Released {update.date}</div>
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
            <div className="mt-3 text-xs text-[#7B8088]">Installing… the app will relaunch automatically.</div>
          )}
          {playbackBlocked && !inFlight && (
            <div className="mt-3 text-xs text-[#FFB800]">
              Pause playback before installing — the app will restart and lose your scrub position.
            </div>
          )}
        </div>
        <div className="h-12 flex items-center justify-end gap-2 px-3 border-t border-[#2A2C32]">
          <button
            onClick={onClose}
            disabled={inFlight}
            className="px-2 py-1 text-xs border border-[#2A2C32] bg-[#16171B] text-[#7B8088] hover:border-[#FFC627] rounded-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >Remind me later</button>
          <button
            onClick={onInstall}
            disabled={inFlight || playbackBlocked}
            className="px-3 py-1 text-xs bg-[#FFC627] text-[#0E0E10] hover:bg-[#FFD24A] rounded-sm cursor-pointer font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
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
      <div className="mt-1 text-[10px] text-[#7B8088] font-mono-num">
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
