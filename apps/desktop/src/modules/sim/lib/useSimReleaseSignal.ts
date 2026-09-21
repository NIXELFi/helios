import { useEffect } from "react";
import type { SupabaseClient } from "@helios/auth";
import { requestSimUpdateCheck } from "./simUpdater";

/**
 * The realtime channel a simulator release is announced on.
 *
 * `fsae-sim/sim/tools/publish_build.mjs` broadcasts `published` here once the
 * feed has been written AND read back correct -- never before, because a
 * nudge that arrived while the feed still named the old build would have
 * every rig "update" to it. Change the name in both places or neither.
 */
export const SIM_RELEASE_CHANNEL = "sim-releases";
export const SIM_RELEASE_EVENT = "published";
/** The fallback when no broadcast arrives; same cadence as Helios's own. */
export const SIM_CHECK_EVERY_MS = 5 * 60 * 1000;

/**
 * Keep the simulator current from the shell, in every module.
 *
 * Checks once when Helios starts -- the feed is public, so that needs no
 * sign-in -- then listens for release broadcasts and re-checks when one
 * arrives. A rig that was offline when a release went out hears nothing, so
 * every REconnect of the channel checks too; the first join does not, the
 * startup check has just done it.
 *
 * What arrives is not trusted, only acted on: see `lib/simUpdater.ts`.
 */
export function useSimReleaseSignal(client: SupabaseClient | null): void {
  // Startup, and then every few minutes whatever realtime is doing: a Helios
  // signed in to a project without the broadcast, or behind a network that
  // drops websockets, still catches up. The feed is a small public file.
  useEffect(() => {
    void requestSimUpdateCheck("startup");
    const tick = setInterval(() => void requestSimUpdateCheck("timer"), SIM_CHECK_EVERY_MS);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!client) return;
    const c = client as unknown as {
      channel?: (name: string, opts?: unknown) => any;
      removeChannel?: (ch: unknown) => void;
    };
    if (typeof c.channel !== "function") return; // non-realtime env / test stub

    let disposed = false;
    let joined = false;
    const channel = c.channel(SIM_RELEASE_CHANNEL);
    channel.on("broadcast", { event: SIM_RELEASE_EVENT }, () => {
      if (!disposed) void requestSimUpdateCheck("signal");
    });
    channel.subscribe((status: string) => {
      if (disposed || status !== "SUBSCRIBED") return;
      if (joined) void requestSimUpdateCheck("reconnect");
      joined = true;
    });
    return () => {
      disposed = true;
      c.removeChannel?.(channel);
    };
  }, [client]);
}
