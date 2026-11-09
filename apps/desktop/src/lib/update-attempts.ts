/**
 * Remembers which updates Helios has already handed to the installer, so an
 * install that never lands can't turn auto-update into a loop.
 *
 * On Windows the updater launches the installer and quits; the installer is
 * meant to replace Helios and reopen it. If the install doesn't take
 * (antivirus or SmartScreen blocks the downloaded installer, an older second
 * copy is the one that starts at login, …) the reopened Helios is still on the
 * old version, finds the same update, counts down and launches the installer
 * again -- forever, and again at every boot. A team member's laptop did exactly
 * that until it fell over.
 *
 * So: record the attempt just before the hand-off. When Helios starts up still
 * on the version it was updating FROM, the attempt didn't land. After
 * AUTO_INSTALL_ATTEMPT_LIMIT of those, auto-install stops for that release and
 * the update dialog says so and points at the manual download instead. A
 * click on "Install and restart" still works -- that's the user choosing to
 * try again, once per click.
 *
 * Per-viewer localStorage is the right home: the question is "did THIS
 * install of Helios fail to update", and losing the record (private profile,
 * cleared data) only costs one more automatic try.
 */

const KEY = "helios.updater.installAttempts";

/** Automatic installs per release before auto-update gives up on it. Two, not
 *  one, so a single transient failure (the user closed the installer, a
 *  locked file) still gets one quiet retry. */
export const AUTO_INSTALL_ATTEMPT_LIMIT = 2;

/** Where a user can grab the installer by hand. */
export const MANUAL_DOWNLOAD_URL = "https://github.com/NIXELFi/helios/releases/latest";

interface Attempt {
  /** The version Helios was on when it launched the installer. */
  from: string;
  count: number;
  lastAt: number;
}
type Store = Record<string, Attempt>; // keyed by the target version

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    if (Object.keys(store).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable: worst case is one more automatic try */
  }
}

/** Call right before handing `target` to the installer while on `from`. */
export function recordInstallAttempt(target: string, from: string, now = Date.now()): void {
  const store = load();
  const prev = store[target];
  const count = prev && prev.from === from ? prev.count + 1 : 1;
  store[target] = { from, count, lastAt: now };
  save(store);
}

/** Undo the latest record when the hand-off never happened (the download or
 *  signature check threw, so Helios didn't quit and nothing was installed). */
export function retractInstallAttempt(target: string, from: string): void {
  const store = load();
  const prev = store[target];
  if (!prev || prev.from !== from) return;
  if (prev.count <= 1) delete store[target];
  else store[target] = { ...prev, count: prev.count - 1 };
  save(store);
}

/** Installs of `target` that were handed off from `current` -- and, since
 *  we're evidently still on `current`, didn't land. */
export function failedInstallAttempts(target: string, current: string): number {
  const a = load()[target];
  return a && a.from === current ? a.count : 0;
}

/** May auto-update install `target` again without a click? */
export function autoInstallAllowed(target: string, current: string): boolean {
  return failedInstallAttempts(target, current) < AUTO_INSTALL_ATTEMPT_LIMIT;
}

/** Drop records that no longer describe this install: an update that landed
 *  (we're now on its version) or one attempted from a version we've since
 *  left. Keeps the store to at most the release currently being fought over. */
export function forgetSettledAttempts(current: string): void {
  const store = load();
  let changed = false;
  for (const [target, a] of Object.entries(store)) {
    if (target === current || a.from !== current) {
      delete store[target];
      changed = true;
    }
  }
  if (changed) save(store);
}
