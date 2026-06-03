import { describe, expect, test } from "vitest";
import { computeVaultInsights, fillMonths } from "../vaultStats";
import type { Folder, Lock, VaultFile, VaultUser } from "../../data/types";

function file(
  name: string,
  opts: {
    folder_id?: string | null;
    size?: number;
    versions?: number;
    revision?: number | null;
    author?: string | null;
    created_at?: string;
  } = {},
): VaultFile {
  const {
    folder_id = null, size = 0, versions = 1, revision = null,
    author = null, created_at = "2026-01-15T00:00:00Z",
  } = opts;
  return {
    id: `file-${name}`,
    vault_id: "v1",
    folder_id,
    name,
    latest_version_id: `ver-${name}`,
    created_at,
    latest: {
      id: `ver-${name}`,
      file_id: `file-${name}`,
      version_num: versions,
      sha256: "x",
      size_bytes: size,
      author_id: author,
      comment: null,
      parent_version_id: null,
      revision,
      created_at,
    },
  };
}

const folders: Folder[] = [
  { id: "chassis", vault_id: "v1", parent_id: null, name: "Chassis", created_at: "" },
  { id: "frame", vault_id: "v1", parent_id: "chassis", name: "Frame", created_at: "" },
  { id: "engine", vault_id: "v1", parent_id: null, name: "Engine", created_at: "" },
];

const users: VaultUser[] = [
  { user_id: "u1", email: "a@x.com", display_name: "Alice", subteam: null, role: "editor", granted_at: null, created_at: "" },
];

describe("computeVaultInsights", () => {
  const files: VaultFile[] = [
    file("A.SLDASM", { folder_id: "frame", size: 1000, versions: 3, revision: 2, author: "u1" }),
    file("B.SLDPRT", { folder_id: "frame", size: 2000, versions: 1, author: "u1" }),
    file("C.SLDPRT", { folder_id: "engine", size: 500, versions: 6, author: "u2" }),
    file("notes.txt", { folder_id: null, size: 100, versions: 2, author: null }),
  ];
  const locks: Lock[] = [
    { id: "l1", file_id: "file-A.SLDASM", user_id: "u1", acquired_at: "", released_at: null, force_released_by: null },
  ];
  const s = computeVaultInsights(files, folders, locks, users);

  test("rolls up headline totals", () => {
    expect(s.totalFiles).toBe(4);
    expect(s.totalBytes).toBe(3600);
    expect(s.totalVersions).toBe(12); // 3 + 1 + 6 + 2
    expect(s.folderCount).toBe(3);
    expect(s.activeCheckouts).toBe(1);
    expect(s.revisionedFiles).toBe(1); // only A has a stamped revision
    expect(s.avgBytes).toBe(900);
  });

  test("buckets files by extension with byte totals", () => {
    const sldprt = s.byType.find((t) => t.label === "sldprt");
    expect(sldprt?.value).toBe(2); // B + C
    expect(sldprt?.extra).toBe(2500); // 2000 + 500
    expect(s.byType.find((t) => t.label === "sldasm")?.value).toBe(1);
    expect(s.byType.find((t) => t.label === "txt")?.value).toBe(1);
  });

  test("attributes storage to the TOP-LEVEL folder (walks nesting)", () => {
    // Frame is nested under Chassis -> A + B (3000 bytes) roll up to "Chassis".
    expect(s.storageByArea.find((b) => b.label === "Chassis")?.value).toBe(3000);
    expect(s.storageByArea.find((b) => b.label === "Engine")?.value).toBe(500);
    expect(s.storageByArea.find((b) => b.label === "(root)")?.value).toBe(100);
  });

  test("distributes revisions into 1/2/3/4/5+ buckets", () => {
    const get = (l: string) => s.revisionDist.find((c) => c.label === l)?.value;
    expect(get("1")).toBe(1); // B
    expect(get("2")).toBe(1); // notes
    expect(get("3")).toBe(1); // A
    expect(get("4")).toBe(0);
    expect(get("5+")).toBe(1); // C (6 versions)
  });

  test("resolves contributor labels, Unknown for a null author", () => {
    expect(s.topContributors.find((b) => b.label === "Alice")?.value).toBe(2);
    expect(s.topContributors.find((b) => b.label === "Unknown")?.value).toBe(1);
    // u2 has no VaultUser row -> short-id label
    expect(s.topContributors.some((b) => b.label.startsWith("u2"))).toBe(true);
  });

  test("ranks largest files and drops zero-byte files", () => {
    expect(s.largestFiles.map((b) => b.label)).toEqual([
      "B.SLDPRT", "A.SLDASM", "C.SLDPRT", "notes.txt",
    ]);
  });

  test("counts files per size band", () => {
    expect(s.sizeDistribution.find((c) => c.label === "<256K")?.value).toBe(4);
    expect(s.sizeDistribution.find((c) => c.label === "50M+")?.value).toBe(0);
  });

  test("accumulates cumulative growth and ranks churn leaders", () => {
    expect(s.growthFiles).toEqual([{ label: "2026-01", value: 4 }]);
    expect(s.mostRevised.map((b) => b.label)).toEqual(["C.SLDPRT", "A.SLDASM", "notes.txt"]);
    expect(s.mostRevised[0]!.value).toBe(6); // C has the most versions
  });

  test("empty vault yields zeroed, empty datasets", () => {
    const e = computeVaultInsights([], [], [], []);
    expect(e.totalFiles).toBe(0);
    expect(e.avgBytes).toBe(0);
    expect(e.byType).toEqual([]);
    expect(e.addedByMonth).toEqual([]);
    expect(e.growthFiles).toEqual([]);
    expect(e.staleCount).toBe(0);
  });

  test("recency ordering and stale cutoff honor timestamps + nowMs", () => {
    const old = file("old.SLDPRT", { size: 10, created_at: "2025-01-01T00:00:00Z" });
    const fresh = file("new.SLDPRT", { size: 10, created_at: "2026-06-01T00:00:00Z" });
    const now = new Date("2026-06-02T00:00:00Z").getTime();
    const r = computeVaultInsights([old, fresh], [], [], [], now);
    expect(r.recentlyUpdated.map((x) => x.name)).toEqual(["new.SLDPRT", "old.SLDPRT"]);
    expect(r.staleCount).toBe(1); // old.SLDPRT is >180d before 2026-06-02
  });
});

describe("fillMonths", () => {
  test("gap-fills zero months between first and last", () => {
    const out = fillMonths(new Map([["2026-01", 2], ["2026-04", 5]]));
    expect(out).toEqual([
      { label: "2026-01", value: 2 },
      { label: "2026-02", value: 0 },
      { label: "2026-03", value: 0 },
      { label: "2026-04", value: 5 },
    ]);
  });

  test("rolls the year boundary", () => {
    const out = fillMonths(new Map([["2025-11", 1], ["2026-02", 1]]));
    expect(out.map((c) => c.label)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});
