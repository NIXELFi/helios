/**
 * Auto-sync supersedes its pass on every vault change, and the native transfer
 * can't be cancelled. A caller that wants the same sha at the same path must
 * join the running transfer, not start a second one (the 2026-11-03 egress
 * spike: a 1 GB file re-fetched every few seconds and never finishing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const rename = vi.fn().mockResolvedValue(undefined);
const remove = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: (...args: unknown[]) => rename(...args),
  remove: (...args: unknown[]) => remove(...args),
}));

vi.mock("../fs-readonly", () => ({
  setReadonly: vi.fn().mockResolvedValue(undefined),
  flipSwReadonly: vi.fn(),
}));

import { downloadVersionOnce, inFlightNativeTransfers } from "../useDownloadVersion";

const SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const DEST = "C:/Users/x/Helios/SDM27/Upright/upright.wbpz";
const TEMP = `${DEST}.0d1c.part`;

const client = {
  supabaseUrl: "https://proj.supabase.co",
  supabaseKey: "anon",
  auth: { getSession: async () => ({ data: { session: { access_token: "jwt" } } }) },
  storage: { from: () => ({ download: vi.fn() }) },
} as never;

/** A native transfer we finish by hand. */
function pendingTransfer() {
  let finish!: () => void;
  invoke.mockImplementationOnce(
    () => new Promise((res) => { finish = () => res({ tempPath: TEMP, bytes: 1, wasGzip: true }); }),
  );
  return () => finish();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invoke.mockReset();
  rename.mockClear();
  remove.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("shared native transfers", () => {
  it("a superseded pass and its replacement share ONE transfer; the replacement places the file", async () => {
    const finish = pendingTransfer();
    const old = new AbortController();
    const first = downloadVersionOnce(client, SHA, DEST, { signal: old.signal });
    await flush();
    old.abort(); // the pass is superseded mid-transfer
    const second = downloadVersionOnce(client, SHA, DEST, { signal: new AbortController().signal });
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(inFlightNativeTransfers()).toBe(1);

    finish();
    expect(await first).toEqual({ ok: false, error: "aborted" });
    expect(await second).toEqual({ ok: true });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith(TEMP, DEST);
    expect(remove).not.toHaveBeenCalled();
    expect(inFlightNativeTransfers()).toBe(0);
  });

  it("when every caller gave up, the last one out deletes the temp file", async () => {
    const finish = pendingTransfer();
    const a = new AbortController();
    const b = new AbortController();
    const p1 = downloadVersionOnce(client, SHA, DEST, { signal: a.signal });
    const p2 = downloadVersionOnce(client, SHA, DEST, { signal: b.signal });
    await flush();
    a.abort();
    b.abort();
    finish();
    await Promise.all([p1, p2]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(TEMP);
  });

  it("two live callers: one renames, the other reports success without touching the file", async () => {
    const finish = pendingTransfer();
    const p1 = downloadVersionOnce(client, SHA, DEST);
    const p2 = downloadVersionOnce(client, SHA, DEST);
    await flush();
    finish();
    expect(await p1).toEqual({ ok: true });
    expect(await p2).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("a different destination is a separate transfer", async () => {
    const f1 = pendingTransfer();
    const f2 = pendingTransfer();
    const p1 = downloadVersionOnce(client, SHA, DEST);
    const p2 = downloadVersionOnce(client, SHA, `${DEST}.copy`);
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    f1();
    f2();
    await Promise.all([p1, p2]);
  });

  it("a finished transfer isn't joined: a later request starts a fresh one", async () => {
    invoke.mockResolvedValue({ tempPath: TEMP, bytes: 1, wasGzip: true });
    await downloadVersionOnce(client, SHA, DEST);
    await downloadVersionOnce(client, SHA, DEST);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("a joiner isn't told ok until the claimer has actually renamed the file", async () => {
    const finish = pendingTransfer();
    let releaseRename!: () => void;
    rename.mockImplementationOnce(() => new Promise<void>((r) => { releaseRename = r; }));
    const p1 = downloadVersionOnce(client, SHA, DEST);
    const p2 = downloadVersionOnce(client, SHA, DEST);
    await flush();
    finish();
    let p2Done = false;
    void p2.then(() => { p2Done = true; });
    await flush();
    await flush();
    expect(p2Done).toBe(false); // the rename hasn't happened yet
    releaseRename();
    expect(await p1).toEqual({ ok: true });
    expect(await p2).toEqual({ ok: true });
  });

  it("when the claimer's rename fails, the joiner fetches for itself instead of reporting ok", async () => {
    const finish = pendingTransfer();
    rename.mockRejectedValueOnce(new Error("os error 32: file in use"));
    const p1 = downloadVersionOnce(client, SHA, DEST);
    const p2 = downloadVersionOnce(client, SHA, DEST);
    await flush();
    invoke.mockResolvedValueOnce({ tempPath: `${TEMP}2`, bytes: 1, wasGzip: true });
    finish();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.ok).toBe(false);
    expect(r2).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(2); // the joiner started its own transfer
    expect(rename).toHaveBeenLastCalledWith(`${TEMP}2`, DEST);
  });
});
