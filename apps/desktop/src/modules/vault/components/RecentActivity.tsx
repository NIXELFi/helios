import { useMemo } from "react";
import type { FileId, FolderId, UserId, VaultFile } from "../data/types";

/** Compact relative time ("3h", "2d") for the activity rail. */
function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

const SHOW = 6;

/**
 * "Recent check-ins" rail under the folder tree — the last few versions
 * across the whole vault, derived from the latest-version rows already
 * embedded on `allFiles` (zero extra queries). Clicking an entry jumps Browse
 * to that file's folder and selects it, so "what changed since yesterday" is
 * one click.
 */
export function RecentActivity({
  allFiles,
  holderEmailById,
  onPick,
}: {
  allFiles: VaultFile[];
  holderEmailById: Map<UserId, string>;
  onPick: (fileId: FileId, folderId: FolderId | null) => void;
}) {
  const recent = useMemo(() => {
    return allFiles
      .filter((f) => f.latest?.created_at)
      .sort((a, b) => (a.latest!.created_at < b.latest!.created_at ? 1 : -1))
      .slice(0, SHOW);
  }, [allFiles]);

  if (recent.length === 0) return null;
  return (
    <section className="shrink-0 border-t border-helios-line">
      <h3 className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-helios-dim">
        Recent check-ins
      </h3>
      <ul className="pb-2">
        {recent.map((f) => {
          const v = f.latest!;
          const who = v.author_id ? holderEmailById.get(v.author_id) : undefined;
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onPick(f.id, f.folder_id)}
                title={`${f.name} — v${v.version_num}${who ? ` by ${who}` : ""}${v.comment ? ` · "${v.comment}"` : ""}`}
                className="flex w-full items-baseline gap-1.5 px-3 py-0.5 text-left transition-colors hover:bg-helios-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
              >
                <span className="min-w-0 flex-1 truncate font-mono-num text-[11px] text-helios-text">
                  {f.name}
                </span>
                <span className="shrink-0 font-mono-num text-[10px] text-asu-gold/90">v{v.version_num}</span>
                <span className="shrink-0 font-mono-num text-[10px] text-helios-dim">{ago(v.created_at)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
