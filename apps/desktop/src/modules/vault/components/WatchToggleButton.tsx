/**
 * A small star button that toggles watch status on a single vault file.
 * Used in FileDetailPanel's header toolbar and optionally in FileTable rows.
 *
 * Filled gold star = watched; outline = unwatched.
 */
import { IconStarFilled, IconStar } from "@tabler/icons-react";
import type { FileId } from "../data/types";

interface Props {
  fileId: FileId;
  isWatched: boolean;
  onToggle: (fileId: FileId) => void;
  /** Visual variant — "icon" is a bare icon button (detail panel header);
   *  "row" is slightly padded for inline row use. */
  variant?: "icon" | "row";
}

export function WatchToggleButton({ fileId, isWatched, onToggle, variant = "icon" }: Props) {
  const label = isWatched ? "Unwatch file (remove from notification feed)" : "Watch file (get notified of changes)";
  const padClass = variant === "row" ? "px-1.5 py-0.5" : "p-0.5";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onToggle(fileId); }}
      className={
        `rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold ${padClass} ` +
        (isWatched
          ? "text-asu-gold hover:text-asu-gold/70"
          : "text-helios-dim hover:text-asu-gold")
      }
    >
      {isWatched
        ? <IconStarFilled size={14} />
        : <IconStar size={14} strokeWidth={1.5} />
      }
    </button>
  );
}
