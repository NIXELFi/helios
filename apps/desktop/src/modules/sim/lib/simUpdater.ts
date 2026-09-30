/* Keeping the simulator current without anybody asking -- app-wide.
 *
 * The build feed used to be consulted only when no simulator could be found,
 * then only offered as a banner with a button, then read whenever the Sim
 * module was up. Each left rigs behind: a fix published to the feed reached
 * the machines where somebody happened to open that module, which at a test
 * day is not the rig in the corner that is only ever used to drive.
 *
 * So this lives outside every module, as one updater per app process:
 *
 *   startup    the shell checks once when Helios starts
 *   timer      and every five minutes after, whatever realtime is doing
 *   signal    `sim/tools/publish_build.mjs` broadcasts on the realtime channel
 *              the moment a build is on the feed, and every running Helios
 *              checks within seconds (see `useSimReleaseSignal`)
 *   reconnect  a rig that was offline when that went out checks when its
 *              realtime connection comes back
 *   module     opening the Sim module checks, as it always has
 *
 * The message is only a nudge. Whatever arrives on the channel, this re-reads
 * the feed and the backend installs only what the FEED names, verified against
 * its SHA-256 -- so a forged or replayed message can make Helios look at the
 * feed, never install anything the feed did not already say.
 *
 * Difference, not order. Rolling the feed back to a build known to work at an
 * event has to roll every rig back with it, and a comparison that only moved
 * forward would leave them on the build being rolled away from.
 */
import {
  onSimInstallProgress, simAvailableBuild, simInstall, simStatus,
  type SimBuild, type SimStatus,
} from "../api";

export interface SimUpdaterState {
  /** What the feed offers for this machine, once it has answered. */
  build: SimBuild | null;
  /** A different build is being fetched and installed right now. */
  installing: boolean;
  /** Bytes fetched so far while installing. */
  got: number;
  /** Why the last install failed, if it did. Cleared by `retrySimUpdate`. */
  error: string | null;
  /** The feed could not be read. A rig at a test day is offline as a matter
   *  of course, so this is information, not an error. */
  feedError: string | null;
  /** A version this process installed, so the panel can say so. */
  installed: string | null;
  /** Bumped on every install, so a view holding a status knows to re-read it. */
  installSeq: number;
}

export type CheckReason = "startup" | "timer" | "module" | "signal" | "reconnect" | "retry";

/**
 * Signals closer together than this are coalesced into one trailing check.
 *
 * Anyone holding the public key can send on a public channel, and a release
 * sends one message per publish. Without a floor, a stuck publisher or a
 * prankster would have every rig on the team re-reading the feed as fast as
 * messages arrived. With it, the worst case is one feed read per rig per
 * interval -- and the trailing check means a real second message inside the
 * window (macOS published a minute after Windows) is still acted on.
 */
export const SIGNAL_MIN_INTERVAL_MS = 15_000;

const EMPTY: SimUpdaterState = {
  build: null, installing: false, got: 0, error: null, feedError: null, installed: null, installSeq: 0,
};

let state: SimUpdaterState = EMPTY;
const listeners = new Set<() => void>();

function set(patch: Partial<SimUpdaterState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribeSimUpdater(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSimUpdaterState(): SimUpdaterState {
  return state;
}

/** What `fsae-sim --version` prints, reduced to the version itself. */
export function installedVersion(status: SimStatus | null): string | null {
  const raw = status?.version?.trim();
  if (!raw) return null;
  return raw.split(/\s+/).pop() ?? null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Versions this process has already tried to install. One attempt per
 * version per app session, or a feed that names a build the installer
 * refuses (a hash that does not match, say) would be retried on every signal.
 * `retrySimUpdate` clears the entry.
 */
const attempted = new Set<string>();

let inFlight: Promise<void> | null = null;
/** Asked for while a check was running; run once more when it finishes. */
let again: { known: SimStatus | null | undefined } | null = null;
let lastSignalAt = -Infinity;
let trailing: ReturnType<typeof setTimeout> | null = null;

/**
 * Check the feed and install what it names, if that differs from what is
 * installed.
 *
 * `known` is the caller's own reading of the installed simulator, when it
 * has one (the Sim module does); without it the status is read here. Never
 * installs on a machine with no simulator: the first install is the
 * not-installed panel's opt-in, because a machine that never wanted the
 * simulator should not be handed one by a message.
 */
export function requestSimUpdateCheck(reason: CheckReason, known?: SimStatus | null): Promise<void> {
  if (reason === "signal" || reason === "reconnect") {
    const now = Date.now();
    const wait = lastSignalAt + SIGNAL_MIN_INTERVAL_MS - now;
    if (wait > 0) {
      trailing ??= setTimeout(() => {
        trailing = null;
        lastSignalAt = Date.now();
        void run(undefined);
      }, wait);
      return Promise.resolve();
    }
    lastSignalAt = now;
  }
  return run(known);
}

function run(known: SimStatus | null | undefined): Promise<void> {
  if (inFlight) {
    // The latest caller's reading wins; `undefined` means "read it yourself".
    again = { known: known ?? again?.known };
    return inFlight;
  }
  inFlight = check(known).finally(() => {
    inFlight = null;
    const next = again;
    again = null;
    if (next) void run(next.known);
  });
  return inFlight;
}

async function check(known: SimStatus | null | undefined): Promise<void> {
  let build: SimBuild | null;
  try {
    build = await simAvailableBuild();
    set({ build, feedError: null });
  } catch (e) {
    set({ feedError: message(e) });
    return;
  }
  if (!build || state.installing) return;

  let st = known;
  if (st === undefined) {
    try { st = await simStatus(); } catch { return; }
  }
  const have = installedVersion(st ?? null);
  if (!st?.exePath || !have || build.version === have) return;
  if (attempted.has(build.version)) return;
  attempted.add(build.version);

  const version = build.version;
  set({ installing: true, got: 0, error: null });
  const off = onSimInstallProgress((p) => set({ got: p.bytes }));
  try {
    await simInstall(version);
    set({ installed: version, installSeq: state.installSeq + 1 });
  } catch (e) {
    set({ error: message(e) });
  } finally {
    off();
    set({ installing: false });
  }
}

/** Read the feed again and, if it still differs, install again. */
export function retrySimUpdate(known?: SimStatus | null): Promise<void> {
  if (state.build) attempted.delete(state.build.version);
  set({ error: null });
  return requestSimUpdateCheck("retry", known);
}

/** For tests: forget everything. */
export function resetSimUpdater(): void {
  attempted.clear();
  if (trailing) clearTimeout(trailing);
  trailing = null;
  inFlight = null;
  again = null;
  lastSignalAt = -Infinity;
  state = EMPTY;
  for (const l of listeners) l();
}
