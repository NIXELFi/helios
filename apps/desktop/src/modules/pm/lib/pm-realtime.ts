import type { SupabaseClient } from "@helios/auth";

/**
 * The `pm` tables published to Supabase Realtime (all with FULL replica
 * identity). Editing any of these by any member pushes a change event, so the
 * UI can update in well under a second instead of waiting for the cursor probe.
 *
 * The UNpublished tables (projects, vendors, pages, blocks, subsystems,
 * build_records) are intentionally not here — PmModule's cursor probe +
 * window-focus refresh + slow backstop cover those. `activity` was added to the
 * publication (migration 20260606120000) so the activity feed updates live too.
 */
export const PM_REALTIME_TABLES = [
  "tasks",
  "task_comments",
  "task_dependencies",
  "task_subteams",
  "milestones",
  "calendar_events",
  "subteams",
  "activity",
] as const;

const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 30000;

// Per-subscription suffix so two subscribers never collide on one realtime topic
// name (mirrors useVaultRealtime's useId()). Module-scoped counter keeps it
// deterministic (no Math.random / Date.now).
let instanceCounter = 0;

/**
 * Subscribe to realtime change events on the published `pm` tables and call
 * `onEvent` on any of them. A plain function (not a hook) so PmModule can wire
 * it into the same effect that owns the guarded refresh(). Returns a teardown.
 *
 * Mirrors useVaultRealtime: one channel, a per-instance-unique name, and a
 * capped reconnect backoff on CHANNEL_ERROR / TIMED_OUT. No-ops quietly when the
 * client has no realtime API (test stubs / non-realtime environments).
 */
export function subscribePmRealtime(client: SupabaseClient, onEvent: () => void): () => void {
  const c = client as unknown as {
    channel?: (name: string) => any;
    removeChannel?: (ch: unknown) => void;
  };
  if (typeof c.channel !== "function") return () => {};

  instanceCounter += 1;
  const name = `pm:realtime:${instanceCounter}`;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let current: unknown = null;
  let disposed = false;

  const teardown = () => {
    if (current != null && typeof c.removeChannel === "function") {
      c.removeChannel(current);
    }
    current = null;
  };

  const connect = () => {
    if (disposed) return;
    teardown();
    let ch = c.channel!(name);
    for (const table of PM_REALTIME_TABLES) {
      ch = ch.on("postgres_changes", { event: "*", schema: "pm", table }, () => onEvent());
    }
    current = ch.subscribe((status: string, err?: unknown) => {
      if (disposed) return;
      if (status === "SUBSCRIBED") {
        attempt = 0; // healthy join — reset backoff.
        return;
      }
      console.warn(`[pm realtime] channel status: ${status}`, err ?? "");
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        if (reconnectTimer) return; // a reconnect is already pending.
        const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
        attempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      }
    });
  };

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    teardown();
  };
}
