import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { VersionList } from "../../src/modules/vault/components/VersionList";

const versions = [
  { id: "v3", file_id: "f", version_num: 3, sha256: "x", size_bytes: 100, author_id: "u", comment: "third", parent_version_id: "v2", created_at: "2026-03-01" },
  { id: "v2", file_id: "f", version_num: 2, sha256: "y", size_bytes: 100, author_id: "u", comment: "second", parent_version_id: "v1", created_at: "2026-02-01" },
  { id: "v1", file_id: "f", version_num: 1, sha256: "z", size_bytes: 100, author_id: "u", comment: "first", parent_version_id: null, created_at: "2026-01-01" },
];

describe("<VersionList>", () => {
  it("renders one row per version", () => {
    render(<VersionList versions={versions as any} onSelect={() => {}} />);
    expect(screen.getByText(/third/)).toBeInTheDocument();
    expect(screen.getByText(/second/)).toBeInTheDocument();
    expect(screen.getByText(/first/)).toBeInTheDocument();
  });

  it("displays version number prefix", () => {
    render(<VersionList versions={versions as any} onSelect={() => {}} />);
    expect(screen.getByText(/v3/i)).toBeInTheDocument();
    expect(screen.getByText(/v1/i)).toBeInTheDocument();
  });

  it("emits onSelect when a row is clicked", () => {
    const onSelect = vi.fn();
    render(<VersionList versions={versions as any} onSelect={onSelect} />);
    fireEvent.click(screen.getByText(/third/));
    expect(onSelect).toHaveBeenCalledWith("v3");
  });
});
