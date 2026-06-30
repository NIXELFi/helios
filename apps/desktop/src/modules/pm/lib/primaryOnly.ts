// Per-user "primary subteam only" view preference.
//
// When ON, a subteam-scoped view (dashboard / table / board / calendar / gantt)
// shows only tasks whose PRIMARY subteam is the one in scope, hiding tasks where
// the subteam is merely a secondary contributor. OFF (the default) keeps the
// original behavior where every membership counts toward "owned".
//
// This is a personal, persistent preference — it lives only in localStorage (no
// server schema), mirroring the existing PM pref pattern (subteamVisibility,
// dashboardSettings). The flag itself is consumed by scopeTasksToSubteam in
// pmStore; this module only owns recall/remember + a tiny React hook.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "helios:pmPrimaryOnly";

/** Read the pref. Returns false on a missing entry or no `window` (SSR). Never throws. */
export function recallPrimaryOnly(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the pref. Best-effort: silently ignores SSR and storage failures. */
export function rememberPrimaryOnly(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

// In-process subscribers so EVERY usePrimaryOnly() caller re-renders when the
// pref flips, regardless of which component toggled it. The browser's own
// "storage" event only fires in OTHER tabs/windows (never the one that wrote),
// so we broadcast manually to keep the toggle and the scope computation in lock-
// step within the same window.
const listeners = new Set<(value: boolean) => void>();

/**
 * Read + set the "primary subteam only" preference. Returns [value, setValue].
 * Every mounted caller stays in sync, so a toggle in one view's filter bar and
 * the scope computation that reads the flag agree without prop-threading.
 */
export function usePrimaryOnly(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState<boolean>(recallPrimaryOnly);

  useEffect(() => {
    const onChange = (v: boolean) => setValue(v);
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const set = useCallback((v: boolean) => {
    rememberPrimaryOnly(v);
    for (const l of listeners) l(v);
  }, []);

  return [value, set];
}
