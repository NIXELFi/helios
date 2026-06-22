/**
 * Tests for folder-tree navigation helpers added for M12 / M14 / M16:
 *
 * M16 — nearestLiveAncestor / isDescendantOf
 *   When a folder is deleted, BrowseScreen must reset selectedFolder to the
 *   nearest still-live ancestor rather than leaving it pointing at a ghost id.
 *
 * M12 — resolveBreadcrumbPath
 *   Breadcrumbs must stop at the last resolvable ancestor rather than walking
 *   through missing / deleted folder entries and rendering ghost links.
 *
 * M14 — selectionAfterPartialDelete
 *   Context-menu multi-file delete must clear only the successfully-deleted
 *   ids from the selection, keeping the failed ids checked so the user can
 *   retry (mirrors the BulkActionBar.bulkDelete behaviour).
 */
import { describe, it, expect } from "vitest";
import {
  folderPath,
  folderNamePath,
  isDescendantOf,
  nearestLiveAncestor,
  resolveBreadcrumbPath,
  selectionAfterPartialDelete,
} from "../folder-paths";
import type { Folder } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function folder(id: string, parent_id: string | null = null): Folder {
  return {
    id,
    vault_id: "v1",
    parent_id,
    name: id,
    created_at: "2026-01-01T00:00:00Z",
  };
}

/**
 * A tree:  root → chassis → frame → subframe
 *          root → aero
 */
const TREE: Folder[] = [
  folder("root"),
  folder("chassis", "root"),
  folder("frame", "chassis"),
  folder("subframe", "frame"),
  folder("aero", "root"),
];

// ── folderPath / folderNamePath (H-2: cycle guard) ────────────────────────────

describe("folderPath", () => {
  it("joins the sanitized folder chain root → leaf", () => {
    expect(folderPath("subframe", TREE)).toBe("root/chassis/frame/subframe");
  });

  it('returns "" for the vault root (null) and for an unknown id', () => {
    expect(folderPath(null, TREE)).toBe("");
    expect(folderPath("ghost", TREE)).toBe("");
  });

  it("does not stack-overflow on a self-parenting folder (cycle guard)", () => {
    // A corrupt row whose parent_id is itself would infinitely recurse without
    // the guard — folderPath is on the hot sync-match path, so this would make
    // the whole Vault UI unopenable.
    const cyclic: Folder[] = [folder("loop", "loop")];
    expect(() => folderPath("loop", cyclic)).not.toThrow();
    expect(folderPath("loop", cyclic)).toBe("loop");
  });

  it("does not stack-overflow on a multi-node parent_id cycle", () => {
    // a → b → a (mutual parents). The walk must terminate.
    const cyclic: Folder[] = [folder("a", "b"), folder("b", "a")];
    expect(() => folderPath("a", cyclic)).not.toThrow();
    // Whatever it returns, it must be a finite, bounded string.
    expect(folderPath("a", cyclic).split("/").length).toBeLessThanOrEqual(64);
  });
});

describe("folderNamePath", () => {
  it("joins the RAW folder names root → leaf", () => {
    expect(folderNamePath("frame", TREE)).toBe("root/chassis/frame");
  });

  it("does not stack-overflow on a parent_id cycle (guard)", () => {
    const cyclic: Folder[] = [folder("a", "b"), folder("b", "a")];
    expect(() => folderNamePath("a", cyclic)).not.toThrow();
    expect(folderNamePath("a", cyclic).split("/").length).toBeLessThanOrEqual(64);
  });
});

// ── isDescendantOf ────────────────────────────────────────────────────────────

describe("isDescendantOf", () => {
  it("returns true for an immediate child", () => {
    expect(isDescendantOf(TREE, "chassis", "root")).toBe(true);
  });

  it("returns true for a deeply nested descendant", () => {
    expect(isDescendantOf(TREE, "subframe", "root")).toBe(true);
    expect(isDescendantOf(TREE, "subframe", "chassis")).toBe(true);
    expect(isDescendantOf(TREE, "subframe", "frame")).toBe(true);
  });

  it("returns false for the folder itself", () => {
    expect(isDescendantOf(TREE, "chassis", "chassis")).toBe(false);
  });

  it("returns false for an ancestor", () => {
    expect(isDescendantOf(TREE, "root", "chassis")).toBe(false);
  });

  it("returns false for an unrelated sibling branch", () => {
    expect(isDescendantOf(TREE, "aero", "chassis")).toBe(false);
    expect(isDescendantOf(TREE, "frame", "aero")).toBe(false);
  });

  it("returns false when the folder does not exist", () => {
    expect(isDescendantOf(TREE, "nonexistent", "root")).toBe(false);
  });
});

// ── nearestLiveAncestor ───────────────────────────────────────────────────────

