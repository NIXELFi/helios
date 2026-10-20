import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import { MODULE_ICON, type ModuleId } from "./ModulePicker";
import { createPresenceStore, type PresenceStore } from "./presenceStore";

/** One signed-in person currently connected to Helios, collapsed across all of
 *  their open windows/tabs. */
export interface PresenceUser {
  userId: string;
  name: string;
  subteam: string | null;
  /** The module their most-recently-active window is showing. */
  module: ModuleId;
  /** Earliest connect time across their connections (epoch ms) — "online since". */
  since: number;
  /** Number of distinct connections (windows) they have open. */
  connections: number;
}

/** Raw per-connection payload we `track()` into the presence channel. */
interface TrackedMeta {
  user_id: string;
  name: string;
  subteam: string | null;
  module: ModuleId;
  online_at: number;
}

/**
 * Every module the rail can show, taken from the rail's own icon table.
 *
 * This list used to be written out by hand, and it fell behind three times:
 * "org", then "sim" and "amethyst". Each time, everyone sitting in that module
 * showed up in everyone else's presence panel as being in Logs -- a wrong
 * answer that looks exactly like a right one. `MODULE_ICON` is typed
 * `Record<ModuleId, ...>`, so the compiler will not let it be incomplete;
 * deriving from it means the drift cannot happen again.
 */
/** Minimum spacing between our presence tracks (Realtime rate-limits them per client). */
export const MIN_TRACK_GAP_MS = 2_000;
/** How long our own entry may be missing after a track before we re-announce. */
export const SELF_HEAL_AFTER_MS = 10_000;

const KNOWN_MODULES: ReadonlySet<ModuleId> = new Set(Object.keys(MODULE_ICON) as ModuleId[]);

/** Coerce an off-the-wire module string to a known ModuleId (a newer/renamed
 *  client could send something we don't recognize); default to "logs" so the
 *  label never renders blank. */
function asModule(m: unknown): ModuleId {
  return typeof m === "string" && KNOWN_MODULES.has(m as ModuleId) ? (m as ModuleId) : "logs";
}

/**
 * Collapse Supabase Realtime `presenceState()` (keyed per connection, each
 * value an array of metas) into one row per USER. Exported pure so it can be
 * unit-tested without a live realtime channel.
 */
