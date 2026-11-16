/**
 * useAutoAddDrafts — pass behaviour (2026-11-16 upload-throughput fix).
 *
 * A teammate's 240-file test-data drop ran at ~10–40 s per file because every
 * add changed the `unmatched` list (the realtime patch lands the new row), the
 * effect's cleanup cancelled the running pass after one or two files, and the
 * next pass started over: ledger load, a stat of every unmatched file, and a
 * full vault refetch (`onAdded`) between EVERY pair of files.
 *
 * The pass now runs to completion across `unmatched` churn, skips files that
 * were matched meanwhile, calls `onAdded` once, and still stops on a vault
 * switch / disable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { LocalFile } from "../useLocalFolderScan";

const stat = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: (...args: unknown[]) => stat(...args),
}));

vi.mock("../sync-ledger", async (orig) => {
  const real = await orig<typeof import("../sync-ledger")>();
  return { ...real, loadLedger: vi.fn(async () => real.emptyLedger()) };
});

// Each add is held open until the test releases it, so we can change props
// while a pass is mid-flight.
const addCalls: Array<{ path: string; resolve: () => void }> = [];
const run = vi.fn(
  (_vault: string, f: LocalFile) =>
    new Promise<{ ok: true; lockAcquired: boolean; alreadyExisted: boolean }>((resolve) => {
      addCalls.push({
        path: f.relativePath,
        resolve: () => resolve({ ok: true, lockAcquired: true, alreadyExisted: false }),
      });
    }),
);
vi.mock("../useAddLocalFile", () => ({
  useAddLocalFile: () => ({ run, loading: false, error: null }),
}));

import { useAutoAddDrafts, stillUnmatched } from "../useAutoAddDrafts";

const lf = (rel: string, sha = `sha-${rel}`): LocalFile => ({
  basename: rel.split("/").pop()!,
  relativePath: rel,
  absolutePath: `/v/${rel}`,
  sha256: sha,
  sizeBytes: 10,
});

async function releaseNext(expectPath: string) {
  await waitFor(() => expect(addCalls.length).toBeGreaterThan(0));
  const call = addCalls.shift()!;
  expect(call.path).toBe(expectPath);
  await act(async () => {
    call.resolve();
  });
}

beforeEach(() => {
  addCalls.length = 0;
  run.mockClear();
  stat.mockReset();
  stat.mockResolvedValue({ mtime: new Date(Date.now() - 60_000) });
});

describe("stillUnmatched", () => {
  it("matches on path AND content", () => {
    const a = lf("a.csv");
    expect(stillUnmatched([a], a)).toBe(true);
    expect(stillUnmatched([], a)).toBe(false);
    expect(stillUnmatched([lf("a.csv", "other")], a)).toBe(false);
  });
});

describe("useAutoAddDrafts pass", () => {
  it("keeps adding through unmatched churn and refreshes once at the end", async () => {
    const files = [lf("d/1.csv"), lf("d/2.csv"), lf("d/3.csv")];
    const onAdded = vi.fn();
    const { rerender } = renderHook((p: { unmatched: LocalFile[] }) =>
      useAutoAddDrafts({ vaultId: "v1" as never, enabled: true, unmatched: p.unmatched, onAdded }),
      { initialProps: { unmatched: files } },
    );

    await releaseNext("d/1.csv");
    // The realtime patch lands file 1 → unmatched shrinks. Old code cancelled here.
    rerender({ unmatched: files.slice(1) });
    await releaseNext("d/2.csv");
    rerender({ unmatched: files.slice(2) });
    await releaseNext("d/3.csv");

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("skips a file that was matched while the pass was running", async () => {
    const files = [lf("1.csv"), lf("2.csv"), lf("3.csv")];
    const onAdded = vi.fn();
    const { rerender } = renderHook((p: { unmatched: LocalFile[] }) =>
      useAutoAddDrafts({ vaultId: "v1" as never, enabled: true, unmatched: p.unmatched, onAdded }),
      { initialProps: { unmatched: files } },
    );
    await waitFor(() => expect(addCalls.length).toBe(1));
    // Someone else's add (or a manual one) lands 2.csv meanwhile.
    rerender({ unmatched: [files[0]!, files[2]!] });
    await releaseNext("1.csv");
    await releaseNext("3.csv");
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(run.mock.calls.map((c) => (c[1] as LocalFile).relativePath)).toEqual(["1.csv", "3.csv"]);
  });

  it("stops after the in-flight file when the vault switches", async () => {
    const files = [lf("1.csv"), lf("2.csv")];
    const onAdded = vi.fn();
    const { rerender } = renderHook(
      (p: { vaultId: string; unmatched: LocalFile[] }) =>
        useAutoAddDrafts({ vaultId: p.vaultId as never, enabled: true, unmatched: p.unmatched, onAdded }),
      { initialProps: { vaultId: "v1", unmatched: files } },
    );
    await waitFor(() => expect(addCalls.length).toBe(1));
    rerender({ vaultId: "v2", unmatched: [] });
    await releaseNext("1.csv");
    // Give the (stopped) loop a chance to misbehave.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("picks up files that appeared mid-pass once the pass drains", async () => {
    const onAdded = vi.fn();
    const { rerender } = renderHook((p: { unmatched: LocalFile[] }) =>
      useAutoAddDrafts({ vaultId: "v1" as never, enabled: true, unmatched: p.unmatched, onAdded }),
      { initialProps: { unmatched: [lf("1.csv")] } },
    );
    await waitFor(() => expect(addCalls.length).toBe(1));
    rerender({ unmatched: [lf("1.csv"), lf("late.csv")] });
    await releaseNext("1.csv");
    rerender({ unmatched: [lf("late.csv")] });
    await releaseNext("late.csv");
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(2));
  });
});
