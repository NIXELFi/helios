/**
 * downloadVersionOnce — native streaming path (v5.7.1).
 *
 * The transfer, gunzip, hash and write moved into Rust
 * (`download_object_to_temp`), which stops at a temp file. The rename onto
 * the destination stays here so the abort guard and the read-only handling
 * keep working exactly as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const writeFile = vi.fn().mockResolvedValue(undefined);
const mkdir = vi.fn().mockResolvedValue(undefined);
const rename = vi.fn().mockResolvedValue(undefined);
const remove = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: (...args: unknown[]) => writeFile(...args),
  mkdir: (...args: unknown[]) => mkdir(...args),
  rename: (...args: unknown[]) => rename(...args),
  remove: (...args: unknown[]) => remove(...args),
}));

const setReadonly = vi.fn().mockResolvedValue(undefined);
vi.mock("../fs-readonly", () => ({
  setReadonly: (...args: unknown[]) => setReadonly(...args),
  flipSwReadonly: vi.fn(),
}));

import { downloadVersionOnce } from "../useDownloadVersion";

const SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const DEST = "C:/Users/x/Helios/SDM25/Chassis/frame.sldprt";
const TEMP = `${DEST}.0d1c.part`;

const storageDownload = vi.fn();
const client = {
  supabaseUrl: "https://proj.supabase.co",
  auth: {
    getSession: async () => ({ data: { session: { access_token: "user-jwt" } } }),
  },
  storage: { from: () => ({ download: storageDownload }) },
} as never;

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
  invoke.mockReset();
  rename.mockClear();
  remove.mockClear();
  writeFile.mockClear();
  storageDownload.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("downloadVersionOnce native path", () => {
  it("renames the temp file the Rust command produced onto the destination", async () => {
    invoke.mockResolvedValue({ tempPath: TEMP, bytes: 5, wasGzip: true });

    const result = await downloadVersionOnce(client, SHA, DEST);

    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("download_object_to_temp", {
      req: {
        url: `https://proj.supabase.co/storage/v1/object/vault-objects/2c/${SHA}`,
        bearer: "user-jwt",
        apikey: "anon-key",
        destPath: DEST,
        expectedSha256: SHA,
      },
    });
    expect(rename).toHaveBeenCalledWith(TEMP, DEST);
    // Nothing is buffered through the webview any more.
    expect(storageDownload).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("removes the temp file and reports 'aborted' when superseded mid-transfer", async () => {
    const controller = new AbortController();
    invoke.mockImplementation(async () => {
      controller.abort();
      return { tempPath: TEMP, bytes: 5, wasGzip: false };
    });

    const result = await downloadVersionOnce(client, SHA, DEST, {
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, error: "aborted" });
    expect(remove).toHaveBeenCalledWith(TEMP);
    expect(rename).not.toHaveBeenCalled();
  });

  it("surfaces a gateway failure from the command so the retry loop can back off", async () => {
    invoke.mockRejectedValue(new Error("HTTP 504: upstream timed out"));

    const result = await downloadVersionOnce(client, SHA, DEST);

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("504");
    // Three attempts, all through the native command.
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(storageDownload).not.toHaveBeenCalled();
  });

  it("falls back to the webview implementation without a Tauri host", async () => {
    invoke.mockResolvedValue(null);
    storageDownload.mockResolvedValue({
      data: { arrayBuffer: async () => new Uint8Array([104, 101, 108, 108, 111]).buffer },
      error: null,
    });

    const result = await downloadVersionOnce(client, SHA, DEST);

    expect(result).toEqual({ ok: true });
    expect(storageDownload).toHaveBeenCalledWith(`2c/${SHA}`);
    expect(writeFile).toHaveBeenCalled();
  });
});
