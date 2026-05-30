import type { BulkDownloadAPI } from "../data/useBulkDownload";

/**
 * Progress modal driven by a useBulkDownload() return value. Renders only
 * when `api.open` is true. The caller owns the API (so multiple triggers
 * can share one modal) and just plumbs it through.
 */
export function BulkDownloadModal({ api }: { api: BulkDownloadAPI }) {
  if (!api.open) return null;
  const elapsedMs = api.startedAt ? Date.now() - api.startedAt : 0;
  const mb = api.bytesDone / 1024 / 1024;
  const rate = elapsedMs > 0 ? mb / (elapsedMs / 1000) : 0;
  // Every file ends in exactly one terminal bucket (done / skipped / stale /
  // errored), so progress must count all four — otherwise the bar stalls
  // below 100% whenever files are skipped or left as stale.
  const settled = api.done + api.errs + api.skipped + api.stale;
  const pct = api.total > 0 ? Math.floor((settled / api.total) * 100) : 0;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={api.close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[28rem] rounded-lg border border-helios-line bg-helios-panel p-5 shadow-xl"
      >
        <h3 className="mb-2 text-sm font-semibold text-helios-text">
          Downloading {api.total} files
        </h3>
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-helios-line">
          <div
            className="h-full bg-asu-gold transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mb-3 flex justify-between text-xs text-helios-dim">
          <span>
            {api.done}/{api.total} done
            {api.skipped > 0 && <span> · {api.skipped} up to date</span>}
            {api.stale > 0 && (
              <span
                className="text-[#FFB800]"
                title="Local copy differs from the latest version — left untouched so a local edit isn't overwritten. Use Get Latest on the file to pull it."
              >
                {" "}· {api.stale} differ (kept)
              </span>
            )}
            {api.errs > 0 && <span className="text-[#EF5350]"> · {api.errs} failed</span>}
          </span>
          <span className="font-mono-num">
            {mb.toFixed(1)} MB · {rate.toFixed(1)} MB/s
          </span>
        </div>
        {api.active.length > 0 ? (
          <div className="mb-3 space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-helios-dim">
              In flight ({api.active.length})
            </div>
            {api.active.map((entry) => (
              <div
                key={entry.id}
                className="truncate font-mono-num text-[11px] text-helios-text"
                title={entry.name}
              >
                {entry.name}
              </div>
            ))}
          </div>
        ) : (
          <div className="mb-3 truncate font-mono-num text-[11px] text-helios-dim">
            {api.running ? "Starting…" : "Done"}
          </div>
        )}
        {api.lastError && (
          <div className="mb-3 text-[11px] text-[#EF5350]">
            Last error: {api.lastError}
          </div>
        )}
        <div className="flex justify-end gap-2">
          {api.running ? (
            <button
              type="button"
              onClick={api.cancel}
              className="rounded border border-helios-line px-3 py-1 text-xs text-helios-dim hover:text-helios-text"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={api.close}
              className="rounded bg-asu-gold px-3 py-1 text-xs text-white hover:bg-asu-gold"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
