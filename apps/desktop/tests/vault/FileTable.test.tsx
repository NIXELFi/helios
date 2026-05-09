import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FileTable } from "../../src/modules/vault/components/FileTable";

const files = [
  { id: "f1", vault_id: "v", folder_id: null, name: "frame.sldprt", latest_version_id: "ver1", created_at: "2026-01-01" },
  { id: "f2", vault_id: "v", folder_id: null, name: "wheel.sldprt", latest_version_id: null, created_at: "2026-01-01" },
];

describe("<FileTable>", () => {
  it("renders one row per file", () => {
    render(<FileTable files={files} selected={null} locks={[]} currentUserId="u" onSelect={() => {}} />);
    expect(screen.getByText("frame.sldprt")).toBeInTheDocument();
    expect(screen.getByText("wheel.sldprt")).toBeInTheDocument();
  });

  it("emits onSelect when a row is clicked", () => {
    const onSelect = vi.fn();
    render(<FileTable files={files} selected={null} locks={[]} currentUserId="u" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("frame.sldprt"));
    expect(onSelect).toHaveBeenCalledWith("f1");
  });

  it("shows 'Locked by me' badge when current user holds the lock", () => {
    const locks = [{ id: "l1", file_id: "f1", user_id: "u", acquired_at: "x", released_at: null, force_released_by: null }];
    render(<FileTable files={files} selected={null} locks={locks as any} currentUserId="u" onSelect={() => {}} />);
    expect(screen.getByText(/locked by me/i)).toBeInTheDocument();
  });
});
