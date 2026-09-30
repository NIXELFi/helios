/* "Open in Logs" with a lap selection attached.
 *
 * The part worth pinning down is the mapping from a simulator lap number to a
 * Logs lap. They are different tables built by different programs, and the
 * obvious shortcut -- "lap N is laps[N]" -- is wrong whenever there is an out
 * lap in front, which on a simulator run there always is: the car sits on the
 * grid before the green flag. So the test builds the beacon the way the
 * simulator's recorder writes it (low on row 0, three rows high at the start
 * line and at every lap close) and runs Logs' own detector over it. */
import { describe, it, expect, vi } from "vitest";
import { detectLaps, type LapSet } from "@helios/lib";

import {
  labelForPath, lapIndexForNumber, requestOpenInLogs, resolveOpenSelection,
  type OpenInLogsDetail,
} from "../src/lib/open-in-logs";

/** A 100 Hz beacon that pulses at each of `crossingsS`, as the recorder does. */
function simLaps(crossingsS: number[], endS: number): LapSet {
  const n = Math.round(endS * 100) + 1;
  const timeUs = new BigInt64Array(n);
  const beacon = new Float64Array(n);
  for (let i = 0; i < n; i++) timeUs[i] = BigInt(Math.round(i * 10_000));
  for (const c of crossingsS) {
    const at = Math.round(c * 100);
    for (let k = 0; k < 3 && at + k < n; k++) if (at + k > 0) beacon[at + k] = 1;
  }
  return detectLaps(
    { mode: "beacon", beacon: { channelId: "system.beacon", threshold: 0.5 } },
    { timeUs, resolve: (id) => (id === "system.beacon" ? beacon : undefined), unitsOf: () => undefined },
  );
}

describe("a simulator lap number is a Logs lap NUMBER, not an array position", () => {
  // Green flag at 2.0 s, laps closing at 45 s, 88 s and 130 s; data runs on
  // to 133 s while the car coasts to a stop.
  const set = simLaps([2, 45, 88, 130], 133);

  it("has the grid as an untrusted lap 0 in front", () => {
    expect(set.laps[0]).toMatchObject({ index: 0, trusted: false });
  });

  it("finds sim lap N at Logs lap N, which is array position N here", () => {
    for (const n of [1, 2, 3]) {
      const i = lapIndexForNumber(set, n);
      expect(set.laps[i]!.index).toBe(n);
      expect(set.laps[i]!.trusted).toBe(true);
    }
    // Lap 2 runs from the 45 s crossing to the 88 s one.
    expect(set.laps[lapIndexForNumber(set, 2)]!.startUs).toBe(45_000_000);
    expect(set.laps[lapIndexForNumber(set, 2)]!.endUs).toBe(88_000_000);
  });

  it("still finds it by number when there is no out lap in front", () => {
    // A beacon that could not pulse before row 1: the first lap starts at
    // the very first sample and nothing precedes it.
    const set2 = simLaps([0.01, 43], 44);
    const i = lapIndexForNumber(set2, 1);
    expect(set2.laps[i]!.index).toBe(1);
    expect(i).toBe(set2.laps.findIndex((l) => l.index === 1));
  });

  it("does not invent a lap the table does not have", () => {
    expect(lapIndexForNumber(set, 7)).toBe(-1);
    expect(lapIndexForNumber(null, 1)).toBe(-1);
  });
});

describe("resolving a selection against what actually loaded", () => {
  const rec = { id: "user:rec", sourcePath: "C:/runs/rec/telemetry.csv", laps: simLaps([2, 45, 88], 90) };
  const mine = { id: "user:mine", sourcePath: "C:/runs/mine/telemetry.csv", laps: simLaps([3, 47], 49) };

  it("sets Main and Ref by path and lap number, and zooms on the record's clock", () => {
    const r = resolveOpenSelection({
      main: { path: rec.sourcePath, lap: 2 },
      ref: { path: mine.sourcePath, lap: 1 },
      zoom: { path: rec.sourcePath, startS: 57.1, endS: 69.53 },
    }, [rec, mine]);
    expect(r.main).toEqual({ sessionId: "user:rec", lapIndex: 2 });
    expect(r.ref).toEqual({ sessionId: "user:mine", lapIndex: 1 });
    // time_s is loaded as microseconds with no rebasing; half a second either side.
    expect(r.zoom).toEqual({ startUs: 56_600_000, endUs: 70_030_000 });
    expect(r.primaryId).toBe("user:rec");
  });

  it("skips whatever did not load rather than guessing", () => {
    const r = resolveOpenSelection({
      main: { path: rec.sourcePath, lap: 2 },
      ref: { path: "C:/runs/gone/telemetry.csv", lap: 1 },
      zoom: { path: "C:/runs/gone/telemetry.csv", startS: 1, endS: 2 },
    }, [rec]);
    expect(r.main).toEqual({ sessionId: "user:rec", lapIndex: 2 });
    expect(r.ref).toBeNull();
    expect(r.zoom).toBeNull();
    expect(r.primaryId).toBe("user:rec");
  });
});

describe("per-path labels", () => {
  it("falls back to the single label, which older callers still send", () => {
    const d: OpenInLogsDetail = { paths: ["a", "b"], label: "Both", labels: ["Record"] };
    expect(labelForPath(d, 0)).toBe("Record");
    expect(labelForPath(d, 1)).toBe("Both");
    expect(labelForPath({ paths: ["a"] }, 0)).toBeUndefined();
  });

  it("carries labels and selection on the event", () => {
    const seen = vi.fn();
    const h = (e: Event) => seen((e as CustomEvent).detail);
    window.addEventListener("helios:open-in-logs", h);
    requestOpenInLogs(["a", "b"], undefined, { labels: ["A", "B"], selection: { main: { path: "a", lap: 1 } } });
    requestOpenInLogs(["c"], "Old style");
    window.removeEventListener("helios:open-in-logs", h);
    expect(seen.mock.calls[0]![0]).toMatchObject({ paths: ["a", "b"], labels: ["A", "B"], selection: { main: { path: "a", lap: 1 } } });
    expect(seen.mock.calls[1]![0]).toMatchObject({ paths: ["c"], label: "Old style" });
  });
});
