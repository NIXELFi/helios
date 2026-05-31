import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useRecordProperties } from "../../src/modules/vault/data/useRecordProperties";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [])) }));

let rpcArgs: { name: string; args: any } | null = null;
function mockClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string, args: any) => { rpcArgs = { name, args }; return Promise.resolve({ data: null, error: null }); },
  } as any;
}
const wrap = ({ children }: { children: ReactNode }) => (
  <SupabaseAuthProvider client={mockClient()}>{children}</SupabaseAuthProvider>
);

describe("useRecordProperties", () => {
  beforeEach(() => { rpcArgs = null; invokeMock.mockReset(); });

  it("parses a SW file then stores its properties via pdm_set_version_properties", async () => {
    const props = [{ name: "PartNo", value: "ABC-1" }];
    invokeMock.mockResolvedValue(props);
    const { result } = renderHook(() => useRecordProperties(), { wrapper: wrap });
    const got = await result.current.run("ver-1", "/v/p.sldprt", "p.sldprt");
    expect(invokeMock).toHaveBeenCalledWith("parse_sw_properties", { path: "/v/p.sldprt" });
    expect(rpcArgs?.name).toBe("pdm_set_version_properties");
    expect(rpcArgs?.args).toEqual({ p_version_id: "ver-1", p_properties: props });
    expect(got).toEqual(props);
  });

  it("skips non-SolidWorks files (no parse, no rpc)", async () => {
    const { result } = renderHook(() => useRecordProperties(), { wrapper: wrap });
    await result.current.run("ver-1", "/v/log.csv", "log.csv");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(rpcArgs).toBeNull();
  });

  it("does NOT call the rpc when there are no properties to store", async () => {
    invokeMock.mockResolvedValue([]);
    const { result } = renderHook(() => useRecordProperties(), { wrapper: wrap });
    await result.current.run("ver-1", "/v/p.sldprt", "p.sldprt");
    expect(invokeMock).toHaveBeenCalled();
    expect(rpcArgs).toBeNull(); // empty → nothing to store
  });

  it("is best-effort: a parse failure does not throw and skips the rpc", async () => {
    invokeMock.mockRejectedValue(new Error("read fail"));
    const { result } = renderHook(() => useRecordProperties(), { wrapper: wrap });
    await expect(result.current.run("ver-1", "/v/p.sldprt", "p.sldprt")).resolves.toBeNull();
    expect(rpcArgs).toBeNull();
  });
});
