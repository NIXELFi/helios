import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FolderTree } from "../../src/modules/vault/components/FolderTree";
import type { Folder } from "../../src/modules/vault/data/types";

const folders: Folder[] = [
  { id: "f1", vault_id: "v", parent_id: null, name: "chassis", created_at: "2026-01-01" },
  { id: "f2", vault_id: "v", parent_id: "f1", name: "frame", created_at: "2026-01-01" },
  { id: "f3", vault_id: "v", parent_id: null, name: "powertrain", created_at: "2026-01-01" },
];

describe("<FolderTree>", () => {
  it("renders top-level folders", () => {
    render(<FolderTree folders={folders} selected={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /chassis/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /powertrain/i })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /chassis/i }));
    expect(onSelect).toHaveBeenCalledWith("f1");
  });
});
