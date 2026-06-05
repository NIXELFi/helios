import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider, useAuthLoading } from "@helios/auth";
import { useAddLocalFile } from "../../src/modules/vault/data/useAddLocalFile";
import { subscribeLockChanges } from "../../src/modules/vault/data/lock-events";
import { readFile } from "@tauri-apps/plugin-fs";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

const readFileMock = vi.mocked(readFile);

const FILE_ROW = { id: "fi1", vault_id: "v1", folder_id: null, name: "part.sldprt", latest_version_id: null, created_at: "x" };

// A realistic 64-char hex sha256, as produced by the local-folder scan and
// carried on LocalFile.sha256. The hook reuses this rather than re-reading +
// re-hashing the whole file (audit V8).
const SCAN_SHA = "a".repeat(64);

const localFileRoot = {
  basename: "part.sldprt",
  relativePath: "part.sldprt",
  absolutePath: "/vault/part.sldprt",
  sha256: SCAN_SHA,
  sizeBytes: 3,
};

// Tracks which Supabase operations were called, in order.
let callLog: string[] = [];

// Controls what storage.list returns for objectExists(). Default: the object
// is absent (empty list, no error). Tests override per-case.
let listImpl: () => Promise<{ data: any; error: any }> = () =>
  Promise.resolve({ data: [], error: null });

function buildHappyClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    storage: {
      from: (_bucket: string) => ({
        list: (_prefix: string, _opts: any) => {
          callLog.push("storage.list");
          return listImpl();
        },
        upload: (_path: string, _bytes: any, _opts: any) => {
          callLog.push("storage.upload");
          return Promise.resolve({ data: null, error: null });
        },
      }),
    },
    rpc: (name: string, _args: any) => {
      callLog.push(`rpc:${name}`);
      return Promise.resolve({ data: {}, error: null });
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "files") {
        return {
          insert: (_row: any) => ({
            select: () => ({
              single: () => {
                callLog.push("files.insert");
                return Promise.resolve({ data: FILE_ROW, error: null });
              },
            }),
          }),
        };
      }
      if (table === "locks") {
        return {
          insert: (_row: any) => {
            callLog.push("locks.insert");
            return Promise.resolve({ data: { id: "l1" }, error: null });
          },
        };
      }
      if (table === "folders") {
        return {
          // Chain: select → eq(vault_id) → is(deleted_at,null) → eq(name) → {is|eq}(parent_id)
          select: () => ({
            eq: () => ({
              is: () => ({
                eq: () => ({
                  is: () => {
                    callLog.push("folders.lookup");
                    return Promise.resolve({ data: [], error: null });
                  },
                  eq: () => {
                    callLog.push("folders.lookup");
                    return Promise.resolve({ data: [], error: null });
                  },
                }),
              }),
            }),
          }),
          insert: (_row: any) => ({
            select: () => ({
              single: () => {
                callLog.push("folders.insert");
                return Promise.resolve({
                  data: { id: `dir-${callLog.filter((s) => s === "folders.insert").length}` },
                  error: null,
                });
              },
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    }),
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useAddLocalFile", () => {
  beforeEach(() => {
    callLog = [];
    readFileMock.mockClear();
    readFileMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    listImpl = () => Promise.resolve({ data: [], error: null });
  });

  it("happy path (root file): uploads then atomically calls pdm_add_and_lock", async () => {
    const c = buildHappyClient();
    // Default mock returns `{}` — make it return a realistic shape with a lock id.
    (c.rpc as any) = (name: string, _args: any) => {
      callLog.push(`rpc:${name}`);
      return Promise.resolve({
        data: { file_id: "fi1", version_id: "ve1", lock_id: "lo1", created: true },
        error: null,
      });
    };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: any;
    await act(async () => {
      returned = await result.current.hook.run("v1", localFileRoot);
    });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(result.current.hook.error?.message ?? null).toBeNull();
    expect(returned).toEqual({ ok: true, lockAcquired: true, alreadyExisted: false });

    // Root file means no folder lookups/creates. Steps in order:
    //   probe storage by sha → upload bytes (object was absent) → single RPC
    //   that creates file + version + lock atomically.
    expect(callLog).toEqual([
      "storage.list",
      "storage.upload",
      "rpc:pdm_add_and_lock",
    ]);
  });

  it("broadcasts a lock change when the add acquires a lock (new file → checked out)", async () => {
    let notified = 0;
    const unsub = subscribeLockChanges(() => { notified++; });
    const c = buildHappyClient();
    (c.rpc as any) = (name: string, _args: any) => {
      callLog.push(`rpc:${name}`);
      return Promise.resolve({ data: { file_id: "fi1", version_id: "ve1", lock_id: "lo1", created: true }, error: null });
    };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));
    await act(async () => { await result.current.hook.run("v1", localFileRoot); });
    unsub();
    expect(notified).toBe(1);
  });

  it("does NOT broadcast when no lock was acquired (lock_id null)", async () => {
    let notified = 0;
    const unsub = subscribeLockChanges(() => { notified++; });
    const c = buildHappyClient();
    (c.rpc as any) = (name: string, _args: any) => {
      callLog.push(`rpc:${name}`);
      return Promise.resolve({ data: { file_id: "fi1", version_id: "ve1", lock_id: null, created: false }, error: null });
    };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));
    await act(async () => { await result.current.hook.run("v1", localFileRoot); });
    unsub();
    expect(notified).toBe(0);
  });

  it("surfaces lock_id=null as ok:true but lockAcquired:false", async () => {
    // Repro of the 2026-05-25 audit finding: pdm_add_and_lock returns
    // {lock_id: null, created: false} when the file already exists and
    // another user holds the lock. The previous implementation swallowed
    // the lock_id and returned `true`, so the UI showed a green tick and
    // the user only discovered the conflict at check-in time.
    const c = buildHappyClient();
    (c.rpc as any) = (name: string, _args: any) => {
      callLog.push(`rpc:${name}`);
      return Promise.resolve({
        data: { file_id: "fi1", version_id: "ve1", lock_id: null, created: false },
        error: null,
      });
    };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: any;
    await act(async () => {
      returned = await result.current.hook.run("v1", localFileRoot);
    });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(returned).toEqual({ ok: true, lockAcquired: false, alreadyExisted: true });
    expect(result.current.hook.error).toBeNull();
  });

  it("forwards correct args to pdm_add_and_lock", async () => {
    const rpcCalls: Array<{ name: string; args: any }> = [];
    const c = buildHappyClient();
    (c.rpc as any) = (name: string, args: any) => {
      callLog.push(`rpc:${name}`);
      rpcCalls.push({ name, args });
      return Promise.resolve({
        data: {
          file_id: "fi1",
          version_id: "ve1",
          lock_id: "lo1",
        },
        error: null,
      });
    };

    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    await act(async () => { await result.current.hook.run("v1", localFileRoot); });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("pdm_add_and_lock");
    expect(rpcCalls[0].args).toMatchObject({
      p_vault_id: "v1",
      p_folder_id: null,
      p_name: "part.sldprt",
      p_size: 3,
    });
    expect(typeof rpcCalls[0].args.p_sha256).toBe("string");
    expect(rpcCalls[0].args.p_sha256.length).toBe(64);
    expect(typeof rpcCalls[0].args.p_comment).toBe("string");
  });

  it("surfaces RPC error and returns ok:false", async () => {
    const c = buildHappyClient();
    (c.rpc as any) = (name: string, _args: any) => {
      callLog.push(`rpc:${name}`);
      return Promise.resolve({ data: null, error: { message: "race: file exists" } });
    };

    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: any;
    await act(async () => {
      returned = await result.current.hook.run("v1", localFileRoot);
    });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(returned.ok).toBe(false);
    expect(returned.error).toMatch(/add_and_lock.*race: file exists/);
    expect(result.current.hook.error?.message).toMatch(/add_and_lock.*race: file exists/);
  });

  it("nested file: looks up + creates each folder segment", async () => {
    const c = buildHappyClient();
    const nested = { ...localFileRoot, relativePath: "Engine/Internals/cylinder.sldprt", basename: "cylinder.sldprt" };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    await act(async () => { await result.current.hook.run("v1", nested); });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(result.current.hook.error?.message ?? null).toBeNull();
    // 2 folder lookups (Engine, Internals) + 2 folder inserts + the file flow
    expect(callLog.filter((s) => s === "folders.lookup")).toHaveLength(2);
    expect(callLog.filter((s) => s === "folders.insert")).toHaveLength(2);
  });

  it("nested file with existing parent: only creates the missing leaf", async () => {
    const c = buildHappyClient();
    // Override folders mock so the FIRST lookup (Engine) returns a hit but the
    // second (Internals under Engine) returns nothing.
    let lookupCount = 0;
    (c.from as any).mockImplementation((table: string) => {
      if (table === "files") {
        return {
          insert: () => ({
            select: () => ({
              single: () => { callLog.push("files.insert"); return Promise.resolve({ data: FILE_ROW, error: null }); },
            }),
          }),
        };
      }
      if (table === "locks") {
        return { insert: () => { callLog.push("locks.insert"); return Promise.resolve({ data: { id: "l1" }, error: null }); } };
      }
      if (table === "folders") {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                eq: () => ({
                  is: () => {
                    callLog.push("folders.lookup");
                    // First lookup is for Engine (parent_id is null) → return existing
                    lookupCount++;
                    return Promise.resolve({ data: [{ id: "engine-existing" }], error: null });
                  },
                  eq: () => {
                    callLog.push("folders.lookup");
                    lookupCount++;
                    return Promise.resolve({ data: [], error: null });
                  },
                }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: () => {
                callLog.push("folders.insert");
                return Promise.resolve({ data: { id: "internals-new" }, error: null });
              },
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    });

    const nested = { ...localFileRoot, relativePath: "Engine/Internals/cylinder.sldprt", basename: "cylinder.sldprt" };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    await act(async () => { await result.current.hook.run("v1", nested); });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(result.current.hook.error?.message ?? null).toBeNull();
    expect(callLog.filter((s) => s === "folders.lookup")).toHaveLength(2);
    // Only 1 insert because Engine already existed
    expect(callLog.filter((s) => s === "folders.insert")).toHaveLength(1);
  });

  it("retries by re-query when folder INSERT races against another caller", async () => {
    // Regression guard for the 2026-05-25 audit: useAddLocalFile.ts's
    // ensureFolderHierarchy has a critical retry-by-query path for "two
    // bulk-adds collide on the same brand-new deep folder". The first
    // lookup returns no row; the INSERT fails with a unique_violation;
    // the post-failure re-query finds the row another caller just inserted
    // and we reuse it. Without this branch, bulk-adds with deep paths
    // would fail half-the-time on the second-and-later items.
    const c = buildHappyClient();
    let lookupRound = 0;
    (c.from as any).mockImplementation((table: string) => {
      if (table === "files") {
        return {
          insert: () => ({
            select: () => ({
              single: () => { callLog.push("files.insert"); return Promise.resolve({ data: FILE_ROW, error: null }); },
            }),
          }),
        };
      }
      if (table === "locks") {
        return { insert: () => { callLog.push("locks.insert"); return Promise.resolve({ data: { id: "l1" }, error: null }); } };
      }
      if (table === "folders") {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                eq: () => ({
                  is: () => {
                    callLog.push("folders.lookup");
                    // 1st call: initial lookup — folder doesn't exist yet → []
                    // 2nd call: post-INSERT retry — another caller created it,
                    //           so it now exists.
                    lookupRound++;
                    if (lookupRound === 1) return Promise.resolve({ data: [], error: null });
                    return Promise.resolve({ data: [{ id: "race-created" }], error: null });
                  },
                  // Same as above for non-null parent — unused in this test
                  // because we use a single-segment relative path.
                  eq: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: () => {
                callLog.push("folders.insert");
                // Simulate a unique_violation as if another caller already
                // inserted this folder between our lookup and our INSERT.
                return Promise.resolve({
                  data: null,
                  error: {
                    code: "23505",
                    message: 'duplicate key value violates unique constraint "folders_vault_parent_name_key"',
                  },
                });
              },
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    });

    const oneLevelDeep = { ...localFileRoot, relativePath: "Engine/cylinder.sldprt", basename: "cylinder.sldprt" };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: any;
    await act(async () => { returned = await result.current.hook.run("v1", oneLevelDeep); });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    // The hook recovered: it did one INSERT (which failed) but then
    // re-queried, found the racing row, and proceeded with the file flow.
    expect(callLog.filter((s) => s === "folders.lookup")).toHaveLength(2);
    expect(callLog.filter((s) => s === "folders.insert")).toHaveLength(1);
    expect(callLog).toContain("storage.upload");
    expect(callLog).toContain("rpc:pdm_add_and_lock");
    expect(returned.ok).toBe(true);
    expect(result.current.hook.error?.message ?? null).toBeNull();
  });

  it("throws when folder INSERT fails AND the post-INSERT re-query also finds nothing", async () => {
    // The audit's other half: only the retry-by-query path is forgiving;
    // a true RLS denial (not a race) must still propagate, otherwise the
    // user would think their file was added when it wasn't.
    const c = buildHappyClient();
    (c.from as any).mockImplementation((table: string) => {
      if (table === "folders") {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                eq: () => ({
                  is: () => Promise.resolve({ data: [], error: null }),
                  eq: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({
                data: null,
                error: { code: "42501", message: "permission denied for table folders" },
              }),
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    });

    const oneLevelDeep = { ...localFileRoot, relativePath: "Engine/cylinder.sldprt", basename: "cylinder.sldprt" };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: any;
    await act(async () => { returned = await result.current.hook.run("v1", oneLevelDeep); });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(returned.ok).toBe(false);
    expect(returned.error).toMatch(/permission denied/i);
  });

  it("returns false and sets error when not authenticated", async () => {
    const c: any = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: vi.fn().mockReturnValue({ select: () => Promise.resolve({ data: null, error: null }) }),
    };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: any;
    await act(async () => {
      returned = await result.current.hook.run("v1", localFileRoot);
    });
    expect(returned.ok).toBe(false);
    expect(returned.error).toMatch(/not authenticated/i);
    expect(result.current.hook.error?.message).toMatch(/not authenticated/i);
  });

  // V8: the scan already computed local.sha256. Re-reading + re-hashing the
  // whole file (a 100MB+ CSV/CAD part) is wasteful and freezes the UI. The
  // hook must reuse local.sha256 and only read bytes when it actually needs to
  // upload them (object absent in storage).
  it("V8: reuses local.sha256 — no file read when the object already exists", async () => {
    const c = buildHappyClient();
    // Object already present in storage → no upload, so no bytes needed.
    listImpl = () => Promise.resolve({ data: [{ name: SCAN_SHA }], error: null });
    (c.rpc as any) = (name: string, _args: any) => {
      callLog.push(`rpc:${name}`);
      return Promise.resolve({ data: { lock_id: "lo1", created: true }, error: null });
    };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: any;
    await act(async () => { returned = await result.current.hook.run("v1", localFileRoot); });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(returned.ok).toBe(true);
    // The file was never read from disk — the scan's sha was reused.
    expect(readFileMock).not.toHaveBeenCalled();
    // And we never uploaded because the object was already present.
    expect(callLog).not.toContain("storage.upload");
  });

  it("V8: forwards the scan's sha256 + sizeBytes to the RPC without re-hashing", async () => {
    const rpcCalls: Array<{ args: any }> = [];
    const c = buildHappyClient();
    // Object already present → no upload, no read.
    listImpl = () => Promise.resolve({ data: [{ name: SCAN_SHA }], error: null });
    (c.rpc as any) = (name: string, args: any) => {
      callLog.push(`rpc:${name}`);
      rpcCalls.push({ args });
      return Promise.resolve({ data: { lock_id: "lo1", created: true }, error: null });
    };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    await act(async () => { await result.current.hook.run("v1", localFileRoot); });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.p_sha256).toBe(SCAN_SHA);
    expect(rpcCalls[0].args.p_size).toBe(localFileRoot.sizeBytes);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("V8: still reads the file to upload bytes when the object is absent", async () => {
    const c = buildHappyClient();
    // Default listImpl returns absent → must upload → must read bytes.
    (c.rpc as any) = (name: string, _args: any) => {
      callLog.push(`rpc:${name}`);
      return Promise.resolve({ data: { lock_id: "lo1", created: true }, error: null });
    };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: any;
    await act(async () => { returned = await result.current.hook.run("v1", localFileRoot); });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(returned.ok).toBe(true);
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(callLog).toContain("storage.upload");
    // Even after a real read, the sha sent to the RPC is the scan's sha.
  });

  // V7: objectExists used to return false on ANY transient list error, which
  // forced a doomed upsert:false upload (the object actually exists) and
  // surfaced a spurious error. An indeterminate list error must be treated as
  // "unknown" — re-probe / let the RPC be the source of truth — not "absent".
  it("V7: a transient list error does not force a failing upload when the object exists", async () => {
    const c = buildHappyClient();
    // First probe errors (indeterminate). The hook should re-probe; on the
    // second probe the object is found → skip upload entirely.
    let probe = 0;
    listImpl = () => {
      probe++;
      if (probe === 1) return Promise.resolve({ data: null, error: { message: "503 transient" } });
      return Promise.resolve({ data: [{ name: SCAN_SHA }], error: null });
    };
    (c.rpc as any) = (name: string, _args: any) => {
      callLog.push(`rpc:${name}`);
      return Promise.resolve({ data: { lock_id: "lo1", created: true }, error: null });
    };
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: any;
    await act(async () => { returned = await result.current.hook.run("v1", localFileRoot); });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(returned.ok).toBe(true);
    expect(result.current.hook.error).toBeNull();
    // Re-probed at least once after the transient error.
    expect(callLog.filter((s) => s === "storage.list").length).toBeGreaterThanOrEqual(2);
    // Found on re-probe → no spurious upload.
    expect(callLog).not.toContain("storage.upload");
  });
});
