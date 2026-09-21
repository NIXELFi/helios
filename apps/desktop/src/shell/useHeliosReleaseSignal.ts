import { useEffect, useRef } from "react";
import type { SupabaseClient } from "@helios/auth";

/**
 * The realtime channel a Helios release is announced on.
 *
 * `.github/workflows/release.yml` broadcasts `published` here right after the
 * release is promoted from draft -- the moment `latest.json` is live -- so
 * every running Helios looks within seconds instead of at its next five-minute
 * check. Change the name in both places or neither.
 */
export const HELIOS_RELEASE_CHANNEL = "helios-releases";
export const HELIOS_RELEASE_EVENT = "published";

/** Messages closer together than this collapse into one trailing check. */
export const RELEASE_SIGNAL_MIN_INTERVAL_MS = 15_000;

/**
 * Call `onRelease` when a Helios release is announced, and when the channel
 * reconnects after a drop (a machine that was offline at release time).
 *
 * The message carries nothing that is acted on: `onRelease` runs the ordinary
 * updater check, which reads GitHub's signed manifest and verifies the bundle
 * signature before installing. A forged message can only cause a check -- and
 * at most one per interval, because anyone with the public key can send on a
 * public channel.
 */
export function useHeliosReleaseSignal(client: SupabaseClient | null, onRelease: () => void): void {
  const cb = useRef(onRelease);
  cb.current = onRelease;

  useEffect(() => {
    if (!client) return;
    const c = client as unknown as {
      channel?: (name: string, opts?: unknown) => any;
      removeChannel?: (ch: unknown) => void;
    };
    if (typeof c.channel !== "function") return; // non-realtime env / test stub

    let disposed = false;
    let joined = false;
    let last = -Infinity;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (disposed) return;
      const wait = last + RELEASE_SIGNAL_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) {
        trailing ??= setTimeout(() => { trailing = null; last = Date.now(); if (!disposed) cb.current(); }, wait);
        return;
      }
      last = Date.now();
      cb.current();
    };

    const channel = c.channel(HELIOS_RELEASE_CHANNEL);
    channel.on("broadcast", { event: HELIOS_RELEASE_EVENT }, fire);
    channel.subscribe((status: string) => {
      if (disposed || status !== "SUBSCRIBED") return;
      if (joined) fire();
      joined = true;
    });
    return () => {
      disposed = true;
      if (trailing) clearTimeout(trailing);
      c.removeChannel?.(channel);
    };
  }, [client]);
}
