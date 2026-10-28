import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SupabaseAuthProvider } from "@helios/auth";
import { usePeopleNames } from "../../src/modules/vault/data/usePeopleNames";

function client(directory: any[] | null, err: any = null) {
  const rpc = vi.fn().mockResolvedValue({ data: directory, error: err });
  return {
    rpc: vi.fn(),
    schema: vi.fn().mockReturnValue({ rpc }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "me" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    _dirRpc: rpc,
  } as any;
}

function wrap(c: any) {
  return ({ children }: { children: ReactNode }) => <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;
}

describe("usePeopleNames", () => {
  it("resolves members from the org directory when the admin vault list is unavailable", async () => {
    const c = client([
      { id: "u1", name: "Alice A", email: "alice@sdm.com" },
      { id: "u2", name: null, email: "bob@sdm.com" },
    ]);
    const { result } = renderHook(() => usePeopleNames(null), { wrapper: wrap(c) });
    await waitFor(() => expect(result.current.get("u1")).toBe("Alice A"));
    expect(result.current.get("u2")).toBe("bob@sdm.com");
    expect(c.schema).toHaveBeenCalledWith("pm");
    expect(c._dirRpc).toHaveBeenCalledWith("list_directory");
  });

  it("layers vault users (display name first) over the directory", async () => {
    const c = client([{ id: "u1", name: "alice", email: "alice@sdm.com" }]);
    const users = [{ user_id: "u1", display_name: "Alice (Chassis)", email: "alice@sdm.com" }] as any;
    const { result } = renderHook(() => usePeopleNames(users), { wrapper: wrap(c) });
    await waitFor(() => expect(c._dirRpc).toHaveBeenCalled());
    expect(result.current.get("u1")).toBe("Alice (Chassis)");
  });

  it("survives a directory error", async () => {
    const c = client(null, { message: "nope" });
    const users = [{ user_id: "u9", display_name: null, email: "z@sdm.com" }] as any;
    const { result } = renderHook(() => usePeopleNames(users), { wrapper: wrap(c) });
    await waitFor(() => expect(c._dirRpc).toHaveBeenCalled());
    expect(result.current.get("u9")).toBe("z@sdm.com");
  });

  it("falls back to email when display_name is an empty string", async () => {
    const c = client(null, { message: "nope" });
    const users = [{ user_id: "u7", display_name: "  ", email: "q@sdm.com" }] as any;
    const { result } = renderHook(() => usePeopleNames(users), { wrapper: wrap(c) });
    await waitFor(() => expect(c._dirRpc).toHaveBeenCalled());
    expect(result.current.get("u7")).toBe("q@sdm.com");
  });
});
