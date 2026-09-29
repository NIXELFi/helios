import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Tauri fs plugin so the IO half is unit-testable without a desktop
// shell. The factory is hoisted, so declare the mocks here and reach them via
// the imported (mocked) bindings below.
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppLocalData: "AppLocalData" },
  mkdir: vi.fn(),
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
}));

import { mkdir, writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import {
  __resetLedgerCacheForTests,
  classifyMissing,
  emptyLedger,
  flushLedger,
  ledgerRecord,
  ledgerRemove,
  ledgerTombstone,
  loadLedger,
  pruneExpiredTombstones,
  recordEntry,
  removeEntry,
  parseLedger,
  saveLedger,
  tombstoneEntry,
  TOMBSTONE_COOLOFF_MS,
  FLUSH_DEBOUNCE_MS,
} from "../sync-ledger";

describe("sync-ledger core", () => {
  it("records and removes entries by normalized relpath", () => {
    let l = recordEntry(emptyLedger(), "Chassis/frame.sldprt", "abc");
    expect(l.entries["chassis/frame.sldprt"]).toMatchObject({ sha256: "abc" });
    l = removeEntry(l, "CHASSIS/frame.sldprt");
    expect(Object.keys(l.entries)).toHaveLength(0);
  });
  it("parseLedger tolerates corrupt input (safe empty)", () => {
    expect(parseLedger("not json").entries).toEqual({});
    expect(parseLedger('{"entries": 5}').entries).toEqual({});
    expect(parseLedger('{"entries":{"a":{"sha256":"x","recordedAt":"t"}}}').entries.a!.sha256).toBe("x");
  });
  it("classifyMissing: only in-vault + in-ledger + missing-locally counts", () => {
    const ledger = recordEntry(emptyLedger(), "a/x.sldprt", "s1");
    // present locally → not deleted
    expect(classifyMissing(ledger, "a/x.sldprt", true)).toBe("present");
    // missing + in ledger → locally deleted
    expect(classifyMissing(ledger, "a/x.sldprt", false)).toBe("locally-deleted");
    // missing + NOT in ledger → never downloaded
    expect(classifyMissing(ledger, "a/y.sldprt", false)).toBe("never-downloaded");
  });

  // ── tombstone tests ─────────────────────────────────────────────────────────

  it("tombstoneEntry sets deletedAt and preserves sha256", () => {
    const base = recordEntry(emptyLedger(), "a/x.sldprt", "sha-abc");
    const ts = tombstoneEntry(base, "a/x.sldprt");
    const entry = ts.entries["a/x.sldprt"]!;
    expect(entry.sha256).toBe("sha-abc");
    expect(typeof entry.deletedAt).toBe("string");
    expect(entry.deletedAt!.length).toBeGreaterThan(0);
    // Should be a valid ISO timestamp
    expect(() => new Date(entry.deletedAt!)).not.toThrow();
  });

  it("tombstoneEntry on a path with no existing entry creates stub with empty sha", () => {
    const ts = tombstoneEntry(emptyLedger(), "new/file.sldprt");
    const entry = ts.entries["new/file.sldprt"]!;
    expect(entry.sha256).toBe("");
    expect(typeof entry.deletedAt).toBe("string");
  });

  it("tombstoneEntry normalizes the key (case-insensitive)", () => {
    const base = recordEntry(emptyLedger(), "Chassis/Frame.sldprt", "sha-xyz");
    const ts = tombstoneEntry(base, "CHASSIS/FRAME.SLDPRT");
    const entry = ts.entries["chassis/frame.sldprt"]!;
    expect(entry.sha256).toBe("sha-xyz");
    expect(entry.deletedAt).toBeTruthy();
  });

  it("classifyMissing returns 'never-downloaded' for a tombstoned (deletedAt) absent path", () => {
    const base = recordEntry(emptyLedger(), "a/x.sldprt", "s1");
    const ledger = tombstoneEntry(base, "a/x.sldprt");
    // tombstone present, file absent → treat as never-downloaded (intentional deletion)
    expect(classifyMissing(ledger, "a/x.sldprt", false)).toBe("never-downloaded");
  });

  it("classifyMissing still returns 'locally-deleted' for a normal (no-deletedAt) absent path", () => {
    const ledger = recordEntry(emptyLedger(), "a/x.sldprt", "s1");
    expect(classifyMissing(ledger, "a/x.sldprt", false)).toBe("locally-deleted");
  });

  it("parseLedger round-trips deletedAt", () => {
    const base = recordEntry(emptyLedger(), "a/x.sldprt", "sha-rt");
    const ts = tombstoneEntry(base, "a/x.sldprt");
    const json = JSON.stringify(ts);
    const parsed = parseLedger(json);
    const entry = parsed.entries["a/x.sldprt"]!;
    expect(entry.sha256).toBe("sha-rt");
    expect(entry.deletedAt).toBe(ts.entries["a/x.sldprt"]!.deletedAt);
  });

  it("parseLedger skips deletedAt if value is not a string", () => {
    const json = JSON.stringify({
      entries: {
        "a/x.sldprt": { sha256: "x", recordedAt: "t", deletedAt: 12345 },
      },
    });
    const parsed = parseLedger(json);
    expect(parsed.entries["a/x.sldprt"]!.deletedAt).toBeUndefined();
  });

  it("recordEntry produces an entry WITHOUT deletedAt (clears tombstone)", () => {
    const base = tombstoneEntry(emptyLedger(), "a/x.sldprt");
    const refreshed = recordEntry(base, "a/x.sldprt", "new-sha");
    expect(refreshed.entries["a/x.sldprt"]!.deletedAt).toBeUndefined();
    expect(refreshed.entries["a/x.sldprt"]!.sha256).toBe("new-sha");
  });
});

describe("sync-ledger IO (ENOENT regression)", () => {
  const mkdirMock = vi.mocked(mkdir);
  const writeMock = vi.mocked(writeTextFile);
  const readMock = vi.mocked(readTextFile);

  beforeEach(() => {
    mkdirMock.mockReset().mockResolvedValue(undefined);
    writeMock.mockReset().mockResolvedValue(undefined);
    readMock.mockReset();
    __resetLedgerCacheForTests();
  });

  it("saveLedger creates the dir (recursive) BEFORE writing — the os-error-2 fix", async () => {
    await saveLedger("v1", recordEntry(emptyLedger(), "a/x", "s"));
    expect(mkdirMock).toHaveBeenCalledWith("sync-ledgers", {
      baseDir: "AppLocalData",
      recursive: true,
    });
    expect(writeMock).toHaveBeenCalledWith(
      "sync-ledgers/sync-ledger-v1.json",
      expect.any(String),
      { baseDir: "AppLocalData" },
    );
    // mkdir must run before the write, or the write hits a missing directory.
    expect(mkdirMock.mock.invocationCallOrder[0]!).toBeLessThan(
      writeMock.mock.invocationCallOrder[0]!,
    );
  });

  it("saveLedger never throws on an IO failure (best-effort)", async () => {
    mkdirMock.mockRejectedValue(new Error("No such file or directory (os error 2)"));
    await expect(saveLedger("v1", emptyLedger())).resolves.toBeUndefined();
  });

  it("loadLedger falls back to the legacy root path when the subdir file is absent", async () => {
    readMock.mockImplementation((path: unknown) => {
      if (path === "sync-ledgers/sync-ledger-v1.json") return Promise.reject(new Error("missing"));
      if (path === "sync-ledger-v1.json")
        return Promise.resolve('{"entries":{"a":{"sha256":"x","recordedAt":"t"}}}');
      return Promise.reject(new Error("nope"));
    });
    const l = await loadLedger("v1");
    expect(l.entries.a?.sha256).toBe("x");
  });
});

describe("sync-ledger in-memory + coalesced writes", () => {
  const mkdirMock = vi.mocked(mkdir);
  const writeMock = vi.mocked(writeTextFile);
  const readMock = vi.mocked(readTextFile);

  beforeEach(() => {
    mkdirMock.mockReset().mockResolvedValue(undefined);
    writeMock.mockReset().mockResolvedValue(undefined);
    readMock.mockReset().mockRejectedValue(new Error("missing")); // first run
    __resetLedgerCacheForTests();
  });

  function lastWritten(): { entries: Record<string, { sha256: string; deletedAt?: string }> } {
    const calls = writeMock.mock.calls;
    return JSON.parse(calls[calls.length - 1]![1] as string);
  }

  it("a bulk run of records reads the disk once and coalesces into one write", async () => {
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => ledgerRecord("v1", `Dir/f${i}.sldprt`, `s${i}`)),
    );
    // Both candidate paths (subdir + legacy) were tried exactly once.
    expect(readMock).toHaveBeenCalledTimes(2);
    expect(writeMock).not.toHaveBeenCalled(); // still debounced
    await flushLedger("v1");
    expect(writeMock).toHaveBeenCalledTimes(1);
    const written = lastWritten();
    expect(Object.keys(written.entries)).toHaveLength(200);
    expect(written.entries["dir/f199.sldprt"]!.sha256).toBe("s199");
    // Nothing dirty → a second flush is a no-op.
    await flushLedger("v1");
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it("applies mutations in call order (record → tombstone → record → remove)", async () => {
    void ledgerRecord("v1", "a.sldprt", "s1");
    void ledgerTombstone("v1", "a.sldprt");
    void ledgerRecord("v1", "b.sldprt", "s2");
    void ledgerRecord("v1", "c.sldprt", "s3");
    void ledgerRemove("v1", "c.sldprt");
    await flushLedger("v1");
    const e = lastWritten().entries;
    expect(e["a.sldprt"]!.sha256).toBe("s1");
    expect(typeof e["a.sldprt"]!.deletedAt).toBe("string");
    expect(e["b.sldprt"]!.sha256).toBe("s2");
    expect(e["c.sldprt"]).toBeUndefined();
  });

  it("loadLedger sees unflushed records and returns a snapshot copy", async () => {
    await ledgerRecord("v1", "Part.SLDPRT", "abc");
    const snap = await loadLedger("v1");
    expect(snap.entries["part.sldprt"]!.sha256).toBe("abc");
    await ledgerRecord("v1", "later.sldprt", "def");
    expect(snap.entries["later.sldprt"]).toBeUndefined(); // caller's copy is stable
    expect((await loadLedger("v1")).entries["later.sldprt"]!.sha256).toBe("def");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("the debounce timer flushes on its own", async () => {
    vi.useFakeTimers();
    try {
      await ledgerRecord("v1", "x.sldprt", "s");
      expect(writeMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS + 10);
      expect(writeMock).toHaveBeenCalledTimes(1);
      expect(lastWritten().entries["x.sldprt"]!.sha256).toBe("s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("vaults are independent", async () => {
    await ledgerRecord("v1", "a", "1");
    await ledgerRecord("v2", "b", "2");
    await flushLedger("v2");
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0]![0]).toBe("sync-ledgers/sync-ledger-v2.json");
    expect(lastWritten().entries.a).toBeUndefined();
  });

  it("prunes expired tombstones on load (and persists the prune)", async () => {
    const old = new Date(Date.now() - TOMBSTONE_COOLOFF_MS - 60_000).toISOString();
    const fresh = new Date().toISOString();
    readMock.mockReset().mockResolvedValue(
      JSON.stringify({
        entries: {
          "old.sldprt": { sha256: "o", recordedAt: old, deletedAt: old },
          "fresh.sldprt": { sha256: "f", recordedAt: fresh, deletedAt: fresh },
          "corrupt.sldprt": { sha256: "c", recordedAt: fresh, deletedAt: "not-a-date" },
          "live.sldprt": { sha256: "l", recordedAt: old },
        },
      }),
    );
    const l = await loadLedger("v1");
    expect(Object.keys(l.entries).sort()).toEqual(["corrupt.sldprt", "fresh.sldprt", "live.sldprt"]);
    await flushLedger("v1");
    expect(Object.keys(lastWritten().entries).sort()).toEqual([
      "corrupt.sldprt",
      "fresh.sldprt",
      "live.sldprt",
    ]);
  });
});

describe("pruneExpiredTombstones", () => {
  it("only drops parseable tombstones past the cool-off", () => {
    const now = Date.parse("2026-09-28T00:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const ledger = {
      entries: {
        expired: { sha256: "", recordedAt: iso(0), deletedAt: iso(now - TOMBSTONE_COOLOFF_MS) },
        within: { sha256: "", recordedAt: iso(0), deletedAt: iso(now - TOMBSTONE_COOLOFF_MS + 1) },
        nan: { sha256: "", recordedAt: iso(0), deletedAt: "garbage" },
        live: { sha256: "s", recordedAt: iso(0) },
      },
    };
    expect(pruneExpiredTombstones(ledger, now)).toBe(1);
    expect(Object.keys(ledger.entries).sort()).toEqual(["live", "nan", "within"]);
  });
});
