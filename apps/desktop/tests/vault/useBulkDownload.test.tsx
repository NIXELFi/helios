import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useBulkDownload } from "../../src/modules/vault/data/useBulkDownload";
import type { VaultFile, Version } from "../../src/modules/vault/data/types";

// Mock downloadVersionOnce — the hook calls this for every file. Each call
// stays pending until the test resolves it via resolveDownload(sha, ok). This
// is the deferred-promise pattern from useAutoSync.test.tsx, adapted for the
// (sha, destPath) -> {ok, error} signature.
const downloadCalls: Array<{ sha: string; dest: string }> = [];
const downloadResolvers = new Map<
  string,
  (v: { ok: true } | { ok: false; error: string }) => void
>();

function deferredDownload(
  _client: unknown,
  sha: string,
  dest: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  downloadCalls.push({ sha, dest });
  return new Promise((resolve) => {
    downloadResolvers.set(sha, resolve);
  });
}

function resolveDownload(sha: string, ok = true): void {
  const r = downloadResolvers.get(sha);
  if (!r) throw new Error(`no pending download for sha ${sha}`);
  downloadResolvers.delete(sha);
  r(ok ? { ok: true } : { ok: false, error: "boom" });
}

vi.mock("../../src/modules/vault/data/useDownloadVersion", () => ({
  downloadVersionOnce: deferredDownload,
}));

// stat() in useBulkDownload is the "is the local file already up to date?"
// probe — throwing means "file doesn't exist on disk, please download it".
vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: vi.fn(() => Promise.reject(new Error("ENOENT"))),
}));

// openDirDialog is only invoked when heliosRoot is null — we pass a non-null
// root so the dialog never fires. Stub anyway for safety.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
}));

function makeFile(id: string, name: string): VaultFile {
  return {
    id,
    vault_id: "v1",
    folder_id: null,
    name,
    latest_version_id: `${id}-v1`,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeVersion(fileId: string, sha: string, size = 100): Version {
  return {
    id: `${fileId}-v1`,
    file_id: fileId,
    version_num: 1,
    sha256: sha,
    size_bytes: size,
    author_id: null,
    comment: null,
    parent_version_id: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function fakeClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  } as any;
}

const wrap = (c: SupabaseClient) =>
  ({ children }: { children: ReactNode }) =>
    <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;

describe("useBulkDownload", () => {
  beforeEach(() => {
    downloadCalls.length = 0;
    downloadResolvers.clear();
  });

  it("downloads all files when started, then closes the run", async () => {
    const files = [makeFile("f1", "a.bin"), makeFile("f2", "b.bin")];
    const versionsByFileId = new Map<string, Version[]>([
      ["f1", [makeVersion("f1", "sha-1")]],
      ["f2", [makeVersion("f2", "sha-2")]],
    ]);
    const { result } = renderHook(
      () =>
        useBulkDownload({
          heliosRoot: "/tmp",
          vaultName: "test",
          folders: [],
          versionsByFileId,
        }),
      { wrapper: wrap(fakeClient()) },
    );

    await act(async () => { result.current.start(files); });
    await waitFor(() => expect(downloadCalls.length).toBe(2));

    await act(async () => {
      resolveDownload("sha-1", true);
      resolveDownload("sha-2", true);
    });
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(result.current.done).toBe(2);
    expect(result.current.errs).toBe(0);
  });

  it("Cancel→Start does not leak run-1 workers into run-2's downloads", async () => {
    // The 2026-05-25 audit's HIGH finding: useBulkDownload.ts resets
    // cancelRef.current=false on every start(). If a user clicks Cancel and
    // immediately Start with a new file list, a run-1 worker whose
    // downloadVersionOnce is still pending will see cancelRef flip back to
    // false on its next loop iteration and pull the NEXT file from run-1's
    // (now-stale) downloadable array — leaking into the new run.
    //
    // Setup: 10 files in run 1, WORKERS=8 → workers grab files 0-7. Files 8
    // and 9 remain. If the bug is present, after Cancel+Start, resolving any
    // of the pending run-1 downloads lets that worker grab file 8 or 9.
    const run1Files = Array.from({ length: 10 }, (_, i) =>
      makeFile(`r1-f${i}`, `r1-f${i}.bin`),
    );
    const run2Files = Array.from({ length: 3 }, (_, i) =>
      makeFile(`r2-f${i}`, `r2-f${i}.bin`),
    );
    const versionsByFileId = new Map<string, Version[]>();
    for (const f of run1Files) {
      versionsByFileId.set(f.id, [makeVersion(f.id, `r1-${f.id}`)]);
    }
    for (const f of run2Files) {
      versionsByFileId.set(f.id, [makeVersion(f.id, `r2-${f.id}`)]);
    }

    const { result } = renderHook(
      () =>
        useBulkDownload({
          heliosRoot: "/tmp",
          vaultName: "test",
          folders: [],
          versionsByFileId,
        }),
      { wrapper: wrap(fakeClient()) },
    );

    await act(async () => { result.current.start(run1Files); });
    await waitFor(() => expect(downloadCalls.length).toBe(8));

    // Verify run-1 grabbed files 0-7 and NOT 8 or 9 yet.
    expect(downloadCalls.map((c) => c.sha).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `r1-r1-f${i}`).sort(),
    );

    // Cancel run 1.
    act(() => { result.current.cancel(); });

    // Immediately start run 2 — the buggy code resets the cancel flag here.
    await act(async () => { result.current.start(run2Files); });
    await waitFor(() =>
      expect(downloadCalls.filter((c) => c.sha.startsWith("r2-")).length).toBe(3),
    );

    // Now resolve all of run-1's pending downloads. If the bug is present,
    // a run-1 worker will loop, see the flag cleared, and grab file 8 or 9.
    await act(async () => {
      for (let i = 0; i < 8; i++) resolveDownload(`r1-r1-f${i}`, true);
    });

    // Settle any microtasks.
    await new Promise((r) => setTimeout(r, 50));

    const leakedR1Calls = downloadCalls.filter(
      (c) => c.sha === "r1-r1-f8" || c.sha === "r1-r1-f9",
    );
    expect(leakedR1Calls).toEqual([]);

    // Resolve run 2's downloads cleanly so the test exits.
    await act(async () => {
      for (let i = 0; i < 3; i++) resolveDownload(`r2-r2-f${i}`, true);
    });
    await waitFor(() => expect(result.current.running).toBe(false));
  });

  it("cancel() stops a run that hasn't been restarted", async () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile(`g${i}`, `g${i}.bin`),
    );
    const versionsByFileId = new Map<string, Version[]>();
    for (const f of files) versionsByFileId.set(f.id, [makeVersion(f.id, `sha-${f.id}`)]);

    const { result } = renderHook(
      () =>
        useBulkDownload({
          heliosRoot: "/tmp",
          vaultName: "test",
          folders: [],
          versionsByFileId,
        }),
      { wrapper: wrap(fakeClient()) },
    );

    await act(async () => { result.current.start(files); });
    await waitFor(() => expect(downloadCalls.length).toBe(8));

    act(() => { result.current.cancel(); });

    // Resolve the 8 in-flight downloads.
    await act(async () => {
      for (let i = 0; i < 8; i++) resolveDownload(`sha-g${i}`, true);
    });
    await new Promise((r) => setTimeout(r, 50));

    // After cancel, workers must NOT continue past files 0-7.
    expect(downloadCalls.length).toBe(8);
    expect(downloadCalls.find((c) => c.sha === "sha-g8" || c.sha === "sha-g9"))
      .toBeUndefined();
  });
});
