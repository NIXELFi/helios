import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAutoSync } from "../../src/modules/vault/data/useAutoSync";
import type { Folder, Lock, VaultFile, Version } from "../../src/modules/vault/data/types";
import type { LocalFile } from "../../src/modules/vault/data/useLocalFolderScan";

// Mock useDownloadVersion so tests can both control timing per-sha (deferred
// promise) and capture which (sha, dest, signal) tuples actually executed.
const downloadCalls: Array<{ sha: string; dest: string; signal?: AbortSignal }> = [];
const downloadResolvers = new Map<string, (ok: boolean) => void>();

function deferredDownload(sha: string, dest: string, signal?: AbortSignal): Promise<boolean> {
  downloadCalls.push({ sha, dest, signal });
  return new Promise<boolean>((resolve) => {
    // Tests must use distinct shas per concurrent task to disambiguate.
    downloadResolvers.set(sha, resolve);
  });
}

vi.mock("../../src/modules/vault/data/useDownloadVersion", () => ({
  useDownloadVersion: () => ({
    run: deferredDownload,
    loading: false,
    error: null,
  }),
}));

// Capture setReadonly calls from the reconciliation pass. vi.hoisted so the
// array exists when the hoisted vi.mock factory runs.
const readonlyCalls = vi.hoisted(() => [] as Array<{ path: string; readonly: boolean }>);
vi.mock("../../src/modules/vault/data/fs-readonly", () => ({
  setReadonly: (path: string, readonly: boolean) => {
    readonlyCalls.push({ path, readonly });
    return Promise.resolve();
  },
  flipSwReadonly: vi.fn(),
}));

function resolveDownload(sha: string, ok = true): void {
  const r = downloadResolvers.get(sha);
  if (!r) throw new Error(`no pending download for sha ${sha}`);
  downloadResolvers.delete(sha);
  r(ok);
}

function makeFile(id: string, name: string, folderId: string | null = null): VaultFile {
  return {
    id, vault_id: "v1", folder_id: folderId, name,
    latest_version_id: `${id}-v1`, created_at: "2026-01-01T00:00:00Z",
  };
}

