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

const localFile = {
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
            // First call: acquire; second call: re-acquire
            callLog.push("locks.insert");
            return Promise.resolve({ data: { id: "l1" }, error: null });
          },
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

  it("happy path: fires all 6 steps in order and returns true", async () => {
    const c = buildHappyClient();
    const { result } = renderHook(
      () => ({ hook: useAddLocalFile([]), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    // Wait for auth to resolve so useUser() returns the user
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.hook.run("v1", localFile);
    });
    await waitFor(() => expect(result.current.hook.loading).toBe(false));

    expect(result.current.hook.error?.message ?? null).toBeNull();
    expect(returned).toBe(true);

    // Steps in order: create file row, upload bytes, acquire lock, check_in, re-acquire lock
    expect(callLog).toEqual([
      "files.insert",
      "storage.upload",
      "locks.insert",     // step 5: acquire
      "rpc:pdm_check_in", // step 6: check in (releases lock server-side)
      "locks.insert",     // step 7: re-acquire (default checked out)
    ]);
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
      () => ({ hook: useAddLocalFile([]), authLoading: useAuthLoading() }),
      { wrapper: wrap(c) },
    );
    await waitFor(() => expect(result.current.authLoading).toBe(false));

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.hook.run("v1", localFile);
    });
    expect(returned).toBe(false);
    expect(result.current.hook.error?.message).toMatch(/not authenticated/i);
  });
});
