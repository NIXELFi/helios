import type { ReactNode } from "react";
import type { UserId, Version, VersionId } from "../data/types";
import { absoluteWhen, relativeWhen, whoLabel } from "../lib/when";

interface Props {
  versions: Version[];
  onSelect: (id: VersionId) => void;
  /** Optional per-row action(s) (e.g. a "Get this version" button). Rendered
   *  as a SIBLING of the row's select button — never nested inside it (nesting
   *  a button in a button is invalid HTML and makes the action click bubble
   *  into a row selection). */
  renderActions?: (version: Version) => ReactNode;
  /** user id → name for the "by <person>" line (usePeopleNames). Omitted →
   *  authors read as "Unknown member", never a raw id. */
  nameById?: ReadonlyMap<UserId, string>;
  /** Current user, so their own versions read "You". */
  currentUserId?: string | null;
}

const NO_NAMES: ReadonlyMap<UserId, string> = new Map();

export function VersionList({ versions, onSelect, renderActions, nameById = NO_NAMES, currentUserId }: Props) {
  if (versions.length === 0) {
    return <div className="p-3 text-sm text-helios-dim">No versions yet.</div>;
  }
  return (
    <ol className="divide-y divide-helios-line text-sm">
      {versions.map((v) => (
        <li key={v.id} className="flex items-stretch">
          {/* Real, keyboard-accessible button so the clickable affordance
              isn't a mouse-only div. Enter/Space activate it natively. */}
          <button
            type="button"
            onClick={() => onSelect(v.id)}
            className="min-w-0 flex-1 cursor-pointer px-3 py-2 text-left hover:bg-helios-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-asu-gold"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <span className="font-mono-num text-xs text-helios-dim">v{v.version_num}</span>
                {v.revision != null && (
                  <span className="rounded bg-asu-gold/20 px-1 py-0.5 font-mono-num text-[10px] font-semibold text-asu-gold">
                    rev {v.revision}
                  </span>
                )}
              </span>
              <time
                dateTime={v.created_at}
                title={absoluteWhen(v.created_at)}
                className="shrink-0 text-xs text-helios-dim"
              >
                {relativeWhen(v.created_at)}
              </time>
            </div>
            <div className="text-helios-text">{v.comment ?? <em className="text-helios-dim">(no comment)</em>}</div>
            {/* Who + exact when, always visible — "who changed this and when"
                shouldn't need a hover. */}
            <div className="mt-0.5 truncate text-[11px] text-helios-dim">
              by <span className="text-helios-text/80">{whoLabel(v.author_id, nameById, currentUserId)}</span>
              {" · "}
              {absoluteWhen(v.created_at)}
            </div>
          </button>
          {/* Per-row actions live OUTSIDE the select button (sibling) so they
              don't form an invalid nested-button and their clicks don't bubble
              into a row selection. */}
          {renderActions && (
            <div className="flex items-center pr-2">{renderActions(v)}</div>
          )}
        </li>
      ))}
    </ol>
  );
}
