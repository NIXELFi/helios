import { create } from "zustand";

/**
 * App-level preferences — one versioned blob under `helios:prefs`, per
 * machine (autostart, close behaviour and data folders are machine facts, so
 * nothing here syncs to the account). Read once at boot; every write goes
 * through `update()` so the store and localStorage never disagree.
 *
 * Add a field: extend `Prefs`, give it a default, and (if it isn't a plain
 * boolean/string that `sanitize` can validate structurally) extend
 * `sanitize`. Older blobs deep-merge over the defaults, so no migration is
 * needed for additive changes; bump `v` only for a breaking reshape.
 */

export const PREFS_KEY = "helios:prefs";
const PREFS_VERSION = 1;

export type LandingPref = "pm" | "logs" | "last";
export type ThemePref = "system" | "dark" | "light";
export type NotificationSource = "vault" | "updates";

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" 24 h, local time. */
  start: string;
  end: string;
}

export interface Prefs {
  /** Dark (the Helios default), light, or follow the OS. */
  theme: ThemePref;
  /** Which module a signed-in launch opens on. */
  landing: LandingPref;
  /** Module the user was on last — what `landing: "last"` reopens. */
  lastModule: string | null;
  /** Close button hides to the tray (keeps the SOLIDWORKS bridge live) or quits. */
  closeToTray: boolean;
  /** Install + restart on its own when an update is found (after a short
   *  visible countdown) instead of waiting for the user to click Install. */
  autoUpdate: boolean;
  notifications: {
    enabled: boolean;
    vault: boolean;
    updates: boolean;
    quiet: QuietHours;
  };
}

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  landing: "pm",
  lastModule: null,
  closeToTray: true,
  autoUpdate: true,
  notifications: {
    enabled: true,
    vault: true,
    updates: true,
    quiet: { enabled: false, start: "22:00", end: "07:00" },
  },
};

const LANDING: ReadonlySet<string> = new Set<LandingPref>(["pm", "logs", "last"]);
const THEMES: ReadonlySet<string> = new Set<ThemePref>(["system", "dark", "light"]);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Validate an untrusted (stored / partial) object into a full Prefs. */
export function sanitize(raw: unknown): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (r.notifications && typeof r.notifications === "object" ? r.notifications : {}) as Record<string, unknown>;
  const q = (n.quiet && typeof n.quiet === "object" ? n.quiet : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    theme: typeof r.theme === "string" && THEMES.has(r.theme) ? (r.theme as ThemePref) : d.theme,
    landing: typeof r.landing === "string" && LANDING.has(r.landing) ? (r.landing as LandingPref) : d.landing,
    lastModule: typeof r.lastModule === "string" ? r.lastModule : null,
    closeToTray: bool(r.closeToTray, d.closeToTray),
    autoUpdate: bool(r.autoUpdate, d.autoUpdate),
    notifications: {
      enabled: bool(n.enabled, d.notifications.enabled),
      vault: bool(n.vault, d.notifications.vault),
      updates: bool(n.updates, d.notifications.updates),
      quiet: {
        enabled: bool(q.enabled, d.notifications.quiet.enabled),
        start: typeof q.start === "string" && HHMM.test(q.start) ? q.start : d.notifications.quiet.start,
        end: typeof q.end === "string" && HHMM.test(q.end) ? q.end : d.notifications.quiet.end,
      },
    },
  };
}

export function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return sanitize(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ v: PREFS_VERSION, ...p }));
  } catch {
    // quota / private mode — the in-memory store still holds the value.
  }
}

/** Partial update shape: one level of nesting for `notifications`. */
export type PrefsPatch = Partial<Omit<Prefs, "notifications">> & {
  notifications?: Partial<Omit<Prefs["notifications"], "quiet">> & { quiet?: Partial<QuietHours> };
};

interface PrefsStore {
  prefs: Prefs;
  update: (patch: PrefsPatch) => void;
}

export const usePrefs = create<PrefsStore>((set, get) => ({
  prefs: readPrefs(),
  update: (patch) => {
    const cur = get().prefs;
    const next: Prefs = sanitize({
      ...cur,
      ...patch,
      notifications: {
        ...cur.notifications,
        ...(patch.notifications ?? {}),
        quiet: { ...cur.notifications.quiet, ...(patch.notifications?.quiet ?? {}) },
      },
    });
    writePrefs(next);
    set({ prefs: next });
  },
}));

/** Non-hook read for code outside React (notification helper, boot). */
export function getPrefs(): Prefs {
  return usePrefs.getState().prefs;
}

function minutes(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** True while inside the quiet window. A window that ends before it starts
 *  wraps midnight (22:00 → 07:00). start === end is treated as "no window". */
export function isQuietNow(q: QuietHours, now: Date = new Date()): boolean {
  if (!q.enabled) return false;
  const s = minutes(q.start);
  const e = minutes(q.end);
  if (s === e) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return s < e ? t >= s && t < e : t >= s || t < e;
}

export function notificationAllowed(source: NotificationSource, p: Prefs = getPrefs(), now: Date = new Date()): boolean {
  const n = p.notifications;
  if (!n.enabled) return false;
  if (!n[source]) return false;
  if (isQuietNow(n.quiet, now)) return false;
  return true;
}
