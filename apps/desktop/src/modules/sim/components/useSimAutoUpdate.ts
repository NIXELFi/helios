/* The Sim module's view of the simulator updater.
 *
 * The updater itself is app-wide and lives in `lib/simUpdater.ts`: it checks
 * the feed when Helios starts, when a release is broadcast, and when a
 * realtime connection comes back, whether or not this module was ever opened.
 * This hook adds what the module needs on top: a check when the module comes
 * up (with the status it already holds), and a fresh status once something
 * has been installed, so the version on screen changes with it.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { SimBuild, SimStatus } from "../api";
import {
  getSimUpdaterState, installedVersion, requestSimUpdateCheck, resetSimUpdater, retrySimUpdate,
  subscribeSimUpdater,
} from "../lib/simUpdater";
import { simStatus } from "../api";

export { installedVersion };

export interface AutoUpdateState {
  /** What the feed offers for this machine, once it has answered. */
  build: SimBuild | null;
  /** A different build is being fetched and installed right now. */
  installing: boolean;
  /** Bytes fetched so far while installing. */
  got: number;
  /** Why the last install failed, if it did. Cleared by `retry`. */
  error: string | null;
  /** The feed could not be read. A rig at a test day is offline as a matter
   *  of course, so this is information, not an error. */
  feedError: string | null;
  /** A version this session installed, so the panel can say so. */
  installed: string | null;
  /** Read the feed again and, if it still differs, install again. */
  retry: () => void;
}

/** For tests: forget what has been attempted, and everything else. */
export function resetAutoUpdateAttempts(): void {
  resetSimUpdater();
}

export function useSimAutoUpdate(
  status: SimStatus | null,
  onStatusChange: (s: SimStatus) => void,
  enabled = true,
): AutoUpdateState {
  const s = useSyncExternalStore(subscribeSimUpdater, getSimUpdaterState);
  const statusRef = useRef(status);
  statusRef.current = status;
  const have = installedVersion(status);
  const hasExe = !!status?.exePath;

  // Check when the module comes up, and again when what is installed comes
  // into view (the module's first status read lands after its first render).
  // A re-render alone is not a check, and so is never a retry.
  useEffect(() => {
    if (!enabled) return;
    void requestSimUpdateCheck("module", statusRef.current);
  }, [enabled, have, hasExe]);

  // Something was installed -- here or by the background updater while this
  // module sat on another tab: re-read the status so the module shows it.
  const seen = useRef(s.installSeq);
  const onStatusRef = useRef(onStatusChange);
  onStatusRef.current = onStatusChange;
  useEffect(() => {
    if (s.installSeq === seen.current) return;
    seen.current = s.installSeq;
    simStatus().then((st) => onStatusRef.current(st)).catch(() => {});
  }, [s.installSeq]);

  const retry = useCallback(() => { void retrySimUpdate(statusRef.current); }, []);

  return {
    build: s.build, installing: s.installing, got: s.got, error: s.error,
    feedError: s.feedError, installed: s.installed, retry,
  };
}
