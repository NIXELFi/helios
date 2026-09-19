/* Keeping the simulator current without anybody asking.
 *
 * The build feed used to be consulted only when no simulator could be found,
 * then only offered as a banner with a button. Both left rigs behind: a fix
 * published to the feed reached the machines whose drivers noticed the
 * banner and pressed it, which at a test day is none of them. Now the feed
 * is read whenever the module is up, and a build that is not the one
 * installed is fetched, verified and installed on its own. The driver sees a
 * progress line, and the launch waits for it.
 *
 * Difference, not order. Rolling the feed back to a build known to work at an
 * event has to roll every rig back with it, and a comparison that only moved
 * forward would leave them on the build being rolled away from.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  onSimInstallProgress, simAvailableBuild, simInstall, simStatus,
  type SimBuild, type SimStatus,
} from "../api";

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

/** What `fsae-sim --version` prints, reduced to the version itself. */
export function installedVersion(status: SimStatus | null): string | null {
  const raw = status?.version?.trim();
  if (!raw) return null;
  return raw.split(/\s+/).pop() ?? null;
}

/**
 * Versions this process has already tried to install. One attempt per
 * version per app session, or a feed that names a build the installer
 * refuses (a hash that does not match, say) would be retried every time
 * the module re-rendered. `retry` clears the entry.
 */
const attempted = new Set<string>();

/** For tests: forget what has been attempted. */
export function resetAutoUpdateAttempts(): void {
  attempted.clear();
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useSimAutoUpdate(
  status: SimStatus | null,
  onStatusChange: (s: SimStatus) => void,
  enabled = true,
): AutoUpdateState {
  const [build, setBuild] = useState<SimBuild | null>(null);
  const [installing, setInstalling] = useState(false);
  const [got, setGot] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);
  const [pass, setPass] = useState(0);

  const have = installedVersion(status);
  const hasExe = !!status?.exePath;

  // Read the feed once per mount, and again on retry.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    simAvailableBuild()
      .then((b) => { if (!cancelled) { setBuild(b); setFeedError(null); } })
      .catch((e) => { if (!cancelled) setFeedError(message(e)); });
    return () => { cancelled = true; };
  }, [enabled, pass]);

  // Install when what the feed names is not what is installed. Only when
  // something IS installed: the first install is the not-installed panel's
  // opt-in, because a machine that never wanted the simulator should not be
  // handed one by opening the tab.
  const busy = useRef(false);
  useEffect(() => {
    if (!enabled || !build || !hasExe || !have || build.version === have) return;
    if (busy.current || attempted.has(build.version)) return;
    attempted.add(build.version);
    busy.current = true;
    setInstalling(true);
    setGot(0);
    setError(null);
    const off = onSimInstallProgress((p) => setGot(p.bytes));
    const version = build.version;
    simInstall(version)
      .then(async () => {
        setInstalled(version);
        onStatusChange(await simStatus());
      })
      .catch((e) => setError(message(e)))
      .finally(() => {
        off();
        busy.current = false;
        setInstalling(false);
      });
  }, [enabled, build, hasExe, have, onStatusChange, pass]);

  const retry = useCallback(() => {
    if (build) attempted.delete(build.version);
    setError(null);
    setPass((p) => p + 1);
  }, [build]);

  return { build, installing, got, error, feedError, installed, retry };
}
