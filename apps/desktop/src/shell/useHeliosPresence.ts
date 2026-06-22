import { useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import type { ModuleId } from "./ModulePicker";

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

const KNOWN_MODULES: ReadonlySet<ModuleId> = new Set<ModuleId>([
  "logs",
  "vault",
  "cfd",
  "pm",
  "games",
  "org",
]);

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
 * module, not scoped to PM or Vault. Returns the deduped roster.
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
}): PresenceUser[] {
  const { client, userId, name, subteam, module } = input;
  const [roster, setRoster] = useState<PresenceUser[]>([]);

  // Keep the latest identity/module in a ref so the channel callbacks always
  // announce current values without re-subscribing on every module switch.
  const metaRef = useRef({ name, subteam, module });
  metaRef.current = { name, subteam, module };

  const channelRef = useRef<any>(null);
  // True only between a successful SUBSCRIBED and teardown — gates re-tracks so
  // we never push to a channel that isn't joined (or is mid-teardown).
  const subscribedRef = useRef(false);

  // Subscribe once per (client, userId). The channel lifecycle is keyed on the
  // identity so a sign-out/sign-in cleanly tears down and rejoins.
  useEffect(() => {
    if (!client || !userId) {
      setRoster([]);
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

    const announce = () => {
      void channel.track({
        user_id: userId,
        name: metaRef.current.name,
        subteam: metaRef.current.subteam,
        module: metaRef.current.module,
        online_at: Date.now(),
      } satisfies TrackedMeta);
    };

    const sync = () => {
      if (disposed) return;
      try {
        const state = channel.presenceState();
        setRoster(dedupePresence(state));
        // Self-heal: if a re-sync lands and our own presence is missing — e.g.
        // a socket drop/reconnect dropped our one-shot track — re-announce so
        // we don't silently vanish from everyone else's roster until remount.
        if (subscribedRef.current && state && !state[userId]) announce();
      } catch {
        /* presenceState unavailable mid-teardown — ignore */
      }
    };
    channel.on("presence", { event: "sync" }, sync);
    channel.on("presence", { event: "join" }, sync);
    channel.on("presence", { event: "leave" }, sync);

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
      try {
        void channel.untrack();
      } catch {
        /* ignore */
      }
      c.removeChannel?.(channel);
    };
  }, [client, userId]);

  // Re-track (not re-subscribe) when the active module / identity changes, so
  // everyone sees what each person is currently looking at. Only fires once the
  // channel is actually subscribed — the initial announce is handled by the
  // SUBSCRIBED callback above, so this never double-tracks on mount.
  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || !userId || !subscribedRef.current) return;
    void channel.track({
      user_id: userId,
      name,
      subteam,
      module,
      online_at: Date.now(),
    } satisfies TrackedMeta);
  }, [module, name, subteam, userId]);

  return useMemo(() => roster, [roster]);
}
