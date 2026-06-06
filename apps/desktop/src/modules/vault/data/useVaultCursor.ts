import { useEffect, useRef } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { VaultId } from "./types";
import { cursorChanged, fetchVaultCursor, type VaultCursor } from "./vault-cursor";

/**
 * Periodic safety net behind realtime, WITHOUT the per-cycle full-catalog pull.
 *
 * Realtime (useVaultRealtime) is the fast path for other people's changes. This
 * hook covers the gaps — a dropped channel, a backgrounded window, a missed
 * event — by probing a cheap count signature (fetchVaultCursor) every
 * `intervalMs` and calling `onChange` ONLY when the signature actually moves.
 * On an idle vault that turns ~megabytes/cycle of catalog re-pull into a few
 * empty head requests.
 *
 * A baseline is established on mount (no `onChange`), so the first interval
 * compares against the state at mount. If the cheap probe itself fails we call
 * `onChange` anyway (a full reconcile) so a transient error never silently
 * disables the safety net.
 */
export function useVaultCursor(
  vaultId: VaultId | undefined,
  opts: { intervalMs: number; onChange: () => void; enabled?: boolean },
): void {
  const client = useSupabaseClient();
  const { intervalMs, enabled = true } = opts;

  // Hold the callback in a ref so a fresh closure each render doesn't re-arm the
  // interval (mirrors useVaultRealtime / useInterval).
  const onChangeRef = useRef(opts.onChange);
  useEffect(() => {
    onChangeRef.current = opts.onChange;
  });

  useEffect(() => {
    if (!vaultId || !enabled) return;
    let disposed = false;
    let prev: VaultCursor | null = null;

    const probe = async () => {
      try {
        const next = await fetchVaultCursor(client, vaultId);
        if (disposed) return;
        if (cursorChanged(prev, next)) onChangeRef.current();
        prev = next;
      } catch {
        // Probe failed (offline / transient). Don't lose the safety net: run a
        // full reconcile and leave the baseline untouched so the next good
        // probe re-establishes it.
        if (!disposed) onChangeRef.current();
      }
    };

    void probe(); // baseline now, then poll
    const id = setInterval(() => void probe(), intervalMs);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [client, vaultId, enabled, intervalMs]);
}
