import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider, useAuthLoading } from "@helios/auth";
import { useAddLocalFile } from "../../src/modules/vault/data/useAddLocalFile";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

const FILE_ROW = { id: "fi1", vault_id: "v1", folder_id: null, name: "part.sldprt", latest_version_id: null, created_at: "x" };

const localFileRoot = {
  basename: "part.sldprt",
  relativePath: "part.sldprt",
  absolutePath: "/vault/part.sldprt",
  sha256: "abc",
  sizeBytes: 3,
};

// Tracks which Supabase operations were called, in order.
let callLog: string[] = [];

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
          select: () => ({
            eq: () => ({
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
  beforeEach(() => { callLog = []; });

  it("happy path (root file): fires all 5 steps in order and returns true", async () => {
    const c = buildHappyClient();
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile(), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.hook.run("v1", localFileRoot);
    });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(result.current.hook.error?.message ?? null).toBeNull();
    expect(returned).toBe(true);

    // Root file means no folder lookups/creates. Steps in order:
    expect(callLog).toEqual([
      "files.insert",
      "storage.upload",
      "locks.insert",     // step 5: acquire
      "rpc:pdm_check_in", // step 6: check in (releases server-side)
      "locks.insert",     // step 7: re-acquire (default checked out)
    ]);
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

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.hook.run("v1", localFileRoot);
    });
    expect(returned).toBe(false);
    expect(result.current.hook.error?.message).toMatch(/not authenticated/i);
  });
});
