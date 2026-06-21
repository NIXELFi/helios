// Auto-vault candidate selection: the guards that keep SW-PDM-style auto-add
// from vaulting half-written saves, resurrecting deletions, or hot-looping.

import { describe, it, expect } from "vitest";

import { selectAutoAddCandidates, STABLE_AGE_MS } from "../useAutoAddDrafts";
import { emptyLedger, recordEntry, tombstoneEntry, TOMBSTONE_COOLOFF_MS } from "../sync-ledger";
import type { LocalFile } from "../useLocalFolderScan";

const NOW = 1_700_000_000_000;
const lf = (rel: string, sha = "abc"): LocalFile => ({
  basename: rel.split("/").pop()!,
  relativePath: rel,
  absolutePath: `/v/${rel}`,
  sha256: sha,
  sizeBytes: 10,
});
const old = NOW - STABLE_AGE_MS - 1;

describe("selectAutoAddCandidates", () => {
  it("accepts a stable, hashed, never-ledgered file", () => {
    const out = selectAutoAddCandidates(
      [lf("a.sldprt")], emptyLedger(), new Map([["a.sldprt", old]]), new Map(), NOW,
    );
    expect(out.map((f) => f.relativePath)).toEqual(["a.sldprt"]);
  });

  it("rejects fresh saves, unhashed files, and unknown mtimes", () => {
    const mtimes = new Map<string, number | null>([
      ["fresh.sldprt", NOW - 100],
      ["nosha.sldprt", old],
      ["unknown.sldprt", null],
    ]);
    const out = selectAutoAddCandidates(
      [lf("fresh.sldprt"), lf("nosha.sldprt", ""), lf("unknown.sldprt")],
      emptyLedger(), mtimes, new Map(), NOW,
    );
    expect(out).toEqual([]);
  });

  it("rejects ledgered paths (deleted-file zombies / discarded drafts)", () => {
    const ledger = recordEntry(emptyLedger(), "Chassis/frame.sldprt", "abc");
    const out = selectAutoAddCandidates(
      [lf("Chassis/frame.sldprt")], ledger,
      new Map([["Chassis/frame.sldprt", old]]), new Map(), NOW,
    );
    expect(out).toEqual([]);
  });

  it("backs off paths that failed recently", () => {
    const attempts = new Map([["a.sldprt", NOW - 60_000]]); // failed 1 min ago
    const out = selectAutoAddCandidates(
      [lf("a.sldprt")], emptyLedger(), new Map([["a.sldprt", old]]), attempts, NOW,
    );
    expect(out).toEqual([]);
    // ...but retries after the backoff window.
    const later = selectAutoAddCandidates(
      [lf("a.sldprt")], emptyLedger(),
      new Map([["a.sldprt", old]]), attempts, NOW + 6 * 60_000,
    );
    expect(later).toHaveLength(1);
  });

  // ── tombstone cool-off tests ─────────────────────────────────────────────────

  it("skips a path with a NORMAL (no-deletedAt) ledger entry (existing behavior preserved)", () => {
    const ledger = recordEntry(emptyLedger(), "b.sldprt", "sha1");
    const out = selectAutoAddCandidates(
      [lf("b.sldprt")], ledger, new Map([["b.sldprt", old]]), new Map(), NOW,
    );
    expect(out).toEqual([]);
  });

  it("skips a path with a TOMBSTONE within cool-off window", () => {
    // tombstone set 1 hour ago — well within 7-day cool-off
    const tombstoneTime = NOW - 60 * 60 * 1000;
    const base = recordEntry(emptyLedger(), "c.sldprt", "sha2");
    // Manually build a tombstone with a specific deletedAt timestamp
    const ledger: ReturnType<typeof emptyLedger> = {
      entries: {
        "c.sldprt": {
          sha256: "sha2",
          recordedAt: new Date(tombstoneTime - 1000).toISOString(),
          deletedAt: new Date(tombstoneTime).toISOString(),
        },
      },
    };
    const out = selectAutoAddCandidates(
      [lf("c.sldprt")], ledger, new Map([["c.sldprt", old]]), new Map(), NOW,
    );
    expect(out).toEqual([]);
  });

  it("allows a path with a TOMBSTONE older than TOMBSTONE_COOLOFF_MS", () => {
    // tombstone set 8 days ago — past the 7-day cool-off
    const tombstoneTime = NOW - (TOMBSTONE_COOLOFF_MS + 24 * 60 * 60 * 1000);
    const ledger: ReturnType<typeof emptyLedger> = {
      entries: {
        "d.sldprt": {
          sha256: "sha3",
          recordedAt: new Date(tombstoneTime - 1000).toISOString(),
          deletedAt: new Date(tombstoneTime).toISOString(),
        },
      },
    };
    const out = selectAutoAddCandidates(
      [lf("d.sldprt")], ledger, new Map([["d.sldprt", old]]), new Map(), NOW,
    );
    expect(out.map((f) => f.relativePath)).toEqual(["d.sldprt"]);
  });

  it("treats a garbage/unparseable deletedAt as still-suppressing (NaN guard)", () => {
    // A corrupt tombstone (e.g. deletedAt = "not-a-date" or "") must suppress
    // auto-add — a NaN result from getTime() used to evaluate to false for the
    // cool-off comparison (NaN < anything = false), letting the file through
    // and silently re-vaulting a deletion.
    const ledger: ReturnType<typeof emptyLedger> = {
      entries: {
        "corrupt.sldprt": {
          sha256: "sha-corrupt",
          recordedAt: new Date(NOW - 1000).toISOString(),
          deletedAt: "not-a-date", // unparseable → NaN guard must suppress
        },
      },
    };
    const out = selectAutoAddCandidates(
      [lf("corrupt.sldprt")], ledger,
      new Map([["corrupt.sldprt", old]]), new Map(), NOW,
    );
    expect(out).toEqual([]);
  });

  it("tombstoneEntry within cool-off is suppressed; past cool-off is a candidate", () => {
    // Use tombstoneEntry helper to build the ledger, supply explicit `now` to
    // selectAutoAddCandidates so the cool-off math is deterministic.
    const base = recordEntry(emptyLedger(), "e.sldprt", "sha4");
    const ledgerTs = tombstoneEntry(base, "e.sldprt");
    // `now` inside tombstoneEntry used real Date — read back the deletedAt
    const deletedAtMs = new Date(ledgerTs.entries["e.sldprt"]!.deletedAt!).getTime();
    const withinCooloff = deletedAtMs + 1000; // 1 s after tombstone → within window
    const pastCooloff = deletedAtMs + TOMBSTONE_COOLOFF_MS + 1000; // past window

    const suppressed = selectAutoAddCandidates(
      [lf("e.sldprt")], ledgerTs,
      new Map([["e.sldprt", withinCooloff - STABLE_AGE_MS - 1]]), // mtime = old enough
      new Map(), withinCooloff,
    );
    expect(suppressed).toEqual([]);

    const allowed = selectAutoAddCandidates(
      [lf("e.sldprt")], ledgerTs,
      new Map([["e.sldprt", pastCooloff - STABLE_AGE_MS - 1]]),
      new Map(), pastCooloff,
    );
    expect(allowed).toHaveLength(1);
  });
});
