/**
 * Bell icon + unread badge in the NavRail, opening a dropdown notification feed.
 *
 * Receives data from useNotifications (items, unread, markAllRead, clear) and
 * a click-to-jump handler so clicking a notification can navigate to the file.
 */
import { useEffect, useRef, useState } from "react";
import { IconBell } from "@tabler/icons-react";
import type { Notification } from "../lib/notifications";
import type { FileId } from "../data/types";

interface Props {
  items: Notification[];
  unread: number;
  onMarkAllRead: () => void;
  onClear: () => void;
  /** Optional: if provided, clicking a notification item calls this with the
   *  file id so the caller can navigate to it. */
  onJumpToFile?: (fileId: FileId) => void;
  /** Optional: maps an actor user-id → a human label (email / display name).
   *  When absent or missing the actor, the row falls back to the id prefix. */
  actorNames?: Map<string, string>;
}

/** Human label for an actor: the resolved display name/email when known, else
 *  a short id prefix so the row still says *who* (not a bare 36-char UUID). */
function actorLabel(actorId: string, actorNames?: Map<string, string>): string {
  const name = actorNames?.get(actorId);
  if (name && name.trim()) return name;
  return `${actorId.slice(0, 8)}…`;
}

const KIND_LABELS: Record<Notification["kind"], string> = {
  checked_in: "Checked in",
  checked_out: "Checked out",
  unlocked: "Unlocked",
  force_unlocked: "Force-unlocked",
  deleted: "Deleted",
  restored: "Restored",
};

/** Compact relative time for notification timestamps. */
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function NotificationFeed({ items, unread, onMarkAllRead, onClear, onJumpToFile, actorNames }: Props) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function toggle() {
    setOpen((v) => !v);
  }

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        title="Notification feed"
        onClick={toggle}
        className={
          "relative flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
          (open
            ? "bg-asu-gold/15 text-asu-gold"
            : "text-helios-dim hover:bg-helios-base/60 hover:text-asu-gold")
        }
      >
        <IconBell size={16} strokeWidth={1.5} className="shrink-0" />
        <span className="flex-1 truncate text-left">Notifs</span>
        {unread > 0 && (
          <span
            aria-hidden
            className="ml-1 shrink-0 rounded-full bg-asu-gold/20 px-1.5 py-px font-mono-num text-[10px] leading-4 text-asu-gold"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {/* Feed panel — absolutely positioned below the bell, in the NavRail */}
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notification feed"
          className="absolute left-full top-0 z-50 ml-1 w-72 rounded-lg border border-helios-line bg-helios-panel shadow-xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-helios-line px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-helios-dim">
              Notifications
            </span>
            <div className="flex gap-1">
              {unread > 0 && (
                <button
                  type="button"
                  onClick={onMarkAllRead}
                  className="rounded px-2 py-0.5 text-[10px] text-helios-dim hover:bg-helios-line hover:text-helios-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
                >
                  Mark all read
                </button>
              )}
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={onClear}
                  className="rounded px-2 py-0.5 text-[10px] text-helios-dim hover:bg-helios-line hover:text-helios-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Items */}
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                <IconBell size={28} strokeWidth={1} className="text-helios-dim/50" />
                <p className="text-sm text-helios-dim">No notifications</p>
                <p className="text-xs text-helios-dim/70">Star a file to watch it.</p>
              </div>
            ) : (
              <ul>
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (onJumpToFile) {
                          onJumpToFile(n.fileId);
                          setOpen(false);
                        }
                      }}
                      className={
                        "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors " +
                        "hover:bg-helios-base/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-asu-gold " +
                        (n.read ? "" : "border-l-2 border-asu-gold")
                      }
                      title={onJumpToFile ? `Go to ${n.fileName}` : undefined}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium text-helios-text">
                          {n.fileName}
                        </span>
                        <span className="shrink-0 text-[10px] text-helios-dim">{relTime(n.at)}</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-helios-dim">
                        <span
                          className={
                            "rounded px-1 py-px text-[10px] font-medium " +
                            (n.kind === "force_unlocked" || n.kind === "deleted"
                              ? "bg-[#EF5350]/15 text-[#EF5350]"
                              : n.kind === "checked_in" || n.kind === "restored"
                                ? "bg-green-800/20 text-green-400"
                                : "bg-asu-gold/15 text-asu-gold")
                          }
                        >
                          {KIND_LABELS[n.kind]}
                        </span>
                        {n.actorId && (
                          <span className="truncate" title={actorNames?.get(n.actorId) ?? n.actorId}>
                            by {actorLabel(n.actorId, actorNames)}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
