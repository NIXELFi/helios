import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useMyRole } from "../../src/modules/vault/data/useMyRole";
import type { MyRole } from "../../src/modules/vault/data/useMyRole";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockClient(session: any, roleRow: any): SupabaseClient {
  // useMyRole now does .select("*").eq("user_id", id) and picks the global row
  // in JS — the chain resolves to an array of rows.
  const eq = vi.fn().mockResolvedValue({ data: roleRow ? [roleRow] : [], error: null });
  const select = vi.fn().mockReturnValue({ eq });
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      if (table === "user_roles") return { select };
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    },
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useMyRole", () => {
  it("returns null when there is no user", async () => {
    const c = mockClient(null, null);
    const { result } = renderHook(() => useMyRole(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("returns 'admin' when user_roles row has role=admin", async () => {
    const c = mockClient({ user: { id: "u1" } }, { role: "admin" });
    const { result } = renderHook(() => useMyRole(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current).toBe("admin" as MyRole));
  });

  it("returns 'editor' when user_roles row has role=editor", async () => {
    const c = mockClient({ user: { id: "u1" } }, { role: "editor" });
    const { result } = renderHook(() => useMyRole(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current).toBe("editor" as MyRole));
  });

  it("returns 'owner' when user_roles row has role=owner (V16)", async () => {
    // The DB returns "owner" for the super-user; the MyRole union previously
    // omitted it (hidden behind `as any`). It must be a representable value so
    // consumers can compare === "owner" and type-check.
    // Type-level guard: assigning the literal "owner" to MyRole only compiles
    // when "owner" is part of the union (no cast). tsc fails here pre-fix.
    const ownerRole: MyRole = "owner";
    const c = mockClient({ user: { id: "u1" } }, { role: "owner" });
    const { result } = renderHook(() => useMyRole(), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current).toBe(ownerRole));
  });

  it("returns null when user has no role row", async () => {
    const c = mockClient({ user: { id: "u1" } }, null);
    const { result } = renderHook(() => useMyRole(), { wrapper: wrap(c) });
    await waitFor(() => {
      // After the query resolves with null data, role should be null
      expect(result.current).toBeNull();
    });
  });
});
