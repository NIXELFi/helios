import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { ChannelStore } from "@helios/store";
import { LapSelectionEmitter } from "@helios/lib";
import type { Lap, LapSet } from "@helios/lib";
import { SessionPanel } from "../src/components/SessionPanel";
import type { LoadedSession } from "../src/lib/session";

afterEach(cleanup);

function lap(index: number, durationS: number, trusted = true): Lap {
  return { index, startUs: 0, endUs: 0, durationS, distanceM: NaN, trusted };
}

function makeSession(laps: LapSet | null, label = "Session 1"): LoadedSession {
  return {
    id: "s1",
    label,
    store: new ChannelStore(),
    color: "#FFC627",
    visible: true,
    lapConfig: { mode: "gps_line" },
    laps,
    channelOverrides: {},
  };
}

function setup(session: LoadedSession) {
  const emitter = new LapSelectionEmitter();
  render(
    <SessionPanel
      sessions={[session]}
      primaryId={session.id}
      onToggleVisibility={vi.fn()}
      onSetPrimary={vi.fn()}
      onConfigureLaps={vi.fn()}
      onAddSession={vi.fn()}
      onRemoveSession={vi.fn()}
      lapSelectionEmitter={emitter}
      lapSelection={emitter.get()}
    />,
  );
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
});
