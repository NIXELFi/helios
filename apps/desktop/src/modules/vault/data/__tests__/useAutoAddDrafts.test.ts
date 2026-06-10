// Auto-vault candidate selection: the guards that keep SW-PDM-style auto-add
// from vaulting half-written saves, resurrecting deletions, or hot-looping.

import { describe, it, expect } from "vitest";

import { selectAutoAddCandidates, STABLE_AGE_MS } from "../useAutoAddDrafts";
import { emptyLedger, recordEntry } from "../sync-ledger";
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
});
