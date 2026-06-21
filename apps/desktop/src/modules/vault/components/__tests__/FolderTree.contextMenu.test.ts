import { describe, expect, it } from "vitest";
import {
  contextMenuTargetIsSelection,
  emptyTreeSelection,
  type TreeSelection,
} from "../FolderTree";

// ---------------------------------------------------------------------------
// contextMenuTargetIsSelection
// ---------------------------------------------------------------------------
// Returns true ONLY when the right-clicked folder is explicitly in the
// current selection's `folders` set.  An unrelated multi-selection (files or
// other folders) must NOT cause a folder that was NOT clicked-through-selection
// to return true — that would hijack the folder-specific context menu.
// ---------------------------------------------------------------------------

describe("contextMenuTargetIsSelection", () => {
  it("returns false when the clicked folder is NOT in selection, even though other files/folders are selected", () => {
    const sel: TreeSelection = {
      files: new Set(["file-1", "file-2"]),
      folders: new Set(["folder-other"]),
    };
    // Right-clicking "folder-target" which is not in sel.folders
    expect(contextMenuTargetIsSelection(sel, "folder-target")).toBe(false);
  });

  it("returns true when the clicked folder IS in the selection", () => {
    const sel: TreeSelection = {
      files: new Set(["file-1"]),
      folders: new Set(["folder-target", "folder-other"]),
    };
    expect(contextMenuTargetIsSelection(sel, "folder-target")).toBe(true);
  });

  it("returns false when selection is null", () => {
    expect(contextMenuTargetIsSelection(null, "folder-target")).toBe(false);
  });

  it("returns false when selection is undefined", () => {
    expect(contextMenuTargetIsSelection(undefined, "folder-target")).toBe(false);
  });

  it("returns false when selection is empty (no files, no folders)", () => {
    const sel = emptyTreeSelection();
    expect(contextMenuTargetIsSelection(sel, "folder-target")).toBe(false);
  });

  it("returns false when only unrelated folders are selected", () => {
    const sel: TreeSelection = {
      files: new Set(),
      folders: new Set(["folder-a", "folder-b"]),
    };
    expect(contextMenuTargetIsSelection(sel, "folder-c")).toBe(false);
  });

  it("returns true when only the clicked folder is selected (no files)", () => {
    const sel: TreeSelection = {
      files: new Set(),
      folders: new Set(["folder-target"]),
    };
    expect(contextMenuTargetIsSelection(sel, "folder-target")).toBe(true);
  });
});
