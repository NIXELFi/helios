import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useCheckIn } from "../../src/modules/vault/data/useCheckIn";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

const VERSION_ROW = {
  id: "v1",
  file_id: "f1",
  version_num: 1,
  sha256: "abc",
  size_bytes: 4,
  author_id: "u1",
  comment: "initial",
  parent_version_id: null,
  created_at: "2026-01-01",
};

let capturedUpload: any = null;
let capturedRpc: any = null;

function mockClient(uploadError: any = null, rpcError: any = null, rpcData: any = VERSION_ROW): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, bytes: any, opts: any) => {
          capturedUpload = { bucket, path, opts };
          return Promise.resolve({ data: null, error: uploadError });
        },
      }),
    },
    rpc: (name: string, args: any) => {
      capturedRpc = { name, args };
      return Promise.resolve({ data: rpcData, error: rpcError });
    },
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

// 4-byte ArrayBuffer; created inline inside tests so it belongs to the jsdom realm.
function makeBytes(): ArrayBuffer {
  return new Uint8Array([1, 2, 3, 4]).buffer;
}

describe("useCheckIn", () => {
  it("uploads to storage and calls pdm_check_in RPC with sha256 + size", async () => {
    capturedUpload = null;
    capturedRpc = null;
    const c = mockClient();
    const { result } = renderHook(() => useCheckIn(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("f1", makeBytes(), "initial");
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Storage upload should use vault-objects bucket, content-type octet-stream
    expect(capturedUpload?.bucket).toBe("vault-objects");
    expect(capturedUpload?.opts?.contentType).toBe("application/octet-stream");

    // RPC should be called with correct args
    expect(capturedRpc?.name).toBe("pdm_check_in");
    expect(capturedRpc?.args?.p_file_id).toBe("f1");
    expect(capturedRpc?.args?.p_size).toBe(4);
    expect(typeof capturedRpc?.args?.p_sha256).toBe("string");
    expect(capturedRpc?.args?.p_sha256).toHaveLength(64); // hex SHA-256

    expect(result.current.result?.id).toBe("v1");
    expect(result.current.error).toBeNull();
  });

  it("treats 'already exists' storage error as success and proceeds to RPC", async () => {
    capturedRpc = null;
    const c = mockClient({ message: "The resource already exists" });
    const { result } = renderHook(() => useCheckIn(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("f1", makeBytes(), null);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // RPC should still be called
    expect(capturedRpc?.name).toBe("pdm_check_in");
    expect(result.current.error).toBeNull();
  });

  it("surfaces upload errors that are not 'already exists'", async () => {
    const c = mockClient({ message: "bucket not found" });
    const { result } = renderHook(() => useCheckIn(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("f1", makeBytes(), null);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toContain("upload:");
    expect(result.current.error?.message).toContain("bucket not found");
  });

  it("surfaces RPC errors", async () => {
    const c = mockClient(null, { message: "lock required" });
    const { result } = renderHook(() => useCheckIn(), { wrapper: wrap(c) });
    await act(async () => {
      await result.current.run("f1", makeBytes(), null);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toContain("lock required");
  });
});
