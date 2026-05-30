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

  it("X8: rows are real, focusable <button> elements (keyboard-accessible)", () => {
    const onSelect = vi.fn();
    render(<VersionList versions={versions as any} onSelect={onSelect} />);
    const rows = screen.getAllByRole("button");
    expect(rows.length).toBe(versions.length);
    // Native buttons are inherently keyboard-operable (Enter/Space → click);
    // assert they're real <button> elements with a type, not clickable divs.
    expect(rows[0].tagName).toBe("BUTTON");
    expect(rows[0]).toHaveAttribute("type", "button");
    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith("v3");
  });

  it("X8: formats created_at instead of dumping the raw ISO string", () => {
    render(<VersionList versions={versions as any} onSelect={() => {}} />);
    // None of the bare ISO dates are rendered verbatim.
    expect(screen.queryByText("2026-03-01")).toBeNull();
    expect(screen.queryByText("2026-02-01")).toBeNull();
    expect(screen.queryByText("2026-01-01")).toBeNull();
    // A locale-formatted date (slash-separated, not the dashed ISO form)
    // appears instead — one per row.
    expect(screen.getAllByText(/\d+\/\d+\/\d{4}/).length).toBe(versions.length);
  });

  it("X8: shows an empty state when there are no versions", () => {
    render(<VersionList versions={[]} onSelect={() => {}} />);
    expect(screen.getByText(/no versions yet/i)).toBeInTheDocument();
  });

  it("shows a revision badge when a version has a revision", () => {
    const withRev = [{ ...versions[0], revision: 2 }, ...versions.slice(1)];
    render(<VersionList versions={withRev as any} onSelect={() => {}} />);
    expect(screen.getByText(/rev\s*2/i)).toBeInTheDocument();
  });

  it("renders no revision badge for versions without a revision", () => {
    render(<VersionList versions={versions as any} onSelect={() => {}} />);
    expect(screen.queryByText(/^rev\s*\d+/i)).toBeNull();
  });

  it("renders renderActions output once per version", () => {
    render(
      <VersionList
        versions={versions as any}
        onSelect={() => {}}
        renderActions={(v) => <span>act-{(v as any).version_num}</span>}
      />,
    );
    expect(screen.getByText("act-3")).toBeInTheDocument();
    expect(screen.getByText("act-2")).toBeInTheDocument();
    expect(screen.getByText("act-1")).toBeInTheDocument();
  });

  it("row action is a sibling of the row button (not nested) — activating it does not select the row", () => {
    const onSelect = vi.fn();
    render(
      <VersionList
        versions={versions as any}
        onSelect={onSelect}
        renderActions={(v) => <button type="button">act-{(v as any).version_num}</button>}
      />,
    );
    // Click the action button. If it were nested inside the row <button>, the
    // click would bubble and fire onSelect. A sibling must not.
    fireEvent.click(screen.getByRole("button", { name: "act-3" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still selects the row when the row body is clicked, with actions present", () => {
    const onSelect = vi.fn();
    render(
      <VersionList versions={versions as any} onSelect={onSelect} renderActions={() => <span>x</span>} />,
    );
    fireEvent.click(screen.getByText(/third/));
    expect(onSelect).toHaveBeenCalledWith("v3");
  });
});
