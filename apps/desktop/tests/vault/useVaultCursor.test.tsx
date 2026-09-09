import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useVaultCursor } from "../../src/modules/vault/data/useVaultCursor";
import type { VaultCursor } from "../../src/modules/vault/data/vault-cursor";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Client whose vault_cursor RPC returns whatever the test currently wants,
 *  per vault id. `calls` counts probes so a disabled hook can be proven idle. */
function cursorClient(rows: Record<string, VaultCursor>) {
  const calls: string[] = [];
  let fail = false;
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      const id = String(args?.p_vault_id ?? "");
      calls.push(id);
      if (fail) return Promise.resolve({ data: null, error: { code: "500", message: "boom" } });
      const c = rows[id] ?? { liveFiles: 0, versions: 0, liveFolders: 0, activeLocks: 0 };
      return Promise.resolve({
        data: [{ live_files: c.liveFiles, versions: c.versions, live_folders: c.liveFolders, active_locks: c.activeLocks }],
        error: null,
      });
    }),
    from: vi.fn(),
  } as any as SupabaseClient;
  return {
    client,
    calls,
    set: (id: string, c: VaultCursor) => { rows[id] = c; },
    setFail: (v: boolean) => { fail = v; },
  };
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

const cur = (p: Partial<VaultCursor> = {}): VaultCursor => ({
  liveFiles: 0, versions: 0, liveFolders: 0, activeLocks: 0, ...p,
});

describe("useVaultCursor", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("hands onChange BOTH the previous and the next cursor so the caller can target the refresh", async () => {
    const { client, set } = cursorClient({ v1: cur({ liveFiles: 5, versions: 3 }) });
    const onChange = vi.fn();
    renderHook(() => useVaultCursor("v1", { intervalMs: 1000, onChange }), { wrapper: wrap(client) });
    // Baseline probe: not a change.
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
    set("v1", cur({ liveFiles: 5, versions: 4 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const [prev, next] = onChange.mock.calls[0]!;
    expect(prev).toEqual(cur({ liveFiles: 5, versions: 3 }));
    expect(next).toEqual(cur({ liveFiles: 5, versions: 4 }));
  });

  it("passes (null, null) when the probe itself fails, so the caller reconciles everything", async () => {
    const { client, setFail } = cursorClient({ v1: cur({ liveFiles: 1 }) });
    const onChange = vi.fn();
    renderHook(() => useVaultCursor("v1", { intervalMs: 1000, onChange }), { wrapper: wrap(client) });
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
    setFail(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0]).toEqual([null, null]);
  });

  it("does not fire onChange while nothing changes (idle vault stays quiet)", async () => {
    const { client } = cursorClient({ v1: cur({ liveFiles: 10, versions: 5, liveFolders: 2 }) });
    const onChange = vi.fn();
    renderHook(() => useVaultCursor("v1", { intervalMs: 1000, onChange }), { wrapper: wrap(client) });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); // three idle polls
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not probe at all while disabled, or with no vault", async () => {
    const { client, calls } = cursorClient({ v1: cur() });
    const { rerender } = renderHook(
      ({ id, enabled }: { id: string | undefined; enabled: boolean }) =>
        useVaultCursor(id, { intervalMs: 1000, onChange: vi.fn(), enabled }),
      { initialProps: { id: undefined as string | undefined, enabled: true }, wrapper: wrap(client) },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(calls).toHaveLength(0);

    rerender({ id: "v1", enabled: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(calls).toHaveLength(0);
  });

  it("notices a change that happened while the module was hidden (baseline survives re-enable)", async () => {
    // Task 4 gates the probe on `enabled`. The effect is torn down and rebuilt
    // when the user comes back, so a locally-scoped baseline would be null and
    // the FIRST probe after re-enable would silently re-baseline — a teammate's
    // check-in made while Vault was in the background would never reconcile.
    const { client, set } = cursorClient({ v1: cur({ liveFiles: 5 }) });
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useVaultCursor("v1", { intervalMs: 1000, onChange, enabled }),
      { initialProps: { enabled: true }, wrapper: wrap(client) },
    );
    await waitFor(() => expect(client.rpc as any).toHaveBeenCalledTimes(1));
    // User switches to another module; a teammate adds a file meanwhile.
    rerender({ enabled: false });
    set("v1", cur({ liveFiles: 6 }));
    // User comes back.
    rerender({ enabled: true });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0]![0]).toEqual(cur({ liveFiles: 5 }));
    expect(onChange.mock.calls[0]![1]).toEqual(cur({ liveFiles: 6 }));
  });

  it("drops the remembered baseline when the vault changes (no cross-vault false positive)", async () => {
    const { client } = cursorClient({ v1: cur({ liveFiles: 5 }), v2: cur({ liveFiles: 900 }) });
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useVaultCursor(id, { intervalMs: 1000, onChange }),
      { initialProps: { id: "v1" }, wrapper: wrap(client) },
    );
    await waitFor(() => expect(client.rpc as any).toHaveBeenCalledTimes(1));
    rerender({ id: "v2" });
    await waitFor(() => expect(client.rpc as any).toHaveBeenCalledTimes(2));
    // v2's counts differ wildly from v1's, but that is a different vault, not
    // a change — the first probe of a vault is always just a baseline.
    expect(onChange).not.toHaveBeenCalled();
  });
});