function makeVersion(fileId: string, sha: string, size = 100): Version {
  return {
    id: `${fileId}-v1`, file_id: fileId, version_num: 1,
    sha256: sha, size_bytes: size, author_id: "u1",
    comment: null, parent_version_id: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

// Stable-identity inputs are critical: the hook's `run` useCallback dep list
// includes `files / localFiles / versionsByFileId / locks / folders`, so a
// caller that hands fresh array identities every render would (correctly)
// cause supersedes. Real callers (BrowseScreen) feed values from React Query
// hooks with stable identities. Tests mirror that.
const EMPTY_LOCAL: LocalFile[] = [];
const EMPTY_LOCKS: Lock[] = [];
const EMPTY_FOLDERS: Folder[] = [];

describe("useAutoSync", () => {
  beforeEach(() => {
    downloadCalls.length = 0;
    downloadResolvers.clear();
    readonlyCalls.length = 0;
    localStorage.clear(); // reset the per-vault read-only migration flag
  });

  it("reconciles read-only bits to lock state (writable iff checked out by ME)", async () => {
    // All present files are synced (no downloads); the pass runs to reconcile.
    const files: VaultFile[] = [
      makeFile("f1", "a.bin"), makeFile("f2", "b.bin"), makeFile("f3", "c.bin"),
      makeFile("f4", "d.bin"), makeFile("f5", "e.bin"),
    ];
    const versionsByFileId = new Map<string, Version[]>([
      ["f1", [makeVersion("f1", "sha-a")]], ["f2", [makeVersion("f2", "sha-b")]],
      ["f3", [makeVersion("f3", "sha-c")]], ["f4", [makeVersion("f4", "sha-d")]],
      ["f5", [makeVersion("f5", "sha-e")]],
    ]);
    const localFiles: LocalFile[] = [
      // locked-by-me but read-only → made writable
      { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "sha-a", sizeBytes: 1, readonly: true },
      // unlocked, synced, writable → made read-only
      { basename: "b.bin", relativePath: "b.bin", absolutePath: "/v/b.bin", sha256: "sha-b", sizeBytes: 1, readonly: false },
      // unlocked, synced, already read-only → no toggle
      { basename: "c.bin", relativePath: "c.bin", absolutePath: "/v/c.bin", sha256: "sha-c", sizeBytes: 1, readonly: true },
      // locked by ANOTHER user, synced, writable → read-only for ME (not my lock)
      { basename: "d.bin", relativePath: "d.bin", absolutePath: "/v/d.bin", sha256: "sha-d", sizeBytes: 1, readonly: false },
      // f5 (e.bin) is locked-by-me but MISSING locally → no chmod possible
    ];
    const locks: Lock[] = [
      { id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null },
      { id: "l2", file_id: "f4", user_id: "u2", acquired_at: "x", released_at: null, force_released_by: null },
      { id: "l3", file_id: "f5", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null },
    ];
    const { result } = renderHook(() =>
      useAutoSync({
        enabled: true, files, localFiles, versionsByFileId, locks,
        currentUserId: "u1", vaultRoot: "/v", folders: EMPTY_FOLDERS, onComplete: () => {},
      }),
    );
    await waitFor(() => { expect(result.current.lastRunAt).not.toBeNull(); });
    expect(downloadCalls).toHaveLength(0);
    expect(readonlyCalls).toContainEqual({ path: "/v/a.bin", readonly: false }); // mine → writable
    expect(readonlyCalls).toContainEqual({ path: "/v/b.bin", readonly: true });  // unlocked synced → RO
    expect(readonlyCalls).toContainEqual({ path: "/v/d.bin", readonly: true });  // other's lock → RO for me
    expect(readonlyCalls.find((c) => c.path === "/v/c.bin")).toBeUndefined();    // already RO → no-op
    expect(readonlyCalls.find((c) => c.path.includes("e.bin"))).toBeUndefined(); // missing → no chmod
  });

  it("holds back a WRITABLE, unlocked, modified file (possible unsaved edit) — never clobbers or freezes it", async () => {
    const files: VaultFile[] = [makeFile("f1", "a.bin")];
    const versionsByFileId = new Map<string, Version[]>([["f1", [makeVersion("f1", "sha-latest")]]]);
    const localFiles: LocalFile[] = [
      { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "sha-LOCAL-DIFFERS", sizeBytes: 1, readonly: false },
    ];
    const { result } = renderHook(() =>
      useAutoSync({
        enabled: true, files, localFiles, versionsByFileId, locks: EMPTY_LOCKS,
        currentUserId: "u1", vaultRoot: "/v", folders: EMPTY_FOLDERS, onComplete: () => {},
      }),
    );
    await waitFor(() => { expect(result.current.lastRunAt).not.toBeNull(); });
    expect(downloadCalls.find((c) => c.sha === "sha-latest")).toBeUndefined(); // not overwritten
    expect(result.current.lastHeldBack).toBe(1);
    // Not frozen read-only either — the user can still recover / check it in.
    expect(readonlyCalls.find((c) => c.path === "/v/a.bin" && c.readonly === true)).toBeUndefined();
  });

  it("refreshes a READ-ONLY, unlocked, stale file (clean copy; a newer version landed)", async () => {
    const files: VaultFile[] = [makeFile("f1", "a.bin")];
    const versionsByFileId = new Map<string, Version[]>([["f1", [makeVersion("f1", "sha-latest")]]]);
    const localFiles: LocalFile[] = [
      { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "sha-OLD", sizeBytes: 1, readonly: true },
    ];
    const { result } = renderHook(() =>
      useAutoSync({
        enabled: true, files, localFiles, versionsByFileId, locks: EMPTY_LOCKS,
        currentUserId: "u1", vaultRoot: "/v", folders: EMPTY_FOLDERS, onComplete: () => {},
      }),
    );
    await waitFor(() => { expect(downloadResolvers.has("sha-latest")).toBe(true); });
    await act(async () => { resolveDownload("sha-latest", true); });
    await waitFor(() => { expect(result.current.busy).toBe(false); });
    expect(result.current.lastDownloaded).toBe(1); // refreshed, not held back
    expect(result.current.lastHeldBack).toBe(0);
  });

  it("freezes a just-downloaded file read-only immediately after a successful download", async () => {
    // A freshly-downloaded vault copy is always a clean copy (the user's
    // edited/locked files are held back earlier in the pass), so the download
    // worker freezes it read-only right away — closing the window where the
    // file is briefly writable before post-pass reconciliation runs.
    const files: VaultFile[] = [makeFile("f1", "a.bin")];
    const versionsByFileId = new Map<string, Version[]>([["f1", [makeVersion("f1", "sha-fresh")]]]);
    // No local copy → it's a download (missing file).
    const { result } = renderHook(() =>
      useAutoSync({
        enabled: true, files, localFiles: EMPTY_LOCAL, versionsByFileId, locks: EMPTY_LOCKS,
        currentUserId: "u1", vaultRoot: "/v", folders: EMPTY_FOLDERS, onComplete: () => {},
      }),
    );
    await waitFor(() => { expect(downloadResolvers.has("sha-fresh")).toBe(true); });
    await act(async () => { resolveDownload("sha-fresh", true); });
    await waitFor(() => { expect(result.current.busy).toBe(false); });
    expect(result.current.lastDownloaded).toBe(1);
    // The download worker froze the just-downloaded destination read-only.
    expect(readonlyCalls).toContainEqual({ path: "/v/a.bin", readonly: true });
  });

  it("does not freeze a file whose download FAILED", async () => {
    const files: VaultFile[] = [makeFile("f1", "a.bin")];
    const versionsByFileId = new Map<string, Version[]>([["f1", [makeVersion("f1", "sha-fail")]]]);
    const { result } = renderHook(() =>
      useAutoSync({
        enabled: true, files, localFiles: EMPTY_LOCAL, versionsByFileId, locks: EMPTY_LOCKS,
        currentUserId: "u1", vaultRoot: "/v", folders: EMPTY_FOLDERS, onComplete: () => {},
      }),
    );
    await waitFor(() => { expect(downloadResolvers.has("sha-fail")).toBe(true); });
    await act(async () => { resolveDownload("sha-fail", false); });
    await waitFor(() => { expect(result.current.busy).toBe(false); });
    expect(result.current.lastFailed).toBe(1);
    // Failed download → nothing on disk to freeze.
    expect(readonlyCalls.find((c) => c.path === "/v/a.bin")).toBeUndefined();
  });

  it("does not double-execute when multiple renders happen before the run starts", async () => {
    // Stable identities — caller would be passing memoized values from React
    // Query. Re-rendering with the same values must not cause two passes.
    const files: VaultFile[] = [makeFile("f1", "a.bin")];
    const versionsByFileId = new Map<string, Version[]>([
      ["f1", [makeVersion("f1", "sha-1")]],
    ]);

    const input = {
      enabled: true,
      files,
      localFiles: EMPTY_LOCAL,
      versionsByFileId,
      locks: EMPTY_LOCKS,
      currentUserId: "u1",
      vaultRoot: "/tmp/vault",
      folders: EMPTY_FOLDERS,
      onComplete: () => {},
    };

    const { rerender } = renderHook(({ inp }) => useAutoSync(inp), {
      initialProps: { inp: input },
    });
    // Trigger a couple of cheap re-renders with the SAME object identities;
    // these must not double-schedule, and once the timer fires only one run
    // should execute.
    rerender({ inp: input });
    rerender({ inp: input });

    await waitFor(() => { expect(downloadResolvers.has("sha-1")).toBe(true); });
    await act(async () => { resolveDownload("sha-1", true); });

    expect(downloadCalls.filter((c) => c.sha === "sha-1")).toHaveLength(1);
  });

  it("tracks two files with the same basename in different folders as separate activeFiles entries", async () => {
    // Two files named 'design.sldprt' in distinct folders. With concurrency=2
    // both go in flight; the pre-fix dedup-by-name bug would drop BOTH rows
    // when the first finished. Task-id-keyed tracking keeps the other row.
    const folders: Folder[] = [
      { id: "fa", vault_id: "v1", parent_id: null, name: "chassis", created_at: "x" },
      { id: "fb", vault_id: "v1", parent_id: null, name: "suspension", created_at: "x" },
    ];
    const files: VaultFile[] = [
      makeFile("f1", "design.sldprt", "fa"),
      makeFile("f2", "design.sldprt", "fb"),
    ];
    const versionsByFileId = new Map<string, Version[]>([
      ["f1", [makeVersion("f1", "sha-A")]],
      ["f2", [makeVersion("f2", "sha-B")]],
    ]);

    const { result } = renderHook(() =>
      useAutoSync({
        enabled: true,
        files,
        localFiles: EMPTY_LOCAL,
        versionsByFileId,
        locks: EMPTY_LOCKS,
        currentUserId: "u1",
        vaultRoot: "/tmp/vault",
        folders,
        onComplete: () => {},
      }),
    );

    // Both workers should start (concurrency=2, exactly 2 tasks).
    await waitFor(() => {
      expect(downloadResolvers.has("sha-A")).toBe(true);
      expect(downloadResolvers.has("sha-B")).toBe(true);
    });

    // Both basenames are present despite being identical strings.
    await waitFor(() => {
      expect(result.current.activeFiles).toHaveLength(2);
    });
    expect(result.current.activeFiles).toEqual(["design.sldprt", "design.sldprt"]);

    // Finish one — only ONE entry should remain (filename-keyed dedup would
    // have dropped both here).
    await act(async () => { resolveDownload("sha-A", true); });
    await waitFor(() => {
      expect(result.current.activeFiles).toHaveLength(1);
    });
    expect(result.current.activeFiles).toEqual(["design.sldprt"]);

    // Finish the second — activeFiles drains and the pass commits.
    await act(async () => { resolveDownload("sha-B", true); });
    await waitFor(() => { expect(result.current.busy).toBe(false); });
    expect(result.current.activeFiles).toEqual([]);
    expect(result.current.lastDownloaded).toBe(2);
  });

  it("drops state writes from a superseded generation after deps change mid-flight", async () => {
    // Start a run, let it begin a download, then change deps so the trigger
    // effect supersedes the in-flight generation. The stale run's completion
    // write must not land — its `lastDownloaded` was computed against the old
    // versionsByFileId snapshot, and committing it would mask the fresher
    // run's results.
    const filesA: VaultFile[] = [makeFile("f1", "old.bin")];
    const versionsA = new Map<string, Version[]>([
      ["f1", [makeVersion("f1", "sha-old")]],
    ]);
    const filesB: VaultFile[] = [makeFile("f2", "new.bin")];
    const versionsB = new Map<string, Version[]>([
      ["f2", [makeVersion("f2", "sha-new")]],
    ]);

    const baseInput = {
      enabled: true,
      localFiles: EMPTY_LOCAL,
      locks: EMPTY_LOCKS,
      currentUserId: "u1",
      vaultRoot: "/tmp/vault",
      folders: EMPTY_FOLDERS,
      onComplete: () => {},
    };

    const { result, rerender } = renderHook(
      ({ files, versionsByFileId }) =>
        useAutoSync({ ...baseInput, files, versionsByFileId }),
      { initialProps: { files: filesA, versionsByFileId: versionsA } },
    );

    // Wait until the gen-N run is actually downloading sha-old.
    await waitFor(() => { expect(downloadResolvers.has("sha-old")).toBe(true); });
    await waitFor(() => { expect(result.current.busy).toBe(true); });

    const statusBefore = result.current;

    // Bump deps — the trigger effect re-runs, supersedes gen N (sets its
    // activeGen to 0), and schedules gen N+1 via the cooldown timer.
    rerender({ files: filesB, versionsByFileId: versionsB });

    // Let the OLD run finish its in-flight download. Its post-download writes
    // — including the terminal commit — must be dropped because gen-N is no
    // longer authoritative.
    await act(async () => { resolveDownload("sha-old", true); });
    // Give the old run a chance to attempt its final setStatus.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    // The stale run's terminal write would have set lastDownloaded=1 +
    // lastRunAt; neither landed.
    expect(result.current.lastDownloaded).toBe(statusBefore.lastDownloaded);
    expect(result.current.lastRunAt).toBe(statusBefore.lastRunAt);

    // The new gen-(N+1) run takes over and downloads sha-new.
    await waitFor(() => { expect(downloadResolvers.has("sha-new")).toBe(true); });
    await act(async () => { resolveDownload("sha-new", true); });
    await waitFor(() => { expect(result.current.busy).toBe(false); });
    expect(result.current.lastDownloaded).toBe(1);

    // The old sha-old download fetch was kicked off exactly once — we don't
    // double-fetch even though its writes were abandoned.
    expect(downloadCalls.filter((c) => c.sha === "sha-old")).toHaveLength(1);
    expect(downloadCalls.filter((c) => c.sha === "sha-new")).toHaveLength(1);
  });

  it("aborts the in-flight download's AbortSignal on supersession", async () => {
    // Regression guard for the 2026-05-25 audit fix: useAutoSync now threads
    // an AbortController per generation through downloadVersionOnce. When the
    // trigger effect supersedes a run, the controller is aborted — so the
    // download path checks signal.aborted before its terminal writeFile and
    // bails out without overwriting the destination.
    //
    // Without the AbortController, a slow superseded run could still write
    // bytes to disk after the new run has already replaced them, producing
    // a torn-write race.
    const filesA: VaultFile[] = [makeFile("f1", "old.bin")];
    const versionsA = new Map<string, Version[]>([
      ["f1", [makeVersion("f1", "sha-old-abort")]],
    ]);
    const filesB: VaultFile[] = [makeFile("f2", "new.bin")];
    const versionsB = new Map<string, Version[]>([
      ["f2", [makeVersion("f2", "sha-new-abort")]],
    ]);

    const baseInput = {
      enabled: true,
      localFiles: EMPTY_LOCAL,
      locks: EMPTY_LOCKS,
      currentUserId: "u1",
      vaultRoot: "/tmp/vault",
      folders: EMPTY_FOLDERS,
      onComplete: () => {},
    };

    const { rerender } = renderHook(
      ({ files, versionsByFileId }) =>
        useAutoSync({ ...baseInput, files, versionsByFileId }),
      { initialProps: { files: filesA, versionsByFileId: versionsA } },
    );

    // Wait until run-1 dispatched the download with a signal.
    await waitFor(() => {
      const firstCall = downloadCalls.find((c) => c.sha === "sha-old-abort");
      expect(firstCall).toBeDefined();
      expect(firstCall!.signal).toBeDefined();
    });
    const firstCall = downloadCalls.find((c) => c.sha === "sha-old-abort")!;
    // Before supersession the signal must not be aborted.
    expect(firstCall.signal!.aborted).toBe(false);

    // Trigger supersession.
    rerender({ files: filesB, versionsByFileId: versionsB });

    // After supersession the run-1 controller must have been aborted, so
    // downloadVersionOnce will skip its writeFile.
    expect(firstCall.signal!.aborted).toBe(true);

    // Clean up: resolve the pending download so the test exits.
    await act(async () => { resolveDownload("sha-old-abort", true); });
    await waitFor(() => { expect(downloadResolvers.has("sha-new-abort")).toBe(true); });
    await act(async () => { resolveDownload("sha-new-abort", true); });
  });

  it("honors the cooldown after a superseded run finishes (lastFinishedAt is not left stale)", async () => {
    // Regression guard for the audit fix: a superseded run skips the final-
    // commit block, so it used to never set `lastFinishedAt`. With the cooldown
    // measuring `Date.now() - lastFinishedAt` and lastFinishedAt stuck at 0, a
    // later trigger would compute wait=0 and fire immediately — defeating the
    // 2s cooldown that throttles dependency churn. The reset of run-owned state
    // (lastFinishedAt + activeGenRef-if-still-owned) must run regardless of
    // isCurrent(), so the cooldown is honored after ANY completion.
    //
    // Isolation: we keep gen-2 in flight (never resolved) and supersede it with
    // gen-3. gen-3's timer reads `lastFinishedAt` at SCHEDULE time, so the only
    // thing that could have set it is gen-1's superseded completion. If the
    // superseded run failed to set it (the bug), gen-3 fires at wait=0; with the
    // fix it must wait the cooldown.
    vi.useFakeTimers();
    try {
      const filesA: VaultFile[] = [makeFile("f1", "a.bin")];
      const versionsA = new Map<string, Version[]>([
        ["f1", [makeVersion("f1", "sha-cd-1")]],
      ]);
      const filesB: VaultFile[] = [makeFile("f2", "b.bin")];
      const versionsB = new Map<string, Version[]>([
        ["f2", [makeVersion("f2", "sha-cd-2")]],
      ]);
      const filesC: VaultFile[] = [makeFile("f3", "c.bin")];
      const versionsC = new Map<string, Version[]>([
        ["f3", [makeVersion("f3", "sha-cd-3")]],
      ]);

      const baseInput = {
        enabled: true,
        localFiles: EMPTY_LOCAL,
        locks: EMPTY_LOCKS,
        currentUserId: "u1",
        vaultRoot: "/tmp/vault",
        folders: EMPTY_FOLDERS,
        onComplete: () => {},
      };

      const { rerender } = renderHook(
        ({ files, versionsByFileId }) =>
          useAutoSync({ ...baseInput, files, versionsByFileId }),
        { initialProps: { files: filesA, versionsByFileId: versionsA } },
      );

      // gen-1's trigger timer fires (wait=0 since lastFinishedAt starts at 0).
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(downloadResolvers.has("sha-cd-1")).toBe(true);

      // Supersede gen-1 with gen-2. gen-2's timer is scheduled with wait=0
      // (lastFinishedAt still 0 here). Let it fire so gen-2 is now in flight.
      rerender({ files: filesB, versionsByFileId: versionsB });
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(downloadResolvers.has("sha-cd-2")).toBe(true);

      // NOW let the superseded gen-1 download resolve. Its post-download path
      // must run the reset (set lastFinishedAt) even though its final commit is
      // dropped by the isCurrent() guard, and it must NOT zero the activeGenRef
      // that gen-2 now owns.
      await act(async () => { resolveDownload("sha-cd-1", true); });
      await act(async () => { await Promise.resolve(); });

      // Supersede gen-2 (still in flight) with gen-3. gen-3's timer is scheduled
      // now, reading lastFinishedAt — which gen-1's finish set. So gen-3 must
      // wait the cooldown, not fire immediately.
      rerender({ files: filesC, versionsByFileId: versionsC });

      // Short advance: gen-3 must NOT have started.
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(downloadResolvers.has("sha-cd-3")).toBe(false);

      // After the cooldown elapses, gen-3 fires.
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(downloadResolvers.has("sha-cd-3")).toBe(true);

      // Clean up in-flight downloads.
      if (downloadResolvers.has("sha-cd-2")) {
        await act(async () => { resolveDownload("sha-cd-2", true); });
      }
      await act(async () => { resolveDownload("sha-cd-3", true); });
    } finally {
      vi.useRealTimers();
    }
  });
});
