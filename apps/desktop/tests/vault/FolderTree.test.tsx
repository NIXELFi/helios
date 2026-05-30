import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FolderTree } from "../../src/modules/vault/components/FolderTree";
import type { Folder, VaultFile } from "../../src/modules/vault/data/types";

const folders: Folder[] = [
  { id: "f1", vault_id: "v", parent_id: null, name: "chassis", created_at: "2026-01-01" },
  { id: "f2", vault_id: "v", parent_id: "f1", name: "frame", created_at: "2026-01-01" },
  { id: "f3", vault_id: "v", parent_id: null, name: "powertrain", created_at: "2026-01-01" },
];

describe("<FolderTree>", () => {
  it("renders top-level folders", () => {
    render(<FolderTree folders={folders} selected={null} onSelect={() => {}} />);
    // Exact name: the folder ROW is named just "chassis"; the chevron button
    // is named "Expand chassis", so a /chassis/i substring would match both.
    expect(screen.getByRole("button", { name: "chassis" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "powertrain" })).toBeInTheDocument();
  });

  it("does not render nested folders until parent is expanded", () => {
    render(<FolderTree folders={folders} selected={null} onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /frame/i })).not.toBeInTheDocument();
  });

  it("expands children when parent is expanded", () => {
    render(<FolderTree folders={folders} selected={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByLabelText(/expand chassis/i));
    expect(screen.getByRole("button", { name: /frame/i })).toBeInTheDocument();
  });

  it("calls onSelect with the folder id when a row is clicked", () => {
    const onSelect = vi.fn();
    render(<FolderTree folders={folders} selected={null} onSelect={onSelect} />);
    // Exact name targets the row, not the "Expand chassis" chevron button.
    fireEvent.click(screen.getByRole("button", { name: "chassis" }));
    expect(onSelect).toHaveBeenCalledWith("f1");
  });

  it("renders a 'Vault root' entry that calls onSelect(null)", () => {
    const onSelect = vi.fn();
    render(<FolderTree folders={folders} selected="f1" onSelect={onSelect} />);
    const all = screen.getByRole("button", { name: /vault root/i });
    expect(all).toBeInTheDocument();
    fireEvent.click(all);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("auto-expands the ancestor chain when a deep folder is selected", () => {
    // 'frame' has parent 'chassis'; passing selected='f2' should reveal 'frame'
    // without requiring a manual click on the chassis chevron.
    render(<FolderTree folders={folders} selected="f2" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /frame/i })).toBeInTheDocument();
  });

  it("marks the selected row with aria-current='page'", () => {
    render(<FolderTree folders={folders} selected="f3" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /powertrain/i })).toHaveAttribute("aria-current", "page");
  });

  // X6: the expand/collapse chevron must be a real, keyboard-focusable button
  // — not a <span role="none"> that drops it from the a11y tree.
  describe("expand/collapse chevron (X6)", () => {
    it("is a real <button type='button'> exposed in the a11y tree", () => {
      render(<FolderTree folders={folders} selected={null} onSelect={() => {}} />);
      const chevron = screen.getByRole("button", { name: /expand chassis/i });
      expect(chevron.tagName).toBe("BUTTON");
      expect(chevron).toHaveAttribute("type", "button");
    });

    it("toggles expansion on Enter without selecting the folder", () => {
      const onSelect = vi.fn();
      render(<FolderTree folders={folders} selected={null} onSelect={onSelect} />);
      const chevron = screen.getByRole("button", { name: /expand chassis/i });
      fireEvent.keyDown(chevron, { key: "Enter" });
      expect(screen.getByRole("button", { name: /frame/i })).toBeInTheDocument();
      // Activating the chevron must not navigate-select the folder.
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("toggles expansion on Space", () => {
      render(<FolderTree folders={folders} selected={null} onSelect={() => {}} />);
      const chevron = screen.getByRole("button", { name: /expand chassis/i });
      fireEvent.keyDown(chevron, { key: " " });
      expect(screen.getByRole("button", { name: /frame/i })).toBeInTheDocument();
      // Collapse again
      fireEvent.keyDown(screen.getByRole("button", { name: /collapse chassis/i }), { key: " " });
      expect(screen.queryByRole("button", { name: /frame/i })).not.toBeInTheDocument();
    });
  });

  // V11: reset the shift-select anchor when the folder set changes (vault
  // switch). The two vaults below reuse the SAME file ids in a DIFFERENT
  // order, so a surviving anchor would still be "found" by id in the new
  // vault's row order and drive a wrong shift-range. After the reset the
  // anchor is cleared, so the shift-click collapses to just the clicked row.
  it("resets the shift-select anchor when the folders prop changes (V11)", () => {
    const onTreeSelectionChange = vi.fn();
    // Vault A order: x1 (top), x2 (bottom). Anchor will be set on x1.
    const filesA: VaultFile[] = [
      { id: "x1", vault_id: "v", folder_id: null, name: "a-aaa.sldprt", latest_version_id: null, created_at: "x" },
      { id: "x2", vault_id: "v", folder_id: null, name: "a-zzz.sldprt", latest_version_id: null, created_at: "x" },
    ];
    // Vault B reuses ids x1/x2 but flips their order (x2 top, x1 bottom).
    const filesB: VaultFile[] = [
      { id: "x2", vault_id: "w", folder_id: null, name: "b-aaa.sldprt", latest_version_id: null, created_at: "x" },
      { id: "x1", vault_id: "w", folder_id: null, name: "b-zzz.sldprt", latest_version_id: null, created_at: "x" },
    ];
    const foldersA: Folder[] = [{ id: "fa", vault_id: "v", parent_id: null, name: "alpha", created_at: "x" }];
    const foldersB: Folder[] = [{ id: "fb", vault_id: "w", parent_id: null, name: "beta", created_at: "x" }];

    const { rerender } = render(
      <FolderTree
        folders={foldersA}
        files={filesA}
        selected={null}
        onSelect={() => {}}
        treeSelection={{ files: new Set(), folders: new Set() }}
        onTreeSelectionChange={onTreeSelectionChange}
      />,
    );
    // Plain-click a-aaa (x1) to set the anchor in vault A.
    fireEvent.click(screen.getByText("a-aaa.sldprt"));

    // Switch vaults: new folders + files (ids reused, order flipped).
    rerender(
      <FolderTree
        folders={foldersB}
        files={filesB}
        selected={null}
        onSelect={() => {}}
        treeSelection={{ files: new Set(), folders: new Set() }}
        onTreeSelectionChange={onTreeSelectionChange}
      />,
    );
    onTreeSelectionChange.mockClear();

    // Shift-click b-aaa (x2, now the TOP row). If the stale x1 anchor survived
    // it would be found at the BOTTOM in vault B and select the full x2..x1
    // range. With the anchor reset, only x2 is selected.
    fireEvent.click(screen.getByText("b-aaa.sldprt"), { shiftKey: true });
    expect(onTreeSelectionChange).toHaveBeenCalled();
    const next = onTreeSelectionChange.mock.calls.at(-1)![0];
    expect(next.files.has("x1")).toBe(false);
    expect(next.files.has("x2")).toBe(true);
  });
});
