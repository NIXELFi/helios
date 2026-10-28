import { useMemo } from "react";
import type { FileId, FolderId, UserId, VaultFile } from "../data/types";
import { absoluteWhen, relativeWhen, whoLabel } from "../lib/when";

const SHOW = 6;

/**
 * "Recent check-ins" rail under the folder tree — the last few versions
 * across the whole vault, derived from the latest-version rows already
 * embedded on `allFiles` (zero extra queries). Each row says who checked it in
 * and when; clicking jumps Browse to that file's folder and selects it, so
 * "what changed since yesterday" is one click.
 */
export function RecentActivity({
  allFiles,
  nameById,
  currentUserId,
  onPick,
}: {
  allFiles: VaultFile[];
  /** user id → name (usePeopleNames). */
  nameById: ReadonlyMap<UserId, string>;
  currentUserId?: string | null;
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
          const who = whoLabel(v.author_id, nameById, currentUserId);
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onPick(f.id, f.folder_id)}
                title={`${f.name} — v${v.version_num} by ${who}, ${absoluteWhen(v.created_at)}${v.comment ? `\n"${v.comment}"` : ""}`}
                className="flex w-full flex-col px-3 py-1 text-left transition-colors hover:bg-helios-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
              >
                <span className="flex w-full items-baseline gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono-num text-[11px] text-helios-text">
                    {f.name}
                  </span>
                  <span className="shrink-0 font-mono-num text-[10px] text-asu-gold/90">v{v.version_num}</span>
                </span>
                <span className="flex w-full items-baseline gap-1 text-[10px] text-helios-dim">
                  <span className="min-w-0 truncate">{who}</span>
                  <span className="shrink-0">· {relativeWhen(v.created_at)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
