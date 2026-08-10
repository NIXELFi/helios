import type { ChannelStore } from "@helios/store";
import type { LapDetectionConfig, LapSet } from "@helios/lib";
import { loadSessionMeta, type SessionMeta } from "./app-state";

export interface LoadedSession {
  id: string;
  /** Display label. Starts out loader-derived (filename for user files, sample
   *  label for bundled ones) and is replaced by the user's custom label when
   *  one is saved — see applySessionMeta. Everything downstream (header,
   *  tooltips, export filenames, the remove-confirm) reads this, so a rename
   *  propagates everywhere for free. */
  label: string;
  store: ChannelStore;
  color: string;
  visible: boolean;
  /** Lap detection config — persisted per-session in localStorage. Null when
   *  the session has no detectable structure (e.g. straight-line accel runs). */
  lapConfig: LapDetectionConfig;
  /** Cached LapSet computed from lapConfig + this session's data. Null when
   *  detection hasn't been run yet, or when lapConfig.mode === "none". */
  laps: LapSet | null;
  /** Canonical-id → source_header overrides. Mirrors what's set on the
   *  store. Persisted per-session in localStorage (channel-overrides.ts).
   *  Empty when the session is on full auto-resolution. */
  channelOverrides: Record<string, string>;
  /** Absolute filesystem path the session was loaded from. Set for
   *  user-opened files; undefined for bundled samples (which are bundled by
   *  resource id, not file path). Used to drive the recent-sessions
   *  persistence list — removal hands this back so we can drop the file
   *  from "load on next boot." */
  sourcePath?: string;
  /** The loader-derived label, preserved before any custom label overwrote
   *  `label`. Stamped by applySessionMeta on first pass, which is what makes
   *  re-applying idempotent and lets clearing a rename restore the original.
   *  Undefined only before that first pass. The SessionPanel surfaces it in
   *  the row tooltip so a renamed session still says which file it came from. */
  defaultLabel?: string;
}

/** Distinct colors for overlay traces; first session gets first color, etc. */
export const SESSION_PALETTE = [
  "#FFC627", // brand yellow
  "#4FC3F7", // cyan
  "#66BB6A", // green
  "#EF5350", // red
  "#BA68C8", // purple
  "#FFB800", // orange
  "#9CCC65", // light green
  "#26A69A", // teal
];

export function colorForIndex(i: number): string {
  return SESSION_PALETTE[i % SESSION_PALETTE.length]!;
}

/** Apply the user's saved per-session overrides (label / color / visibility)
 *  on top of a loaded session list. PURE — returns a new array, mutates
 *  nothing, touches no React state — so it runs as a post-pass wherever
 *  sessions are committed (boot, add-files, rename, recolor) and is unit
 *  testable without a DOM.
 *
 *  COLOR: a saved color WINS over the positional assignment; a session with no
 *  saved color gets colorForIndex(position) — deliberately the same rule
 *  mergeSessionsWithColors applies. Re-deriving the positional color here
 *  (rather than trusting whatever color the input array carries) is what makes
 *  "auto" work: clearing the override snaps the session straight back to its
 *  slot color with no extra bookkeeping. Two sessions CAN end up sharing a
 *  color if the user pins one to the palette entry another holds
 *  positionally — that's the user's explicit call, not a conflict to
 *  auto-resolve.
 *
 *  LABEL: the loader-derived label is preserved in `defaultLabel` on the first
 *  pass, so re-application is idempotent and a cleared rename restores the
 *  filename. A saved label that is empty/whitespace is ignored rather than
 *  blanking the row.
 *
 *  VISIBILITY: an absent saved flag leaves the loader's own choice alone.
 *  User-opened files load visible, so "default true when absent" holds for
 *  them; bundled samples keep their opt-in overlay default (only the first is
 *  visible) instead of all being force-shown.
 *
 *  `lookup` is injectable purely so unit tests don't need localStorage. */
export function applySessionMeta(
  sessions: LoadedSession[],
  lookup: (id: string) => SessionMeta | null = loadSessionMeta,
): LoadedSession[] {
  return sessions.map((s, i) => {
    const base = s.defaultLabel ?? s.label;
    const meta = lookup(s.id);
    const custom = meta?.label?.trim();
    const label = custom !== undefined && custom.length > 0 ? custom : base;
    const color = meta?.color ?? colorForIndex(i);
    const visible = meta?.visible ?? s.visible;
    // Preserve object identity when nothing changed, matching
    // mergeSessionsWithColors — keeps React reconciliation cheap.
    if (s.label === label && s.color === color && s.visible === visible && s.defaultLabel === base) {
      return s;
    }
    return { ...s, label, color, visible, defaultLabel: base };
  });
}
