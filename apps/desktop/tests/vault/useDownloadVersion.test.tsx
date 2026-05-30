import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import { useDownloadVersion, downloadVersionOnce } from "../../src/modules/vault/data/useDownloadVersion";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
}));

// Deterministic UUID so tests can assert the exact temp path the unique-name
// scheme produces (PART-FILES). Real crypto.randomUUID stays unmocked in prod.
const FIXED_UUID = "11111111-2222-3333-4444-555555555555";

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
    vi.mocked(fs.rename).mockClear();
    vi.mocked(fs.remove).mockClear();
    vi.mocked(fs.rename).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.remove).mockResolvedValue(undefined);
    // Pin crypto.randomUUID so the unique temp path is deterministic in tests.
    vi.spyOn(crypto, "randomUUID").mockReturnValue(FIXED_UUID);
  });
  afterEach(() => { vi.mocked(crypto.randomUUID).mockRestore?.(); });

  it("downloads from Storage, writes to a UNIQUE .part temp file, then renames to the dest (atomic)", async () => {
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
    const tmp = `/Users/me/Vault/parts/x.sldprt.${FIXED_UUID}.part`;
    // Bytes land at a UNIQUE temp path first so a torn write never corrupts the
    // real file AND two concurrent writers to the same dest never collide.
    expect(fs.writeFile).toHaveBeenCalledWith(tmp, expect.any(Uint8Array));
    // ...then an atomic rename promotes it to the real destination.
    expect(fs.rename).toHaveBeenCalledWith(tmp, "/Users/me/Vault/parts/x.sldprt");
    // The dest itself is never written directly.
    expect(fs.writeFile).not.toHaveBeenCalledWith("/Users/me/Vault/parts/x.sldprt", expect.anything());
  });

  it("uses a DIFFERENT temp name per call so concurrent writers to the same dest can't collide", async () => {
    // Two parallel downloads of the same dest (e.g. a retry racing the original,
    // or two callers) must stage to distinct temp paths. With a fixed `.part`
    // name they'd write the same file and the renames would corrupt each other.
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = await sha256Hex(bytes);
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as any)
      .mockReturnValueOnce("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as any);
    const c = mockClient({ data: makeBlob(bytes), error: null });
    await downloadVersionOnce(c, sha, "/tmp/same.bin");
    await downloadVersionOnce(c, sha, "/tmp/same.bin");
    const tmpPaths = vi.mocked(fs.writeFile).mock.calls.map((c) => c[0]);
    expect(tmpPaths[0]).not.toBe(tmpPaths[1]);
    expect(tmpPaths[0]).toContain("/tmp/same.bin.");
    expect(tmpPaths[1]).toContain("/tmp/same.bin.");
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
      vi.mocked(fs.rename).mockClear();
      const c = mockClient({ data: makeBlob(bytes), error: null });
      const result = await downloadVersionOnce(c, wrongSha, "/tmp/x.bin");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/sha256 mismatch/i);
      }
      // Neither the temp write nor the promote-to-dest rename happens — the
      // corrupt bytes never touch disk.
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(fs.rename).not.toHaveBeenCalled();
    });

    it("recovers when storage holds raw bytes that happen to start with the gzip magic", async () => {
      // Construct a "raw" payload that LOOKS gzipped at byte 0-1 but is
      // actually meaningful raw content. The sha is of those raw bytes —
      // a naive gunzip would mangle them and the post-gunzip sha would
      // mismatch. The fix retries with raw bytes and finds the match.
      const rawBytes = new Uint8Array([0x1f, 0x8b, 0xff, 0xfe, 0xaa, 0xbb]);
      const sha = await sha256Hex(rawBytes);
      vi.mocked(fs.writeFile).mockClear();
      vi.mocked(fs.rename).mockClear();
      const c = mockClient({ data: makeBlob(rawBytes), error: null });
      const result = await downloadVersionOnce(c, sha, "/tmp/x.bin");
      expect(result).toEqual({ ok: true });
      const tmp = `/tmp/x.bin.${FIXED_UUID}.part`;
      // writeFile must receive the RAW bytes (not the gunzip output), written
      // to the temp path then promoted via rename.
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      expect(fs.writeFile).toHaveBeenCalledWith(tmp, expect.any(Uint8Array));
      const writtenArg = vi.mocked(fs.writeFile).mock.calls[0]![1] as Uint8Array;
      expect(Array.from(writtenArg)).toEqual(Array.from(rawBytes));
      expect(fs.rename).toHaveBeenCalledWith(tmp, "/tmp/x.bin");
    });

    it("does not leave a corrupt file at the dest if the rename fails after a temp write", async () => {
      // If the atomic promote fails, the bytes only ever existed at the .part
      // path — the real destination is never touched, so a concurrent reader
      // never sees a half-written file. The call reports failure.
      const bytes = new Uint8Array([5, 6, 7]);
      const sha = await sha256Hex(bytes);
      vi.mocked(fs.writeFile).mockClear();
      vi.mocked(fs.rename).mockClear();
      vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failed"));
      const c = mockClient({ data: makeBlob(bytes), error: null });
      const result = await downloadVersionOnce(c, sha, "/tmp/x.bin");
      expect(result.ok).toBe(false);
      const tmp = `/tmp/x.bin.${FIXED_UUID}.part`;
      // The write went to the temp path only; the dest was never written.
      expect(fs.writeFile).toHaveBeenCalledWith(tmp, expect.any(Uint8Array));
      expect(fs.writeFile).not.toHaveBeenCalledWith("/tmp/x.bin", expect.anything());
    });

    it("removes the orphaned temp file when the rename fails (no .part leak)", async () => {
      // PART-FILES: on a rename failure the staged temp file would otherwise
      // linger forever — and the local-folder scan (no .part filter on its
      // side here) would surface it as an "Add to Vault" candidate. Best-effort
      // remove() the temp on failure so orphans don't accumulate.
      const bytes = new Uint8Array([5, 6, 7]);
      const sha = await sha256Hex(bytes);
      vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failed"));
      const c = mockClient({ data: makeBlob(bytes), error: null });
      const result = await downloadVersionOnce(c, sha, "/tmp/x.bin");
      expect(result.ok).toBe(false);
      expect(fs.remove).toHaveBeenCalledWith(`/tmp/x.bin.${FIXED_UUID}.part`);
    });

    it("removes the orphaned temp file when the temp writeFile itself fails", async () => {
      // A failed write can still leave a partial temp file on some platforms;
      // clean it up too so a half-written .part never lingers.
      const bytes = new Uint8Array([5, 6, 7]);
      const sha = await sha256Hex(bytes);
      vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error("disk full"));
      const c = mockClient({ data: makeBlob(bytes), error: null });
      const result = await downloadVersionOnce(c, sha, "/tmp/x.bin");
      expect(result.ok).toBe(false);
      expect(fs.remove).toHaveBeenCalledWith(`/tmp/x.bin.${FIXED_UUID}.part`);
    });

    it("a failing best-effort temp cleanup does not mask the original error", async () => {
      // remove() throwing (temp already gone, permission) must not turn a
      // download failure into an unhandled rejection.
      const bytes = new Uint8Array([5, 6, 7]);
      const sha = await sha256Hex(bytes);
      vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failed"));
      vi.mocked(fs.remove).mockRejectedValueOnce(new Error("remove failed"));
      const c = mockClient({ data: makeBlob(bytes), error: null });
      const result = await downloadVersionOnce(c, sha, "/tmp/x.bin");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("rename failed");
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
