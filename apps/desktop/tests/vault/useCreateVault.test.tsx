import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider, useAuthLoading } from "@helios/auth";
import { useCreateVault } from "../../src/modules/vault/data/useCreateVault";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

let observed: any = null;

function mockClient(returnRow: any, error: any = null): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "admin1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      insert: (row: any) => {
        observed = row;
        return {
          select: () => ({
            single: () => Promise.resolve({ data: returnRow, error }),
          }),
        };
      },
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useCreateVault", () => {
  it("inserts a vault row with name + created_by and returns the created vault", async () => {
    observed = null;
    const vaultRow = { id: "vault1", name: "SDM26", created_at: "2026-01-01", created_by: "admin1" };
    const c = mockClient(vaultRow);
    const { result } = renderHook(
      () => ({ hook: useCreateVault(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));
    await act(async () => {
      await result.current.hook.run("SDM26");
    });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));
    expect(observed).toEqual({ name: "SDM26", created_by: "admin1" });
    expect(result.current.hook.error).toBeNull();
  });

  it("surfaces RLS errors for non-admin users with a friendly message", async () => {
    const c = mockClient(null, { message: "permission denied for table vaults", code: "42501" });
    const { result } = renderHook(
      () => ({ hook: useCreateVault(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));
    await act(async () => {
      await result.current.hook.run("SDM26");
    });
    // Friendly mapping translates 42501 to a readable explanation in
    // context ("create a vault"), not the raw "permission denied for table"
    // SQL string.
    expect(result.current.hook.error?.message).toMatch(/permission denied/i);
    expect(result.current.hook.error?.message).toMatch(/create/i);
  });
});
