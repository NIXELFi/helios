import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useFileProperties } from "../../src/modules/vault/data/useFileProperties";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [])) }));

let rpcCalls: any[] = [];
function mockClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: (name: string, args: any) => { rpcCalls.push({ name, args }); return Promise.resolve({ data: null, error: null }); },
  } as any;
}
const wrap = ({ children }: { children: ReactNode }) => <SupabaseAuthProvider client={mockClient()}>{children}</SupabaseAuthProvider>;

const ver = (over: any = {}) => ({
  id: "v1", file_id: "f1", version_num: 1, sha256: "sha1", size_bytes: 1, author_id: null,
  comment: null, parent_version_id: null, revision: null, properties: null, created_at: "x", ...over,
});

describe("useFileProperties", () => {
  beforeEach(() => { invokeMock.mockReset(); rpcCalls = []; });

  it("uses the version's stored (Supabase-cached) properties without parsing", async () => {
    const cached = [{ name: "PartNo", value: "X" }];
    const { result } = renderHook(() => useFileProperties(ver({ properties: cached }) as any, "/v/p.sldprt", "p.sldprt"), { wrapper: wrap });
    await waitFor(() => expect(result.current.props).toEqual(cached));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.notDownloaded).toBe(false);
  });

  it("parses the LOCAL copy when present and best-effort caches", async () => {
    invokeMock.mockResolvedValue([{ name: "Material", value: "Steel" }]);
    const { result } = renderHook(() => useFileProperties(ver() as any, "/v/p.sldprt", "p.sldprt"), { wrapper: wrap });
    await waitFor(() => expect(result.current.props).toEqual([{ name: "Material", value: "Steel" }]));
    expect(invokeMock).toHaveBeenCalledWith("parse_sw_properties", { path: "/v/p.sldprt" });
    expect(rpcCalls.some((c) => c.name === "pdm_set_version_properties")).toBe(true);
  });

  it("reports notDownloaded (NO download) when the file isn't on disk and nothing is cached", async () => {
    invokeMock.mockRejectedValue(new Error("read failed: no such file")); // local parse → file missing
    const { result } = renderHook(() => useFileProperties(ver() as any, "/v/missing.sldprt", "missing.sldprt"), { wrapper: wrap });
    await waitFor(() => expect(result.current.notDownloaded).toBe(true));
    expect(result.current.props).toBeNull();
    // crucially, never tried to store / download anything
    expect(rpcCalls).toHaveLength(0);
  });

  it("reports notDownloaded when there's no local vault folder configured", async () => {
    const { result } = renderHook(() => useFileProperties(ver() as any, null, "p.sldprt"), { wrapper: wrap });
    await waitFor(() => expect(result.current.notDownloaded).toBe(true));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("skips non-SolidWorks files (no parse)", async () => {
    const { result } = renderHook(() => useFileProperties(ver() as any, "/v/log.csv", "log.csv"), { wrapper: wrap });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.notDownloaded).toBe(false);
  });
});
