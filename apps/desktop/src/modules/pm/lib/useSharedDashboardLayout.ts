// Shared dashboard layout data layer.
//
// The tabs/widgets of a dashboard scope are one layout shared by the whole
// team: stored in `pm.dashboard_layouts` (one row per scope), editable only by
// holders of the `pm.manage_dashboard` capability in that scope (Lead/VP of
// the subteam, or Executive/Owner for the all-team dashboard) — read by
// everyone. Mirrors useDashboardPhotos (capability check, active-flag
// cleanup, `client.schema("pm")` access style) with a cache twist:
// localStorage keeps the last-adopted layout so the dashboard still renders
// with the layout you last saw when the network is down, and the active tab
// stays a per-user preference (switching tabs never writes to the server).
//
// Durability model: every unsaved structural edit raises a localStorage
// "pending" marker that only a confirmed server save clears. If the app quits
// (or the network drops) mid-save, the next launch sees the marker, treats the
// local cache as newer than the server row, and re-publishes it instead of
// adopting the stale copy over it. A scope with no shared row yet gets
// bootstrapped from the first editor's local layout, so permanence doesn't
// wait for someone to make an edit.
//
// Concurrency is last-write-wins on the whole layout; two editors saving at
// once is rare enough (and the loser's state recoverable enough) that a merge
// story isn't worth its weight. Other open clients pick the new layout up on
// their next dashboard mount — no realtime push.
//
// The mount site keys this component per scope (see PmModule), but the hook
// also hard-resets itself when the scope props change without a remount, so a
// missing key can never leak one scope's tabs into another scope's row.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { scopeKey } from "@pm/lib/nav";
import { usePmStore } from "@pm/lib/pmStore";
import {
  adoptSharedTabs,
  backupPreSharedConfig,
  clearLayoutSavePending,
  hasLayoutSavePending,
  markLayoutSavePending,
  normalizeSharedTabs,
  recallDashboardConfig,
  rememberDashboardConfig,
  sharedDashboardPayload,
  type DashboardConfig,
  type DashboardTab,
} from "@pm/lib/dashboardSettings";

const SAVE_DEBOUNCE_MS = 800;

// loading    → first fetch in flight (cached/default layout already showing)
// synced     → showing the shared layout (or our save of it) from the server
// none       → no shared layout exists yet for this scope; showing local/default
// offline    → fetch failed; showing the cached copy (nothing was lost)
// saving     → a shared save is in flight
// save_error → the last save failed; edits are safe locally, retry() re-sends
export type SharedLayoutStatus = "loading" | "synced" | "none" | "offline" | "saving" | "save_error";

export interface UseSharedDashboardLayoutResult {
  config: DashboardConfig;
  setConfig: (updater: (c: DashboardConfig) => DashboardConfig) => void;
  canEdit: boolean;
  status: SharedLayoutStatus;
  retry: () => void;
}

