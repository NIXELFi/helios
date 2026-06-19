import { describe, expect, it } from "vitest";
import { classifyMissing, emptyLedger, recordEntry, removeEntry, parseLedger, tombstoneEntry } from "../sync-ledger";

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
