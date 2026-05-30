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

  it("closes on Escape from a window-level key event (input not focused)", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} actions={[action("a", "X")]} />);
    // Dispatch on window/document, not the input — handler must be global.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates with ArrowDown via a window-level key event", () => {
    render(<CommandPalette open onClose={() => {}} actions={[
      action("a", "Alpha"), action("b", "Bravo"), action("c", "Charlie"),
    ]} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const options = screen.getAllByRole("option");
    expect(options[1]!).toHaveAttribute("aria-selected", "true");
    expect(options[0]!).toHaveAttribute("aria-selected", "false");
  });

  it("L10 — does not run an off-screen action and clamps selection to the 30 shown rows", () => {
    // 40 matching actions; only 30 render. The footer count and Enter must
    // both stay within the shown slice.
    const runs = Array.from({ length: 40 }, () => vi.fn());
    const actions: PaletteAction[] = runs.map((run, i) => ({
      id: `a${i}`, label: `Action ${String(i).padStart(2, "0")}`, kind: "workspace", run,
    }));
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} actions={actions} />);

    // Only 30 rows are rendered.
    expect(screen.getAllByRole("option")).toHaveLength(30);

    // Press ArrowDown far past the 30-row cap (e.g. 50 times). Selection must
    // clamp to the last SHOWN row (index 29), never beyond.
    act(() => {
      for (let i = 0; i < 50; i++) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      }
    });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(30);
    // The last shown row is highlighted (not an off-screen row 30..39).
    expect(options[29]!).toHaveAttribute("aria-selected", "true");

    // Enter runs a row that is actually on screen (index 29), not an
    // off-screen one.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(runs[29]).toHaveBeenCalledTimes(1);
    // No off-screen action (>=30) was ever run.
    for (let i = 30; i < 40; i++) expect(runs[i]).not.toHaveBeenCalled();
  });

  it("footer reflects the TOTAL filtered count when capped, while only 30 rows render", () => {
    const actions: PaletteAction[] = Array.from({ length: 40 }, (_, i) => action(`a${i}`, `Action ${i}`));
    render(<CommandPalette open onClose={() => {}} actions={actions} />);
    // Only 30 rows render…
    expect(screen.getAllByRole("option")).toHaveLength(30);
    // …but the footer tells the user there are 40 in total ("showing 30 of 40").
    expect(screen.getByText(/showing 30 of 40/i)).toBeInTheDocument();
  });

  it("footer shows a plain match count when nothing is capped", () => {
    const actions: PaletteAction[] = [action("a", "Alpha"), action("b", "Bravo")];
    render(<CommandPalette open onClose={() => {}} actions={actions} />);
    expect(screen.getByText(/2 matches/)).toBeInTheDocument();
    expect(screen.queryByText(/showing/i)).toBeNull();
  });

  it("footer is singular for a single match", () => {
    render(<CommandPalette open onClose={() => {}} actions={[action("a", "Alpha")]} />);
    expect(screen.getByText(/^1 match$/)).toBeInTheDocument();
  });

  // CommandPalette Tab — Tab/Shift+Tab cycle within the dialog (focus-trap),
  // mirroring the other modals. With a single focusable (the filter input,
  // which is both first and last), the trap preventDefaults the Tab and keeps
  // focus inside rather than letting it escape to the document body.
  it("traps Tab focus within the dialog (preventDefault + focus stays inside)", () => {
    render(<CommandPalette open onClose={() => {}} actions={[action("a", "Alpha")]} />);
    const input = screen.getByLabelText("Filter commands");
    input.focus();
    expect(document.activeElement).toBe(input);

    const fwd = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(fwd); });
    // The trap handled Tab (prevented the default tab-out) and kept focus in.
    expect(fwd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(back); });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });
});
