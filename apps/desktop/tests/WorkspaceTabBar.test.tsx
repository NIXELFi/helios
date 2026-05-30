import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceTabBar, computeDropIndex } from "../src/components/WorkspaceTabBar";
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
    fireEvent.click(screen.getByRole("button", { name: /more workspace actions/i }));
    fireEvent.click(screen.getByRole("button", { name: /^import/i }));
    expect(props.onImport).toHaveBeenCalled();
  });

  it("Export all button fires onExportAll", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /more workspace actions/i }));
    fireEvent.click(screen.getByRole("button", { name: /export all/i }));
    expect(props.onExportAll).toHaveBeenCalled();
  });
});

describe("WorkspaceTabBar — inline rename", () => {
  it("double-click on the label puts the tab in rename mode", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.doubleClick(screen.getByText("Overview"));
    expect(screen.getByDisplayValue("Overview")).toBeInTheDocument();
  });

  it("Enter commits the new label", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.doubleClick(screen.getByText("Overview"));
    const input = screen.getByDisplayValue("Overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Track A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("a", "Track A");
  });

  it("Escape cancels", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.doubleClick(screen.getByText("Overview"));
    const input = screen.getByDisplayValue("Overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Track A" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("empty / whitespace-only commit is treated as cancel", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.doubleClick(screen.getByText("Overview"));
    const input = screen.getByDisplayValue("Overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("starting a second rename while one is active does not mis-commit the first edit onto the second tab", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    // Begin renaming tab A and type a new value, but DON'T commit.
    fireEvent.doubleClick(screen.getByText("Overview"));
    const inputA = screen.getByDisplayValue("Overview") as HTMLInputElement;
    fireEvent.change(inputA, { target: { value: "Edited A" } });
    // Now begin renaming tab B. The first input blurs as part of this. Whatever
    // commits must NOT write tab A's typed text ("Edited A") onto tab B.
    fireEvent.doubleClick(screen.getByText("Engine focus"));
    // No rename should target "b" with the stale "Edited A" text.
    expect(props.onRename).not.toHaveBeenCalledWith("b", "Edited A");
    // The pending edit IS flushed to its own tab ("a"), not lost or misrouted.
    expect(props.onRename).toHaveBeenCalledWith("a", "Edited A");
  });
});

describe("computeDropIndex", () => {
  // Tabs at: [0..50] [50..100] [100..150]
  const rects: Array<Pick<DOMRect, "left" | "right">> = [
    { left: 0, right: 50 },
    { left: 50, right: 100 },
    { left: 100, right: 150 },
  ];

  it("snaps to the gap before the tab whose midpoint mouseX is left of", () => {
    expect(computeDropIndex(rects, 24)).toBe(0);
    expect(computeDropIndex(rects, 26)).toBe(1);
    expect(computeDropIndex(rects, 76)).toBe(2);
  });

  it("snaps past the last tab when mouseX is past the rightmost midpoint", () => {
    expect(computeDropIndex(rects, 200)).toBe(3);
  });

  it("clamps negative inputs to 0", () => {
    expect(computeDropIndex(rects, -10)).toBe(0);
  });
});

describe("WorkspaceTabBar — context menu", () => {
  it("right-click on a tab opens the TabContextMenu", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /overview/i }));
    expect(screen.getByRole("menu", { name: /workspace actions/i })).toBeInTheDocument();
  });

  it("Delete entry is disabled when only one workspace remains", () => {
    const props = defaultProps({ workspaces: [ws[0]], activeId: "a" });
    render(<WorkspaceTabBar {...props} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /overview/i }));
    const del = screen.getByRole("menuitem", { name: /^delete$/i });
    expect(del).toHaveAttribute("aria-disabled", "true");
  });

  it("clicking Duplicate fires onDuplicate with the right id", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /engine focus/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /duplicate/i }));
    expect(props.onDuplicate).toHaveBeenCalledWith("b");
  });

  it("clicking Export fires onExport with the right id", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /overview/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));
    expect(props.onExport).toHaveBeenCalledWith("a");
  });
});
