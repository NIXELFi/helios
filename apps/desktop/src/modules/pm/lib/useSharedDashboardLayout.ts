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
// Concurrency is last-write-wins on the whole layout; two editors saving at
// once is rare enough (and the loser's state recoverable enough) that a merge
// story isn't worth its weight. Other open clients pick the new layout up on
// their next dashboard mount — no realtime push.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { usePmStore } from "@pm/lib/pmStore";
import {
  adoptSharedTabs,
  normalizeSharedTabs,
  recallDashboardConfig,
  rememberDashboardConfig,
  sharedDashboardPayload,
  type DashboardConfig,
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
  configRef.current = config;
  // Tabs the persist-effect last acted on — reference identity marks structure.
  const lastTabsRef = useRef(config.tabs);
  // True while a local edit hasn't reached the server yet.
  const dirtyRef = useRef(false);
  // True once ANY local structural edit happened this mount. A slow initial
  // fetch must never adopt over local edits — checking dirtyRef alone isn't
  // enough, because a fast save can clear it before the stale fetch lands.
  const editedRef = useRef(false);
  // Set just before adopting server tabs so the persist-effect doesn't save
  // the server's own layout straight back to it.
  const adoptRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Save (debounced) ------------------------------------------------------
  const flush = useCallback(async () => {
    if (!dirtyRef.current) return;
    if (mountedRef.current) setStatus("saving");
    try {
      const res = await client.schema("pm").rpc("save_dashboard_layout", {
        stid: subteamId,
        cfg: sharedDashboardPayload(configRef.current),
      });
      if (res.error) throw new Error(res.error.message);
      dirtyRef.current = false;
      if (mountedRef.current) setStatus("synced");
    } catch {
      if (mountedRef.current) setStatus("save_error");
    }
  }, [client, subteamId]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  // A pending edit shouldn't die with the component (navigating away right
  // after a tweak is the normal case, not the edge case).
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (dirtyRef.current) void flush();
    },
    [flush],
  );

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
        // An edit made while the fetch was in flight wins over the fetch —
        // even one already saved (the fetch's copy is older than that save).
        if (dirtyRef.current || editedRef.current) return;
        adoptRef.current = true;
        setConfigState((prev) => adoptSharedTabs(prev, tabs));
        setStatus("synced");
      } catch {
        if (active) setStatus("offline");
      }
    })();
    return () => {
      active = false;
    };
  }, [client, subteamId]);

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
        if (!res.error) setCanEdit(res.data === true);
      } catch {
        if (active) setCanEdit(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, currentUserId, subteamId]);

  // --- Persist + detect structural change ------------------------------------
  // Every config change lands in the localStorage cache. A change to the tabs
  // *reference* is structural (the update helpers only mint a new array when
  // something actually changed) and — unless it came from adopting the server's
  // copy — schedules a shared save. activeTabId-only changes never save.
  useEffect(() => {
    rememberDashboardConfig(teamSlug, config);
    if (config.tabs === lastTabsRef.current) return;
    lastTabsRef.current = config.tabs;
    if (adoptRef.current) {
      adoptRef.current = false;
      return;
    }
    dirtyRef.current = true;
    editedRef.current = true;
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
