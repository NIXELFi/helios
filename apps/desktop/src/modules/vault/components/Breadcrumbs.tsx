import { useMemo } from "react";
import type { Folder, FolderId } from "../data/types";
import { resolveBreadcrumbPath } from "../data/folder-paths";

/**
 * Clickable path bar for the Browse screen: `vaultName / Chassis / Subframe`.
 * Every segment navigates; the last (current) segment is highlighted and
 * inert. Renders just the vault root chip when no folder is selected, so the
 * bar is a stable landmark rather than something that pops in and out.
 */
export function Breadcrumbs({
  vaultName,
  folders,
  selectedFolder,
  onNavigate,
}: {
  vaultName: string;
  folders: Folder[];
  selectedFolder: FolderId | null;
  onNavigate: (id: FolderId | null) => void;
}) {
  // M12: use resolveBreadcrumbPath so a missing/deleted folder in the ancestor
  // chain stops the walk gracefully instead of rendering ghost/broken links.
  const segments = useMemo(
    () => (selectedFolder ? resolveBreadcrumbPath(folders, selectedFolder) : []),
    [folders, selectedFolder],
  );

  return (
    <nav
      aria-label="Folder path"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-xs"
    >
      <button
        type="button"
        onClick={() => onNavigate(null)}
        aria-current={segments.length === 0 ? "page" : undefined}
        className={
          "shrink-0 rounded px-1.5 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold " +
          (segments.length === 0
            ? "font-semibold text-asu-gold"
            : "text-helios-dim hover:bg-helios-line hover:text-helios-text")
        }
      >
        {vaultName}
      </button>
      {segments.map((f, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={f.id} className="flex min-w-0 items-center gap-1">
            <span aria-hidden className="shrink-0 text-helios-dim/60">/</span>
            <button
              type="button"
              onClick={() => onNavigate(f.id)}
              aria-current={isLast ? "page" : undefined}
              disabled={isLast}
              title={f.name}
              className={
                "min-w-0 truncate rounded px-1.5 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold " +
                (isLast
                  ? "font-semibold text-helios-text"
                  : "text-helios-dim hover:bg-helios-line hover:text-helios-text")
              }
            >
              {f.name}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
