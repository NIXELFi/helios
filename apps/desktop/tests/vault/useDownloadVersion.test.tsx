import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useDownloadVersion } from "../../src/modules/vault/data/useDownloadVersion";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

const fs = await import("@tauri-apps/plugin-fs");

function mockClient(downloadResult: { data: any; error: any }): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    storage: { from: () => ({ download: vi.fn().mockResolvedValue(downloadResult) }) },
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useDownloadVersion", () => {
  beforeEach(() => {
    vi.mocked(fs.writeFile).mockClear();
    vi.mocked(fs.mkdir).mockClear();
  });

  it("downloads from Storage and writes to disk", async () => {
    // jsdom's Blob.arrayBuffer is available in newer versions; fall back to
    // constructing a Blob with an explicit arrayBuffer polyfill if needed.
    const bytes = new Uint8Array([1, 2, 3]);
    const blob = new Blob([bytes]);
    if (!blob.arrayBuffer) {
      (blob as any).arrayBuffer = async () => bytes.buffer;
    }
    const c = mockClient({ data: blob, error: null });
    const { result } = renderHook(() => useDownloadVersion(), { wrapper: wrap(c) });
    let ok = false;
    await act(async () => { ok = await result.current.run("a".repeat(64), "/Users/me/Vault/parts/x.sldprt"); });
    expect(ok).toBe(true);
    expect(fs.mkdir).toHaveBeenCalledWith("/Users/me/Vault/parts", { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(
      "/Users/me/Vault/parts/x.sldprt",
      expect.any(Uint8Array),
    );
  });

  it("surfaces errors when storage download fails", async () => {
    const c = mockClient({ data: null, error: { message: "404 not found" } });
    const { result } = renderHook(() => useDownloadVersion(), { wrapper: wrap(c) });
    let ok = false;
    await act(async () => { ok = await result.current.run("a".repeat(64), "/Users/me/Vault/x.sldprt"); });
    expect(ok).toBe(false);
    expect(result.current.error?.message).toContain("404 not found");
  });
});