export function useSharedDashboardLayout({
  subteamId,
  teamSlug,
  isSubteamScope,
}: {
  subteamId: string | null;
  teamSlug: string | null;
  isSubteamScope: boolean;
}): UseSharedDashboardLayoutResult {
  const client = useSupabaseClient();
  const currentUserId = usePmStore((s) => s.currentUserId);
  const scope = scopeKey(teamSlug);

  const [config, setConfigState] = useState(() => recallDashboardConfig(teamSlug, isSubteamScope));
  const [canEdit, setCanEdit] = useState(false);
  const [status, setStatus] = useState<SharedLayoutStatus>("loading");

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The latest config, for the debounced save (which outlives render closures).
  const configRef = useRef(config);
  // Tabs the persist-effect last acted on — reference identity marks structure.
  const lastTabsRef = useRef(config.tabs);
  // True while a local edit hasn't been confirmed saved. Starts true when a
  // previous session left a pending marker: the cache is newer than the server.
  const dirtyRef = useRef(hasLayoutSavePending(teamSlug));
  // True once ANY local structural edit happened this mount. A slow initial
  // fetch must never adopt over local edits — checking dirtyRef alone isn't
  // enough, because a fast save can clear it before the stale fetch lands.
  const editedRef = useRef(dirtyRef.current);
  // Dirty-from-marker (not from an edit made this session): if the capability
  // check says we can't actually save, this recovery is abandoned gracefully.
  const recoveryRef = useRef(dirtyRef.current);
  // The exact tabs array adopted from the server — the persist-effect uses its
  // identity to tell a server-originated change from a user edit, so an edit
  // landing in the same React batch can never be mistaken for the adopt.
  const adoptedTabsRef = useRef<DashboardTab[] | null>(null);
  // The server's tabs, kept for late adoption (e.g. a recovery that turns out
  // to be unsaveable because the capability check came back false).
  const fetchedTabsRef = useRef<DashboardTab[] | null>(null);
  const bootstrapRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards async completions from mutating refs that now belong to a new scope.
  const scopeRef = useRef(scope);

  // --- Scope change without a remount: hard reset -----------------------------
  // (Render-phase same-component state reset — the sanctioned React pattern.)
  const [mountedScope, setMountedScope] = useState(scope);
  if (scope !== mountedScope) {
    if (timerRef.current) {
      // Dropping the old scope's debounce is safe: its pending marker survives
      // and the next visit to that scope re-publishes the cached copy.
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const fresh = recallDashboardConfig(teamSlug, isSubteamScope);
    setMountedScope(scope);
    setConfigState(fresh);
    setCanEdit(false);
    setStatus("loading");
    configRef.current = fresh;
    lastTabsRef.current = fresh.tabs;
    dirtyRef.current = hasLayoutSavePending(teamSlug);
    editedRef.current = dirtyRef.current;
    recoveryRef.current = dirtyRef.current;
    adoptedTabsRef.current = null;
    fetchedTabsRef.current = null;
    bootstrapRef.current = false;
    scopeRef.current = scope;
  }
  configRef.current = config;

  // --- Save (debounced) ------------------------------------------------------
  const flush = useCallback(async () => {
    if (!dirtyRef.current) return;
    const token = scopeRef.current;
    if (mountedRef.current) setStatus("saving");
    try {
      const res = await client.schema("pm").rpc("save_dashboard_layout", {
        stid: subteamId,
        cfg: sharedDashboardPayload(configRef.current),
      });
      if (res.error) throw new Error(res.error.message);
      // The save landed for the scope it was issued in; its marker is cleared
      // unconditionally, but shared refs/state belong to the current scope.
      clearLayoutSavePending(teamSlug);
      if (scopeRef.current !== token) return;
      dirtyRef.current = false;
      recoveryRef.current = false;
      if (mountedRef.current) setStatus("synced");
    } catch {
      if (scopeRef.current !== token) return;
      if (mountedRef.current) setStatus("save_error");
    }
  }, [client, subteamId, teamSlug]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // A pending edit shouldn't die with the component (navigating away right
  // after a tweak is the normal case, not the edge case). Best-effort: if the
  // webview closes before the RPC lands, the pending marker recovers it.
  // The token check matters on a scope change WITHOUT a remount: this cleanup
  // runs after the render-phase reset repointed the shared refs at the new
  // scope, and firing the old flush then would write the new scope's config to
  // the old scope's row. Skipping is safe — the old scope's pending marker
  // survives and re-publishes on the next visit.
  useEffect(() => {
    const token = scopeRef.current;
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (scopeRef.current === token && dirtyRef.current) void flush();
    };
  }, [flush]);

  const retry = useCallback(() => {
    void flush();
  }, [flush]);

  // --- Load the shared layout ------------------------------------------------
  useEffect(() => {
    let active = true;
    setStatus("loading");
    void (async () => {
      try {
        let q = client.schema("pm").from("dashboard_layouts").select("config");
        q = subteamId === null ? q.is("subteam_id", null) : q.eq("subteam_id", subteamId);
        const res = await q.maybeSingle();
        if (!active) return;
        if (res.error) {
          setStatus("offline");
          return;
        }
        if (!res.data) {
          setStatus("none");
          return;
        }
        const tabs = normalizeSharedTabs((res.data as { config: unknown }).config);
        if (!tabs) {
          setStatus("none");
          return;
        }
        fetchedTabsRef.current = tabs;
        // An unsaved local layout wins over the fetch — an edit made while it
        // was in flight, one already saved (the fetch's copy is older than
        // that save), or one recovered from a previous session's marker.
        if (dirtyRef.current || editedRef.current) return;
        backupPreSharedConfig(teamSlug);
        adoptedTabsRef.current = tabs;
        setConfigState((prev) => adoptSharedTabs(prev, tabs));
        setStatus("synced");
      } catch {
        if (active) setStatus("offline");
      }
    })();
    return () => {
      active = false;
    };
  }, [client, subteamId, teamSlug]);

  // --- Capability check (manage-dashboard for this scope) --------------------
  useEffect(() => {
    let active = true;
    setCanEdit(false);
    if (!currentUserId) return;
    void (async () => {
      try {
        const res = await client.schema("pm").rpc("has_capability", {
          uid: currentUserId,
          cap: "pm.manage_dashboard",
          stid: subteamId,
        });
        if (!active) return;
        if (res.error) return;
        if (res.data === true) {
          setCanEdit(true);
          // A layout recovered from a previous session's marker can now
          // actually be saved — send it.
          if (dirtyRef.current) schedule();
          return;
        }
        setCanEdit(false);
        // A recovery we can't save (capability was revoked since): abandon it
        // and fall back to the server's copy when there is one.
        if (recoveryRef.current) {
          recoveryRef.current = false;
          dirtyRef.current = false;
          editedRef.current = false;
          clearLayoutSavePending(teamSlug);
          const tabs = fetchedTabsRef.current;
          if (tabs) {
            backupPreSharedConfig(teamSlug);
            adoptedTabsRef.current = tabs;
            setConfigState((prev) => adoptSharedTabs(prev, tabs));
            setStatus("synced");
          }
        }
      } catch {
        if (active) setCanEdit(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, currentUserId, subteamId, teamSlug, schedule]);

  // --- Bootstrap a scope that has no shared row yet ---------------------------
  // Permanence shouldn't wait for an edit: the first editor to open the
  // dashboard publishes their current layout (their pre-shared customization,
  // or the defaults) as the shared row.
  useEffect(() => {
    if (status !== "none" || !canEdit || bootstrapRef.current) return;
    bootstrapRef.current = true;
    dirtyRef.current = true;
    markLayoutSavePending(teamSlug);
    schedule();
  }, [status, canEdit, teamSlug, schedule]);

  // --- Persist + detect structural change ------------------------------------
  // Every config change lands in the localStorage cache. A change to the tabs
  // *reference* is structural (the update helpers only mint a new array when
  // something actually changed) and — unless those tabs are the very array
  // adopted from the server — raises the pending marker and schedules a save.
  // activeTabId-only changes never save.
  useEffect(() => {
    rememberDashboardConfig(teamSlug, config);
    if (config.tabs === lastTabsRef.current) return;
    lastTabsRef.current = config.tabs;
    if (config.tabs === adoptedTabsRef.current) return;
    dirtyRef.current = true;
    editedRef.current = true;
    markLayoutSavePending(teamSlug);
    schedule();
  }, [config, teamSlug, schedule]);

  const setConfig = useCallback((updater: (c: DashboardConfig) => DashboardConfig) => {
    setConfigState((prev) => {
      const next = updater(prev);
      return next === prev ? prev : next;
    });
  }, []);

  return { config, setConfig, canEdit, status, retry };
}
