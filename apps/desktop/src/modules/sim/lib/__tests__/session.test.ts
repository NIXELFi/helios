import { describe, it, expect } from "vitest";
import { runsInSession } from "../../components/SessionSummary";
import type { SimRun } from "../../api";

/** A run that only carries what `runsInSession` looks at. */
function run(runId: string, startedAt: string | null): SimRun {
  return { runId, startedAt } as SimRun;
}

const T = (iso: string) => Date.parse(iso);

describe("runsInSession", () => {
  const win = {
    startedAtMs: T("2026-09-18T18:00:00.000Z"),
    endedAtMs: T("2026-09-18T18:40:00.000Z"),
  };

  it("keeps the runs driven while the simulator was open", () => {
    const out = runsInSession(
      [
        run("a", "2026-09-18T18:05:00.000Z"),
        run("b", "2026-09-18T18:30:00.000Z"),
      ],
      win,
    );
    expect(out.map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("drops runs from before the session and after it", () => {
    const out = runsInSession(
      [
        run("earlier", "2026-09-18T17:00:00.000Z"),
        run("during", "2026-09-18T18:20:00.000Z"),
        run("later", "2026-09-18T19:30:00.000Z"),
      ],
      win,
    );
    expect(out.map((r) => r.runId)).toEqual(["during"]);
  });

  it("returns them oldest first, which is the order they were driven", () => {
    const out = runsInSession(
      [
        run("third", "2026-09-18T18:30:00.000Z"),
        run("first", "2026-09-18T18:02:00.000Z"),
        run("second", "2026-09-18T18:11:00.000Z"),
      ],
      win,
    );
    expect(out.map((r) => r.runId)).toEqual(["first", "second", "third"]);
  });

  it("allows for the last run being written as the window closes", () => {
    // The manifest is stamped when the driver pressed start; the run is filed
    // when they stop. A run that began ten seconds before the simulator exited
    // is unambiguously part of the session.
    const out = runsInSession([run("last", "2026-09-18T18:39:50.000Z")], win);
    expect(out.map((r) => r.runId)).toEqual(["last"]);
  });

  it("and for the process starting a moment before the clock was read", () => {
    const out = runsInSession([run("first", "2026-09-18T17:59:58.000Z")], win);
    expect(out.map((r) => r.runId)).toEqual(["first"]);
  });

  it("ignores runs with no start time rather than guessing", () => {
    const out = runsInSession([run("undated", null), run("bad", "not a date")], win);
    expect(out).toEqual([]);
  });

  it("is empty when the session filed nothing", () => {
    expect(runsInSession([], win)).toEqual([]);
  });
});
