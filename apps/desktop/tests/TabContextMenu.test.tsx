import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { TabContextMenu } from "../src/components/TabContextMenu";

afterEach(cleanup);

const PALETTE = ["#FFC627", "#4FC3F7", "#66BB6A", "#EF5350"];

function defaultProps(overrides = {}) {
  return {
    anchor: { x: 100, y: 100 },
    canDelete: true,
    palette: PALETTE,
    onRename: vi.fn(),
    onRecolor: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("TabContextMenu", () => {
  it("renders all five primary entries", () => {
    render(<TabContextMenu {...defaultProps()} />);
    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /color/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /duplicate/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /export/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
  });

  it("disables Delete when canDelete=false; click is a no-op", () => {
    const props = defaultProps({ canDelete: false });
    render(<TabContextMenu {...props} />);
    const del = screen.getByRole("menuitem", { name: /delete/i });
    expect(del).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(del);
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("clicking Rename calls onRename + onClose", () => {
    const props = defaultProps();
    render(<TabContextMenu {...props} />);
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    expect(props.onRename).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it("Color submenu shows palette swatches and calls onRecolor with the chosen hex", () => {
    const props = defaultProps();
    render(<TabContextMenu {...props} />);
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /color/i }));
    const swatches = screen.getAllByRole("menuitem", { name: /color #/i });
    expect(swatches.length).toBe(PALETTE.length);
    fireEvent.click(swatches[1]!);
    expect(props.onRecolor).toHaveBeenCalledWith(PALETTE[1]);
  });

  it("Escape closes the menu", () => {
    const props = defaultProps();
    render(<TabContextMenu {...props} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("menu items are focusable buttons (not plain divs)", () => {
    render(<TabContextMenu {...defaultProps()} />);
    const rename = screen.getByRole("menuitem", { name: /rename/i });
    expect(rename.tagName).toBe("BUTTON");
  });

  it("focuses the first item on open", () => {
    render(<TabContextMenu {...defaultProps()} />);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /rename/i }));
  });

  it("ArrowDown moves focus to the next item", () => {
    render(<TabContextMenu {...defaultProps()} />);
    const menu = screen.getByRole("menu", { name: /workspace actions/i });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /color/i }));
  });

  it("ArrowUp from the first item wraps to the last enabled item", () => {
    render(<TabContextMenu {...defaultProps()} />);
    const menu = screen.getByRole("menu", { name: /workspace actions/i });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /delete/i }));
  });

  it("Enter on a focused item activates it and closes", () => {
    const props = defaultProps();
    render(<TabContextMenu {...props} />);
    const rename = screen.getByRole("menuitem", { name: /rename/i });
    rename.focus();
    fireEvent.keyDown(rename, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it("Space on a focused item activates it", () => {
    const props = defaultProps();
    render(<TabContextMenu {...props} />);
    const dup = screen.getByRole("menuitem", { name: /duplicate/i });
    dup.focus();
    fireEvent.keyDown(dup, { key: " " });
    expect(props.onDuplicate).toHaveBeenCalled();
  });

  it("opens the Color submenu from the keyboard (ArrowRight / Enter) and lets a swatch be chosen", () => {
    const props = defaultProps();
    render(<TabContextMenu {...props} />);
    const color = screen.getByRole("menuitem", { name: /^color$/i });
    color.focus();
    fireEvent.keyDown(color, { key: "ArrowRight" });
    const swatches = screen.getAllByRole("menuitem", { name: /color #/i });
    expect(swatches.length).toBe(PALETTE.length);
    fireEvent.keyDown(swatches[2]!, { key: "Enter" });
    expect(props.onRecolor).toHaveBeenCalledWith(PALETTE[2]);
  });
});
