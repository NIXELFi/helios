import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useMyCapabilities, type MyCapability } from "../data/useOrgData";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@helios/auth";

// A Supabase client stub whose pm.my_capabilities() RPC returns whatever the
// `queue` provides on each successive call, so we can assert the hook re-runs
// the RPC when refetch() is invoked (the bug: it never did, so newly-granted
// permissions stayed stale until a full reload).
function mockClient(queue: MyCapability[][]): { client: SupabaseClient; rpc: ReturnType<typeof vi.fn> } {
  let call = 0;
  const rpc = vi.fn(async (name: string) => {
    if (name !== "my_capabilities") return { data: [], error: null };
    const data = queue[Math.min(call, queue.length - 1)] ?? [];
    call += 1;
    return { data, error: null };
  });
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    schema: () => ({ rpc }),
  } as unknown as SupabaseClient;
  return { client, rpc };
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useMyCapabilities", () => {
  it("loads capabilities and resolves `can` with org/subteam scoping", async () => {
    const { client } = mockClient([
      [
        { capability_key: "org.grant_roles", subteam_id: null },
        { capability_key: "pm.edit_tasks", subteam_id: "st-aero" },
      ],
    ]);
    const { result } = renderHook(() => useMyCapabilities(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // org-scoped grant applies everywhere
    expect(result.current.can("org.grant_roles")).toBe(true);
    expect(result.current.can("org.grant_roles", "st-aero")).toBe(true);
    // subteam grant applies only to that subteam, not org-wide
    expect(result.current.can("pm.edit_tasks", "st-aero")).toBe(true);
    expect(result.current.can("pm.edit_tasks")).toBe(false);
    expect(result.current.can("pm.edit_tasks", "st-other")).toBe(false);
    // unknown cap
    expect(result.current.can("org.manage_roles")).toBe(false);
  });

  it("exposes refetch() and re-runs my_capabilities, picking up newly-granted caps", async () => {
    const { client, rpc } = mockClient([
      [], // first load: no caps yet
      [{ capability_key: "org.manage_roles", subteam_id: null }], // after a grant
    ]);
    const { result } = renderHook(() => useMyCapabilities(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.can("org.manage_roles")).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(typeof result.current.refetch).toBe("function");

    // Simulate a grant elsewhere → refetch should re-run the RPC and update caps.
    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.can("org.manage_roles")).toBe(true));
  });
});
