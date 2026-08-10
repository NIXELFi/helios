import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { ChannelStore } from "@helios/store";
import { LapSelectionEmitter } from "@helios/lib";
import type { Lap, LapSet } from "@helios/lib";
import { SessionPanel } from "../src/components/SessionPanel";
import { SESSION_PALETTE } from "../src/lib/session";
import type { LoadedSession } from "../src/lib/session";

afterEach(cleanup);

function lap(index: number, durationS: number, trusted = true): Lap {
  return { index, startUs: 0, endUs: 0, durationS, distanceM: NaN, trusted };
}

function makeSession(
  laps: LapSet | null,
  label = "Session 1",
  overrides: Partial<LoadedSession> = {},
): LoadedSession {
  return {
    id: "s1",
    label,
    store: new ChannelStore(),
    color: "#FFC627",
    visible: true,
    lapConfig: { mode: "gps_line" },
    laps,
    channelOverrides: {},
    ...overrides,
  };
}

function setup(session: LoadedSession) {
  const emitter = new LapSelectionEmitter();
  const handlers = {
    onToggleVisibility: vi.fn(),
    onSetPrimary: vi.fn(),
    onConfigureLaps: vi.fn(),
    onAddSession: vi.fn(),
    onRemoveSession: vi.fn(),
    onRenameSession: vi.fn(),
    onRecolorSession: vi.fn(),
  };
  render(
    <SessionPanel
      sessions={[session]}
      primaryId={session.id}
      {...handlers}
      lapSelectionEmitter={emitter}
      lapSelection={emitter.get()}
    />,
  );
  return handlers;
}

describe("SessionPanel — best-lap star (authoritative bestLapIndex)", () => {
  it("stars exactly one lap — the bestLapIndex row — even when two trusted laps share an identical time", () => {
    // Two trusted laps with the SAME durationS. Old code (durationS === min)
    // would star BOTH; bestLapIndex names a single canonical winner.
    const laps: LapSet = {
      laps: [lap(1, 90.5), lap(2, 90.5)],
      bestLapIndex: 0,
      cacheKey: "x",
    };
    setup(makeSession(laps));
    const rows = screen.getAllByRole("row");
    const starred = rows.filter((r) => within(r).queryByText("★"));
    expect(starred.length).toBe(1);
    // The starred row is the first lap (bestLapIndex 0 → lap index 1).
    expect(within(starred[0]!).getByText("1")).toBeInTheDocument();
  });

  it("stars no lap when bestLapIndex is -1", () => {
    const laps: LapSet = {
      laps: [lap(1, 90.5, false)],
      bestLapIndex: -1,
      cacheKey: "x",
    };
    setup(makeSession(laps));
    expect(screen.queryByText("★")).toBeNull();
  });
});

describe("SessionPanel — truncated label tooltip", () => {
  it("sets a title attribute equal to the session label", () => {
    const long = "A Very Long Session Name That Truncates In The Sidebar";
    setup(makeSession(null, long));
    const labelSpan = screen.getByText(long);
    expect(labelSpan).toHaveAttribute("title", long);
  });

  it("names the original file in the tooltip once the session is renamed", () => {
    setup(makeSession(null, "Kaden — endurance", { defaultLabel: "2026-07-31-run3" }));
    expect(screen.getByText("Kaden — endurance"))
      .toHaveAttribute("title", 'Kaden — endurance — renamed from "2026-07-31-run3"');
  });
});

describe("SessionPanel — inline rename", () => {
  function startRenaming(label = "Session 1") {
    fireEvent.doubleClick(screen.getByText(label));
    return screen.getByRole("textbox");
  }

  it("swaps the label for a text input on double-click, pre-filled and selected", () => {
    setup(makeSession(null));
    const input = startRenaming() as HTMLInputElement;
    expect(input.value).toBe("Session 1");
    // Select-all on focus so typing replaces rather than appends.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Session 1".length);
  });

  it("commits on Enter", () => {
    const h = setup(makeSession(null));
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "  Kaden  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRenameSession).toHaveBeenCalledWith("s1", "Kaden");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("commits on blur", () => {
    const h = setup(makeSession(null));
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "Kaden" } });
    fireEvent.blur(input);
    expect(h.onRenameSession).toHaveBeenCalledWith("s1", "Kaden");
  });

  it("discards the edit on Escape", () => {
    const h = setup(makeSession(null));
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "Kaden" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(h.onRenameSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Session 1")).toBeInTheDocument();
  });

  it("clears the override when committed empty", () => {
    const h = setup(makeSession(null, "Kaden", { defaultLabel: "run-3" }));
    const input = startRenaming("Kaden");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRenameSession).toHaveBeenCalledWith("s1", null);
  });

  it("clears the override when the text is typed back to the filename label", () => {
    const h = setup(makeSession(null, "Kaden", { defaultLabel: "run-3" }));
    const input = startRenaming("Kaden");
    fireEvent.change(input, { target: { value: "run-3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRenameSession).toHaveBeenCalledWith("s1", null);
  });

  it("does not call back when the label is committed unchanged", () => {
    const h = setup(makeSession(null));
    const input = startRenaming();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onRenameSession).not.toHaveBeenCalled();
  });
});

describe("SessionPanel — recolor popover", () => {
  function openPopover(label = "Session 1") {
    fireEvent.click(screen.getByLabelText(`Change color for ${label}`));
  }

  it("opens on swatch click without making the session primary", () => {
    const h = setup(makeSession(null));
    openPopover();
    expect(screen.getByLabelText(`Set color ${SESSION_PALETTE[3]}`)).toBeInTheDocument();
    // The row's own click handler sets primary — the swatch must not trip it.
    expect(h.onSetPrimary).not.toHaveBeenCalled();
  });

  it("pins the picked palette color and closes", () => {
    const h = setup(makeSession(null));
    openPopover();
    fireEvent.click(screen.getByLabelText(`Set color ${SESSION_PALETTE[3]}`));
    expect(h.onRecolorSession).toHaveBeenCalledWith("s1", SESSION_PALETTE[3]);
    expect(screen.queryByLabelText(`Set color ${SESSION_PALETTE[3]}`)).toBeNull();
  });

  it("clears the override via the auto entry", () => {
    const h = setup(makeSession(null));
    openPopover();
    fireEvent.click(screen.getByText("auto"));
    expect(h.onRecolorSession).toHaveBeenCalledWith("s1", null);
  });

  it("closes on Escape without recoloring", () => {
    const h = setup(makeSession(null));
    openPopover();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("auto")).toBeNull();
    expect(h.onRecolorSession).not.toHaveBeenCalled();
  });

  it("closes on a click outside without recoloring", () => {
    const h = setup(makeSession(null));
    openPopover();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("auto")).toBeNull();
    expect(h.onRecolorSession).not.toHaveBeenCalled();
  });
});
