import { useEffect, useRef } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { VaultId } from "./types";
import { cursorChanged, fetchVaultCursor, type VaultCursor } from "./vault-cursor";

/** A probe slower than this counts as failed (full reconcile, gate freed). */
export const PROBE_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("vault_cursor timed out")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Minimum spacing between the catch-up probes effect re-runs fire. */
export const MIN_PROBE_GAP_MS = 500;

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

  // Probe throttle, also kept across effect re-runs and keyed by vault.
  // 2026-11-16 a client sent 291 vault_cursor RPCs in two seconds right after
  // its laptop moved networks. The trigger is unconfirmed — every re-run of
  // the effect below probes at once, and nothing stopped hung probes from
  // piling up and landing together. Both are now bounded: at most one probe is
  // in flight (with a timeout), and a catch-up probe that
  // would land within MIN_PROBE_GAP_MS of the last one is DEFERRED (trailing),
  // not dropped — a quick hide/show still reconciles promptly, while a storm
  // of re-runs collapses to one probe per gap.
  const probeStateRef = useRef<{ vaultId: VaultId | undefined; inFlight: boolean; lastAt: number }>({
    vaultId: undefined,
    inFlight: false,
    lastAt: 0,
  });

  useEffect(() => {
    if (!vaultId || !enabled) return;
    if (lastSeenRef.current.vaultId !== vaultId) {
      lastSeenRef.current = { vaultId, cursor: null };
    }
    if (probeStateRef.current.vaultId !== vaultId) {
      probeStateRef.current = { vaultId, inFlight: false, lastAt: 0 };
    }
    const gate = probeStateRef.current;
    let disposed = false;

    const probe = async () => {
      if (gate.inFlight) return; // the running probe answers for this tick too
      gate.inFlight = true;
      gate.lastAt = Date.now();
      try {
        // Bounded: a request hung on a half-open socket (network change) would
        // otherwise hold `inFlight` and silence the safety net until it died.
        const next = await withTimeout(fetchVaultCursor(client, vaultId), PROBE_TIMEOUT_MS);
        if (disposed) return;
        const prev = lastSeenRef.current.cursor;
        lastSeenRef.current = { vaultId, cursor: next };
        if (cursorChanged(prev, next)) onChangeRef.current(prev, next);
      } catch {
        // Probe failed (offline / transient). Don't lose the safety net: run a
        // full reconcile and leave the baseline untouched so the next good
        // probe compares against the last state we really saw.
        if (!disposed) onChangeRef.current(null, null);
      } finally {
        gate.inFlight = false;
      }
    };

    // Baseline (or catch-up after a hidden stretch), then poll. If a probe for
    // this vault is running or ran moments ago, wait and try again; a re-run
    // clears the pending timer, so a storm leaves only the last one standing.
    let catchUp: ReturnType<typeof setTimeout> | null = null;
    const kick = () => {
      catchUp = null;
      const wait = gate.inFlight
        ? MIN_PROBE_GAP_MS
        : Math.max(0, MIN_PROBE_GAP_MS - (Date.now() - gate.lastAt));
      if (wait === 0) void probe();
      else catchUp = setTimeout(kick, wait);
    };
    kick();
    const id = setInterval(() => void probe(), intervalMs);
    return () => {
      disposed = true;
      clearInterval(id);
      if (catchUp) clearTimeout(catchUp);
    };
  }, [client, vaultId, enabled, intervalMs]);
}
