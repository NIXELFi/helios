import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

/** Lifecycle of the update checker, surfaced to the UI as a discriminated
 *  union so the header pill can pattern-match. */
export type UpdaterState =
  | { kind: "checking" }
  | { kind: "up_to_date";  current: string }
  | { kind: "available";   update: UpdaterAvailable }
  | { kind: "downloading"; update: UpdaterAvailable; downloaded: number; total: number | null }
  | { kind: "installing";  update: UpdaterAvailable }
  /** New bundle is on disk but we couldn't restart the app for the user; they
   *  must relaunch Helios by hand. NOT an error — the update did land. */
  | { kind: "installed";   version: string }
  | { kind: "offline";     error: string };

export interface UpdaterAvailable {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
  /** Tauri's Update handle; not exposed to UI. */
  _handle: Update;
}

export interface UpdaterApi {
  state: UpdaterState;
  /** Re-run the manifest check; transitions through `checking`. */
  recheck: () => void;
  /** Download + install + relaunch. Only valid when state.kind === 'available'. */
  installAndRelaunch: () => Promise<void>;
}

export function useUpdater(): UpdaterApi {
  const [state, setState] = useState<UpdaterState>({ kind: "checking" });
  // Tracks whether a check is already in flight so manual rechecks during an
  // initial check don't fire twice. Refs (not state) so toggling doesn't
  // re-render the consumer.
  const checkingRef = useRef(false);

  const runCheck = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setState({ kind: "checking" });
    try {
      const update = await check();
      if (update) {
        setState({
          kind: "available",
          update: {
            version: update.version,
            currentVersion: update.currentVersion,
            notes: update.body ?? null,
            date: update.date ?? null,
            _handle: update,
          },
        });
      } else {
        // `check()` returns null when the app is already on the latest version.
        // We still want to surface the current version in the UI.
        const currentVersion = await getCurrentVersionSafe();
        setState({ kind: "up_to_date", current: currentVersion });
      }
    } catch (e) {
      setState({ kind: "offline", error: String(e) });
    } finally {
      checkingRef.current = false;
    }
  };

  // Auto-check ~3s after mount so the splash isn't blocked on a network call.
  useEffect(() => {
    const handle = setTimeout(runCheck, 3000);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installAndRelaunch = async () => {
    if (state.kind !== "available") return;
    const handle = state.update._handle;
    let downloaded = 0;
    let total: number | null = null;
    setState({ kind: "downloading", update: state.update, downloaded, total });
    try {
      await handle.downloadAndInstall((event) => {
        // Tauri emits "Started" → many "Progress" → "Finished".
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setState({ kind: "downloading", update: state.update, downloaded, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setState({ kind: "downloading", update: state.update, downloaded, total });
        } else if (event.event === "Finished") {
          setState({ kind: "installing", update: state.update });
        }
      });
      // Once downloadAndInstall resolves the new bundle is in place. Use
      // our custom restart command on macOS — it strips quarantine, uses
      // `open -na` for proper LaunchServices registration, and sleeps
      // before exiting so the new app actually appears in the foreground.
      // Tauri's plugin-process `relaunch()` races with macOS LaunchServices
      // and frequently produces a "ghost launch" where the old window
      // disappears but the new one never shows.
      try {
        await invoke("helios_relaunch");
      } catch {
        // The restart failed (e.g. an older build that predates the command).
        // There is no fallback: tauri-plugin-process isn't bundled, so calling
        // its relaunch() would just throw "plugin process not found" and land
        // the user on a false "offline" error. The new bundle IS installed, so
        // say exactly that and ask for a manual restart.
        setState({ kind: "installed", version: state.update.version });
      }
    } catch (e) {
      setState({ kind: "offline", error: String(e) });
    }
  };

  return { state, recheck: runCheck, installAndRelaunch };
}

async function getCurrentVersionSafe(): Promise<string> {
  try {
    return await getVersion();
  } catch { return ""; }
}
