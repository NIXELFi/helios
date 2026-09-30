import { useEffect, useRef } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { VaultId } from "./types";
import { cursorChanged, fetchVaultCursor, type VaultCursor } from "./vault-cursor";

/**
 * Periodic safety net behind realtime, WITHOUT the per-cycle full-catalog pull.
 *
 * Realtime (the vault feed) is the fast path for other people's changes. This
 * hook covers the gaps — a dropped channel, a backgrounded window, a missed
 * event — by probing a cheap count signature (fetchVaultCursor) every
 * `intervalMs` and calling `onChange` ONLY when the signature actually moves.
 * On an idle vault that turns ~megabytes/cycle of catalog re-pull into one
 * cheap RPC.
 *
 * `onChange(prev, next)` receives BOTH signatures so the caller can refresh
 * only the slice that moved (files vs versions vs folders vs locks) instead of
 * re-pulling all six lists. If the cheap probe itself fails we call
 * `onChange(null, null)` — "I don't know what changed, reconcile everything" —
 * so a transient error never silently disables the safety net.
 *
 * A baseline is established on the first probe of a vault (no `onChange`), so
 * opening a vault never triggers an immediate full re-pull. The baseline lives
 * in a ref KEYED BY VAULT, not in the effect: since Task 4 the effect is torn
 * down whenever the module goes off screen (`enabled: false`), and an
 * effect-local baseline would come back null — the first probe after the user
 * returns would silently re-baseline and a teammate's change made while the
 * module was hidden would never be reconciled.
 */
export function useVaultCursor(
  vaultId: VaultId | undefined,
  opts: {
    intervalMs: number;
    onChange: (prev: VaultCursor | null, next: VaultCursor | null) => void;
    enabled?: boolean;
  },
): void {
  const client = useSupabaseClient();
  const { intervalMs, enabled = true } = opts;

  // Hold the callback in a ref so a fresh closure each render doesn't re-arm the
  // interval (mirrors useVaultRealtime / useInterval).
  const onChangeRef = useRef(opts.onChange);
  useEffect(() => {
    onChangeRef.current = opts.onChange;
  });

  // Last cursor actually observed, and the vault it belongs to. Survives an
  // enabled → disabled → enabled cycle; reset when the vault changes, because
  // another vault's counts are a different universe, not a change.
  const lastSeenRef = useRef<{ vaultId: VaultId | undefined; cursor: VaultCursor | null }>({
    vaultId: undefined,
    cursor: null,
  });

  useEffect(() => {
    if (!vaultId || !enabled) return;
    if (lastSeenRef.current.vaultId !== vaultId) {
      lastSeenRef.current = { vaultId, cursor: null };
    }
    let disposed = false;

    const probe = async () => {
      try {
        const next = await fetchVaultCursor(client, vaultId);
        if (disposed) return;
        const prev = lastSeenRef.current.cursor;
        lastSeenRef.current = { vaultId, cursor: next };
        if (cursorChanged(prev, next)) onChangeRef.current(prev, next);
      } catch {
        // Probe failed (offline / transient). Don't lose the safety net: run a
        // full reconcile and leave the baseline untouched so the next good
        // probe compares against the last state we really saw.
        if (!disposed) onChangeRef.current(null, null);
      }
    };

    void probe(); // baseline (or catch-up after a hidden stretch), then poll
    const id = setInterval(() => void probe(), intervalMs);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [client, vaultId, enabled, intervalMs]);
}
