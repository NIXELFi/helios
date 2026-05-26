import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useDownloadVersion, downloadVersionOnce } from "../../src/modules/vault/data/useDownloadVersion";
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

/** Build a client whose .download() returns each result in `seq` in turn,
 *  reflecting "attempt 1 → attempt 2 → attempt 3" behavior. */
function sequencedClient(seq: Array<{ data: any; error: any }>): {
  client: SupabaseClient;
  downloadFn: ReturnType<typeof vi.fn>;
} {
  const downloadFn = vi.fn();
  for (const r of seq) downloadFn.mockResolvedValueOnce(r);
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    storage: { from: () => ({ download: downloadFn }) },
  } as any;
  return { client, downloadFn };
}

function makeBlob(bytes: Uint8Array): Blob {
  const blob = new Blob([bytes]);
  if (!blob.arrayBuffer) (blob as any).arrayBuffer = async () => bytes.buffer;
  return blob;
}

/** Hex sha256 — used by tests to construct (sha, bytes) pairs that pass the
 *  download-time integrity check added in the 2026-05-25 audit. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    const sha = await sha256Hex(bytes);
    const blob = new Blob([bytes]);
    if (!blob.arrayBuffer) {
      (blob as any).arrayBuffer = async () => bytes.buffer;
    }
    const c = mockClient({ data: blob, error: null });
    const { result } = renderHook(() => useDownloadVersion(), { wrapper: wrap(c) });
    let ok = false;
    await act(async () => { ok = await result.current.run(sha, "/Users/me/Vault/parts/x.sldprt"); });
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

  describe("downloadVersionOnce retry classifier", () => {
    // The retry classifier is production-critical: Supabase Storage's gateway
    // returns 504s under heavy load (esp. during bulk auto-syncs). These tests
    // pin the behavior so a future "simplification" can't silently remove the
    // retry without a test failure.

    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    it("retries on transient 504 then succeeds on second attempt", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const sha = await sha256Hex(bytes);
      const { client, downloadFn } = sequencedClient([
        { data: null, error: { message: "504 gateway timeout" } },
        { data: makeBlob(bytes), error: null },
      ]);
      const result = await downloadVersionOnce(client, sha, "/tmp/x.bin");
      expect(result).toEqual({ ok: true });
      expect(downloadFn).toHaveBeenCalledTimes(2);
    });

    it("retries on network 'fetch failed' then succeeds", async () => {
      const bytes = new Uint8Array([1]);
      const sha = await sha256Hex(bytes);
      const { client, downloadFn } = sequencedClient([
        { data: null, error: { message: "fetch failed: connection reset" } },
        { data: makeBlob(bytes), error: null },
      ]);
      const result = await downloadVersionOnce(client, sha, "/tmp/x.bin");
      expect(result).toEqual({ ok: true });
      expect(downloadFn).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on permanent 404", async () => {
      const { client, downloadFn } = sequencedClient([
        { data: null, error: { message: "object not found (404)" } },
      ]);
      const result = await downloadVersionOnce(client, "a".repeat(64), "/tmp/x.bin");
      expect(result.ok).toBe(false);
      expect(downloadFn).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on permanent 403", async () => {
      const { client, downloadFn } = sequencedClient([
        { data: null, error: { message: "permission denied (403)" } },
      ]);
      const result = await downloadVersionOnce(client, "a".repeat(64), "/tmp/x.bin");
      expect(result.ok).toBe(false);
      expect(downloadFn).toHaveBeenCalledTimes(1);
    });

    it("gives up after 3 attempts on persistent 503", async () => {
      const { client, downloadFn } = sequencedClient([
        { data: null, error: { message: "503 service unavailable" } },
        { data: null, error: { message: "503 service unavailable" } },
        { data: null, error: { message: "503 service unavailable" } },
      ]);
      const result = await downloadVersionOnce(client, "a".repeat(64), "/tmp/x.bin");
      expect(result.ok).toBe(false);
      expect(downloadFn).toHaveBeenCalledTimes(3);
      if (!result.ok) {
        expect(result.error).toContain("503");
      }
    });
  });

  describe("downloadVersionOnce SHA integrity verification", () => {
    // The 2026-05-25 audit flagged that gunzipIfNeeded sniffs only the first
    // two bytes (the gzip magic 1f 8b). A raw binary file that happens to
    // begin with those bytes would be mistakenly decompressed, producing
    // garbage. Without a sha check after gunzip, that garbage gets written
    // to disk and the user only discovers the corruption when their CAD
    // app fails to open the part. These tests pin the new verify-then-write
    // behavior.

    it("returns sha mismatch error and does NOT writeFile when bytes hash wrong", async () => {
      const bytes = new Uint8Array([9, 9, 9]);
      const wrongSha = "0".repeat(64); // not the actual sha of [9,9,9]
      vi.mocked(fs.writeFile).mockClear();
      const c = mockClient({ data: makeBlob(bytes), error: null });
      const result = await downloadVersionOnce(c, wrongSha, "/tmp/x.bin");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/sha256 mismatch/i);
      }
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("recovers when storage holds raw bytes that happen to start with the gzip magic", async () => {
      // Construct a "raw" payload that LOOKS gzipped at byte 0-1 but is
      // actually meaningful raw content. The sha is of those raw bytes —
      // a naive gunzip would mangle them and the post-gunzip sha would
      // mismatch. The fix retries with raw bytes and finds the match.
      const rawBytes = new Uint8Array([0x1f, 0x8b, 0xff, 0xfe, 0xaa, 0xbb]);
      const sha = await sha256Hex(rawBytes);
      vi.mocked(fs.writeFile).mockClear();
      const c = mockClient({ data: makeBlob(rawBytes), error: null });
      const result = await downloadVersionOnce(c, sha, "/tmp/x.bin");
      expect(result).toEqual({ ok: true });
      // writeFile must receive the RAW bytes (not the gunzip output).
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      const writtenArg = vi.mocked(fs.writeFile).mock.calls[0]![1] as Uint8Array;
      expect(Array.from(writtenArg)).toEqual(Array.from(rawBytes));
    });

    it("accepts both upper and lowercase hex shas (canonicalizes to lowercase)", async () => {
      const bytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
      const sha = await sha256Hex(bytes); // lowercase
      vi.mocked(fs.writeFile).mockClear();
      const c = mockClient({ data: makeBlob(bytes), error: null });
      const result = await downloadVersionOnce(c, sha.toUpperCase(), "/tmp/x.bin");
      expect(result).toEqual({ ok: true });
    });
  });
});
