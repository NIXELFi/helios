import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useRecordRefs } from "../../src/modules/vault/data/useRecordRefs";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [])) }));

let rpcArgs: { name: string; args: any } | null = null;
function mockClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string, args: any) => { rpcArgs = { name, args }; return Promise.resolve({ data: 1, error: null }); },
  } as any;
}
const wrap = ({ children }: { children: ReactNode }) => (
  <SupabaseAuthProvider client={mockClient()}>{children}</SupabaseAuthProvider>
);

describe("useRecordRefs", () => {
  beforeEach(() => { rpcArgs = null; invokeMock.mockReset(); });

  it("parses a SW file then records the hints via pdm_record_refs", async () => {
    invokeMock.mockResolvedValue(["..\\parts\\frame.sldprt"]);
    const { result } = renderHook(() => useRecordRefs(), { wrapper: wrap });
    await result.current.run("ver-1", "/v/asm.sldasm", "asm.sldasm");
    expect(invokeMock).toHaveBeenCalledWith("parse_sw_refs", { path: "/v/asm.sldasm" });
    expect(rpcArgs?.name).toBe("pdm_record_refs");
    expect(rpcArgs?.args).toEqual({ p_parent_version_id: "ver-1", p_child_hints: ["..\\parts\\frame.sldprt"] });
  });

  it("skips non-SolidWorks files entirely (no parse, no rpc)", async () => {
    const { result } = renderHook(() => useRecordRefs(), { wrapper: wrap });
    await result.current.run("ver-1", "/v/log.csv", "log.csv");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(rpcArgs).toBeNull();
  });

  it("is best-effort: a parse failure does not throw and does not call the rpc", async () => {
    invokeMock.mockRejectedValue(new Error("read fail"));
    const { result } = renderHook(() => useRecordRefs(), { wrapper: wrap });
    await expect(result.current.run("ver-1", "/v/asm.sldasm", "asm.sldasm")).resolves.toBeUndefined();
    expect(rpcArgs).toBeNull();
  });
});