export function dedupePresence(
  state: Record<string, Array<Partial<TrackedMeta>>>,
): PresenceUser[] {
  const byUser = new Map<string, PresenceUser>();
  // Newest connect time seen per user, tracked separately from `since` (the
  // MIN / "online since") so the displayed module reflects the user's
  // most-recently-connected window regardless of iteration order.
  const newest = new Map<string, number>();
  for (const metas of Object.values(state)) {
    for (const m of metas) {
      if (!m || typeof m.user_id !== "string") continue;
      const since = typeof m.online_at === "number" ? m.online_at : Date.now();
      const existing = byUser.get(m.user_id);
      if (!existing) {
        byUser.set(m.user_id, {
          userId: m.user_id,
          name: m.name || "Unknown",
          subteam: m.subteam ?? null,
          module: asModule(m.module),
          since,
          connections: 1,
        });
        newest.set(m.user_id, since);
      } else {
        existing.connections += 1;
        // Keep the earliest connect time as "online since".
        if (since < existing.since) existing.since = since;
        // The most-recently-connected window's module wins.
        if (since > (newest.get(m.user_id) ?? -Infinity)) {
          newest.set(m.user_id, since);
          existing.module = asModule(m.module);
        }
      }
    }
  }
  // Stable, friendly order: alphabetical by name.
  return Array.from(byUser.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * App-wide Helios presence. Joins ONE shared realtime channel ("presence:helios")
 * the moment a user is signed in and tracks who's connected — across every
 * module, not scoped to PM or Vault. Returns a stable store holding the
 * deduped roster; read it with `usePresenceRoster` where it is displayed, so a
 * presence event re-renders the roster and nothing else.
 *
 * Mounted once at the shell. Re-tracks (cheaply) when the active module changes
 * so the roster shows what each person is currently looking at. No-ops when
 * signed out or when the client has no realtime API (test stubs).
 */
export function useHeliosPresence(input: {
  client: SupabaseClient | null;
  userId: string | null;
  name: string;
  subteam: string | null;
  module: ModuleId;
}): PresenceStore {
  const { client, userId, name, subteam, module } = input;
  const [store] = useState(createPresenceStore);

  // Keep the latest identity/module in a ref so the channel callbacks always
  // announce current values without re-subscribing on every module switch.
  const metaRef = useRef({ name, subteam, module });
  metaRef.current = { name, subteam, module };

  const channelRef = useRef<any>(null);
  /** The live channel's rate-gated track, null when not subscribed. */
  const announceRef = useRef<(() => void) | null>(null);
  // True only between a successful SUBSCRIBED and teardown — gates re-tracks so
  // we never push to a channel that isn't joined (or is mid-teardown).
  const subscribedRef = useRef(false);

  // Subscribe once per (client, userId). The channel lifecycle is keyed on the
  // identity so a sign-out/sign-in cleanly tears down and rejoins.
  useEffect(() => {
    if (!client || !userId) {
      store.set([]);
      return;
    }
    const c = client as unknown as {
      channel?: (name: string, opts?: unknown) => any;
      removeChannel?: (ch: unknown) => void;
    };
    if (typeof c.channel !== "function") return; // non-realtime env / test stub

    let disposed = false;
    const channel = c.channel("presence:helios", {
      config: { presence: { key: userId } },
    });
    channelRef.current = channel;
    subscribedRef.current = false;

    // Every track() is a presence message, and Realtime rate-limits them per
    // client (ClientPresenceRateLimitReached). A rate-limited client drops out
    // of everyone's roster, so all tracks go through this gate: at most one per
    // MIN_TRACK_GAP_MS, one in flight at a time, later requests coalesced into a
    // single trailing track that carries the newest module.
    let lastTrack = 0;
    let inFlight = false;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const announce = () => {
      if (disposed || !subscribedRef.current) return;
      const wait = lastTrack + MIN_TRACK_GAP_MS - Date.now();
      if (inFlight || wait > 0) {
        trailing ??= setTimeout(() => {
          trailing = undefined;
          announce();
        }, Math.max(wait, 250));
        return;
      }
      lastTrack = Date.now();
      inFlight = true;
      Promise.resolve(
        channel.track({
          user_id: userId,
          name: metaRef.current.name,
          subteam: metaRef.current.subteam,
          module: metaRef.current.module,
          online_at: Date.now(),
        } satisfies TrackedMeta),
      )
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    announceRef.current = announce;

    // "sync" fires once after the full state or any diff has been applied.
    // Listen to it ONLY: "join"/"leave" also fire once per person while the
    // initial state is applied -- before our own entry is in it -- so a
    // self-heal on those re-tracked once per person already online (~70
    // presence messages in a burst on every connect, then rate-limited for good).
    const sync = () => {
      if (disposed) return;
      try {
        const state = channel.presenceState();
        store.set(dedupePresence(state));
        // Self-heal: if a re-sync lands and our own presence is missing — e.g.
        // a socket drop/reconnect dropped our one-shot track — re-announce so
        // we don't silently vanish from everyone else's roster until remount.
        // Give a just-sent track time to echo back before calling it lost.
        if (
          subscribedRef.current && state && !state[userId] &&
          !inFlight && Date.now() - lastTrack >= SELF_HEAL_AFTER_MS
        ) announce();
      } catch {
        /* presenceState unavailable mid-teardown — ignore */
      }
    };
    channel.on("presence", { event: "sync" }, sync);

    channel.subscribe((status: string) => {
      if (disposed) return;
      // Fires on every (re)join. Tracking here — not in the join payload —
      // means a reconnect re-announces us automatically.
      if (status === "SUBSCRIBED") {
        subscribedRef.current = true;
        announce();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        subscribedRef.current = false;
      }
    });

    return () => {
      disposed = true;
      subscribedRef.current = false;
      channelRef.current = null;
      announceRef.current = null;
      if (trailing !== undefined) clearTimeout(trailing);
      try {
        void channel.untrack();
      } catch {
        /* ignore */
      }
      c.removeChannel?.(channel);
    };
  }, [client, userId, store]);

  // Re-track (not re-subscribe) when the active module / identity changes, so
  // everyone sees what each person is currently looking at. Only fires once the
  // channel is actually subscribed — the initial announce is handled by the
  // SUBSCRIBED callback above, so this never double-tracks on mount.
  // Goes through the same rate gate as every other track (metaRef already holds
  // the new values), so clicking quickly through modules sends one trailing
  // track, not one per click.
  useEffect(() => {
    if (!userId || !subscribedRef.current) return;
    announceRef.current?.();
  }, [module, name, subteam, userId]);

  return store;
}
