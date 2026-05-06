import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceTabBar } from "../src/components/WorkspaceTabBar";
import type { Workspace } from "../src/workspaces/types";

afterEach(cleanup);

const ws: Workspace[] = [
  { id: "a", label: "Overview",     color: "#FFC627", tiles: [] },
  { id: "b", label: "Engine focus", color: "#EF5350", tiles: [] },
];

function defaultProps(overrides = {}) {
  return {
    workspaces: ws,
    activeId: "a",
    appVersion: "2.3.2",
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onRecolor: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
    onExport: vi.fn(),
    onExportAll: vi.fn(),
    onImport: vi.fn(),
    ...overrides,
  };
}

describe("WorkspaceTabBar — rendering", () => {
  it("renders one tab per workspace with its label and color swatch", () => {
    render(<WorkspaceTabBar {...defaultProps()} />);
    expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /engine focus/i })).toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-swatch").length).toBe(2);
  });

  it("clicking a tab fires onSelect", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: /engine focus/i }));
    expect(props.onSelect).toHaveBeenCalledWith("b");
  });

  it("+ New workspace button fires onCreate", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /new workspace/i }));
    expect(props.onCreate).toHaveBeenCalled();
  });

  it("Import button fires onImport", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^import/i }));
    expect(props.onImport).toHaveBeenCalled();
  });

  it("Export all button fires onExportAll", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /export all/i }));
    expect(props.onExportAll).toHaveBeenCalled();
  });
});