describe("nearestLiveAncestor", () => {
  // nearestLiveAncestor(allFolders, liveIds, folderId)
  // allFolders: the full pre-deletion folder list (so parent_id chains are intact)
  // liveIds:    Set of ids that are still live after the deletion
  // folderId:   the folder whose nearest live ancestor we want

  it("returns the parent id when the current folder's parent is live", () => {
    // chassis exists, parent is root which is also live → returns root
    const liveIds = new Set(TREE.map((f) => f.id));
    expect(nearestLiveAncestor(TREE, liveIds, "chassis")).toBe("root");
  });

  it("returns null when the current folder is a root-level folder (no parent)", () => {
    // root itself has no parent_id → should return null
    const liveIds = new Set(TREE.map((f) => f.id));
    expect(nearestLiveAncestor(TREE, liveIds, "root")).toBeNull();
  });

  it("returns the parent when the current folder has been deleted from the live set", () => {
    // selectedFolder is "frame" (just deleted). "chassis" is still live.
    const liveIds = new Set(TREE.map((f) => f.id).filter((id) => id !== "frame"));
    expect(nearestLiveAncestor(TREE, liveIds, "frame")).toBe("chassis");
  });

  it("skips the deleted parent and returns the grandparent", () => {
    // "frame" and "chassis" both deleted. "root" is still live.
    const liveIds = new Set(
      TREE.map((f) => f.id).filter((id) => id !== "frame" && id !== "chassis"),
    );
    expect(nearestLiveAncestor(TREE, liveIds, "subframe")).toBe("root");
  });

  it("returns null when all ancestors are deleted", () => {
    // root, chassis, frame deleted — "subframe" has no live ancestors.
    const liveIds = new Set(
      TREE.map((f) => f.id).filter(
        (id) => id !== "root" && id !== "chassis" && id !== "frame",
      ),
    );
    expect(nearestLiveAncestor(TREE, liveIds, "subframe")).toBeNull();
  });

  it("returns null for a folder id not present in allFolders at all", () => {
    // A completely unknown id has no known parent_id chain.
    const liveIds = new Set(TREE.map((f) => f.id));
    expect(nearestLiveAncestor(TREE, liveIds, "ghost")).toBeNull();
  });
});

// ── resolveBreadcrumbPath ─────────────────────────────────────────────────────

describe("resolveBreadcrumbPath", () => {
  it("returns the full ancestor chain from root to the current folder", () => {
    const path = resolveBreadcrumbPath(TREE, "subframe");
    expect(path.map((f) => f.id)).toEqual(["root", "chassis", "frame", "subframe"]);
  });

  it("returns a single-element array for a root-level folder", () => {
    const path = resolveBreadcrumbPath(TREE, "aero");
    expect(path.map((f) => f.id)).toEqual(["root", "aero"]);
  });

  it("returns an empty array when the selected folder id is unknown", () => {
    const path = resolveBreadcrumbPath(TREE, "ghost");
    expect(path).toHaveLength(0);
  });

  it("stops at the last resolvable ancestor when an intermediate folder is missing", () => {
    // Remove "chassis" so the chain root → ??? → frame → subframe breaks.
    // Walking up from "subframe": subframe ok, frame ok, chassis MISSING → stop.
    // Result should only contain the resolvable tail: [frame, subframe].
    const live = TREE.filter((f) => f.id !== "chassis");
    const path = resolveBreadcrumbPath(live, "subframe");
    // frame's parent_id is "chassis" which doesn't exist → chain breaks at frame
    expect(path.map((f) => f.id)).toEqual(["frame", "subframe"]);
  });

  it("returns just the current folder when its parent is missing", () => {
    // Remove "root" so chassis has no parent in the live list.
    const live = TREE.filter((f) => f.id !== "root");
    const path = resolveBreadcrumbPath(live, "chassis");
    expect(path.map((f) => f.id)).toEqual(["chassis"]);
  });
});

// ── selectionAfterPartialDelete ───────────────────────────────────────────────

describe("selectionAfterPartialDelete", () => {
  it("returns an empty set when all selected ids were successfully deleted", () => {
    const selected = new Set(["f1", "f2", "f3"]);
    const succeeded = ["f1", "f2", "f3"];
    expect(selectionAfterPartialDelete(selected, succeeded).size).toBe(0);
  });

  it("removes only the succeeded ids, keeping failed ids selected", () => {
    const selected = new Set(["f1", "f2", "f3"]);
    const succeeded = ["f1", "f3"]; // f2 failed
    const result = selectionAfterPartialDelete(selected, succeeded);
    expect(result.has("f2")).toBe(true);
    expect(result.has("f1")).toBe(false);
    expect(result.has("f3")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("leaves all ids selected when nothing succeeded", () => {
    const selected = new Set(["f1", "f2"]);
    const result = selectionAfterPartialDelete(selected, []);
    expect(result).toEqual(new Set(["f1", "f2"]));
  });

  it("does not add ids that were not in the original selection", () => {
    const selected = new Set(["f1"]);
    const succeeded = ["f1", "f99"]; // f99 was never selected
    const result = selectionAfterPartialDelete(selected, succeeded);
    expect(result.size).toBe(0);
    expect(result.has("f99")).toBe(false);
  });

  it("returns a new Set (does not mutate the input)", () => {
    const selected = new Set(["f1", "f2"]);
    const result = selectionAfterPartialDelete(selected, ["f1"]);
    expect(selected.has("f1")).toBe(true); // original untouched
    expect(result.has("f1")).toBe(false);
  });
});
