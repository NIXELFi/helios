import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { filterActions, CommandPalette, type PaletteAction } from "../src/components/CommandPalette";

function action(id: string, label: string, kind: PaletteAction["kind"] = "workspace", keywords: string[] = []): PaletteAction {
  return { id, label, kind, keywords, run: () => {} };
}

describe("filterActions", () => {
  const actions: PaletteAction[] = [
    action("a", "Overview"),
    action("b", "Lap Analysis"),
    action("c", "Engine focus"),
    action("d", "Channels modal", "system"),
    action("e", "Math editor", "system", ["formula", "expression"]),
  ];

  it("returns all actions for an empty query (original order preserved)", () => {
    const r = filterActions(actions, "");
    expect(r.map((a) => a.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("ranks exact matches above prefix matches above substring matches", () => {
    // "engine" — exact match on "engine focus" prefix; not present elsewhere.
    const r = filterActions(actions, "engine");
    expect(r[0]!.id).toBe("c");
  });

  it("matches by keyword aliases", () => {
    // "formula" only appears as a keyword on the math editor.
    const r = filterActions(actions, "formula");
    expect(r[0]!.id).toBe("e");
  });

  it("matches by subsequence (chars in order, not necessarily contiguous)", () => {
    // "lpa" → "Lap Analysis" via subsequence.
    const r = filterActions(actions, "lpa");
    expect(r.some((a) => a.id === "b")).toBe(true);
  });

  it("returns empty list when no field matches", () => {
    const r = filterActions(actions, "xyzzyqq");
    expect(r).toEqual([]);
  });

  it("is case-insensitive", () => {
    const r = filterActions(actions, "LAP");
    expect(r[0]!.id).toBe("b");
  });
});

describe("CommandPalette component", () => {
  it("does not render anything when closed", () => {
    const { container } = render(<CommandPalette open={false} onClose={() => {}} actions={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} actions={[action("a", "X")]} />);
    const input = screen.getByLabelText("Filter commands");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("runs the highlighted action on Enter and closes", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} actions={[
      { id: "a", label: "Switch to Overview", kind: "workspace", run },
    ]} />);
    const input = screen.getByLabelText("Filter commands");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
