// Screen tests for the optimization results overhaul. We mock useCfd minimally
// (cancelStudy + a bridge whose getParameterSchema resolves) so we don't have
// to stand up a full CfdProvider, and mock lib/export/io so clipboard/save
// calls are observable without a Tauri runtime.

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { makeOptimizationStudy, makeTrial, makeSweepPoint } from "./fakes/study";
import type { OptimizationStudy } from "../state/types";

// --- Mocks --------------------------------------------------------------------

const cancelStudy = vi.fn(async () => {});
const getParameterSchema = vi.fn(async () => []);

// IMPORTANT: the context value must be referentially STABLE across renders,
// like the real CfdProvider's memoized value. A fresh object per call gives
// every render a new `bridge` identity, which re-fires any effect/memo keyed
// on it (e.g. useParameterSchema's [configPath, bridge]) in an endless
// setState loop.
const stableCtx = {
  cancelStudy,
  bridge: { getParameterSchema },
};
vi.mock("../state/CfdContext", () => ({
  useCfd: () => stableCtx,
}));

const copyText = vi.fn(async (_text: string) => {});
const saveTextFile = vi.fn(
  async (_name: string, _ext: string, _contents: string) => "C:/out/cfd-optimization-sdm26-x.csv",
);
vi.mock("../lib/export/io", () => ({
  copyText: (text: string) => copyText(text),
  saveTextFile: (name: string, ext: string, contents: string) => saveTextFile(name, ext, contents),
  savePngFile: vi.fn(),
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  fileTimestamp: () => "x",
}));

// Imported AFTER the mocks above so they take effect.
import { OptimizationResults } from "../results/OptimizationResults";

beforeEach(() => {
  cancelStudy.mockClear();
  getParameterSchema.mockClear();
  copyText.mockClear();
  saveTextFile.mockClear();
});

// --- Helpers ------------------------------------------------------------------

/** Read the trial table's data rows as arrays of cell text. */
function tableRows(): string[][] {
  const tables = document.querySelectorAll("table");
  const table = tables[tables.length - 1]!; // the trial table is last
  return Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim() ?? ""),
  );
}

// --- Tests --------------------------------------------------------------------

describe("OptimizationResults — podium", () => {
  it("fills podium cards in rank order with the right objectives", () => {
    const study = makeOptimizationStudy(); // 55 / 64 / 60 → 64,60,55
    render(<OptimizationResults study={study} />);

    // Podium cards are the first 3 buttons that carry "trial #".
    const podium = screen.getAllByText(/trial #/);
    expect(podium).toHaveLength(3);
    // First card = best = trial #1 (objective 64).
    const card0 = podium[0]!.closest("button")!;
    expect(within(card0).getByText("#1")).toBeInTheDocument();
    expect(within(card0).getByText("trial #1")).toBeInTheDocument();
    expect(within(card0).getByText(/64\.000/)).toBeInTheDocument();
    expect(within(card0).getByText("best")).toBeInTheDocument();
  });

  it("shows dashed placeholders while fewer than 3 trials are done", () => {
    const study = makeOptimizationStudy({
      status: "running",
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50 }),
        makeTrial({ trialIdx: 1, status: "pending", objectiveValue: null }),
        makeTrial({ trialIdx: 2, status: "pending", objectiveValue: null }),
      ],
    });
    render(<OptimizationResults study={study} />);
    // One filled card + two dashed placeholders.
    expect(screen.getAllByText(/trial #/)).toHaveLength(1);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});

describe("OptimizationResults — header / ETA gating", () => {
  it("renders the live best in the header even mid-run", () => {
    const study = makeOptimizationStudy({
      status: "running",
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50 }),
        makeTrial({ trialIdx: 1, objectiveValue: 64 }),
        makeTrial({ trialIdx: 2, status: "running", objectiveValue: null }),
      ],
    });
    render(<OptimizationResults study={study} />);
    expect(screen.getByText(/best #1 =/)).toBeInTheDocument();
  });

  it("hides ETA with <3 done trials", () => {
    const study = makeOptimizationStudy({
      status: "running",
      params: { ...makeOptimizationStudy().params, nTrials: 20 },
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50, wallTimeS: 4 }),
        makeTrial({ trialIdx: 1, objectiveValue: 60, wallTimeS: 4 }),
      ],
    });
    render(<OptimizationResults study={study} />);
    expect(screen.queryByText(/est\./)).toBeNull();
  });

  it("shows ETA with ≥3 done trials while running", () => {
    const study = makeOptimizationStudy({
      status: "running",
      params: { ...makeOptimizationStudy().params, nTrials: 20 },
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50, wallTimeS: 6 }),
        makeTrial({ trialIdx: 1, objectiveValue: 60, wallTimeS: 6 }),
        makeTrial({ trialIdx: 2, objectiveValue: 55, wallTimeS: 6 }),
      ],
    });
    render(<OptimizationResults study={study} />);
    expect(screen.getByText(/est\./)).toBeInTheDocument();
  });

  it("does not show ETA once the study is done (not running)", () => {
    const study = makeOptimizationStudy({ status: "done" }); // 3 done trials
    render(<OptimizationResults study={study} />);
    expect(screen.queryByText(/est\./)).toBeNull();
  });
});

describe("OptimizationResults — ranks", () => {
  it("rank 1 in the table equals study.bestTrialIdx after the done summary", () => {
    const study = makeOptimizationStudy(); // bestTrialIdx = 1
    render(<OptimizationResults study={study} />);
    const rows = tableRows();
    // Table default sort is rank asc → first row is rank 1.
    const firstRow = rows[0]!;
    expect(firstRow[0]).toBe("1"); // rank column
    expect(firstRow[1]).toBe(String(study.bestTrialIdx)); // trial # column
  });

  it("ranks stay stable (no reorder) when a new trials array arrives", () => {
    const base = makeOptimizationStudy({
      status: "running",
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50 }),
        makeTrial({ trialIdx: 1, objectiveValue: 70 }),
        makeTrial({ trialIdx: 2, status: "pending", objectiveValue: null }),
      ],
    });
    const { rerender } = render(<OptimizationResults study={base} />);
    // Best is trial #1 initially.
    expect(screen.getByText(/best #1 =/)).toBeInTheDocument();

    const next: OptimizationStudy = {
      ...base,
      trials: [base.trials[0]!, base.trials[1]!, makeTrial({ trialIdx: 2, objectiveValue: 60 })],
    };
    rerender(<OptimizationResults study={next} />);
    // Trial #1 (70) is still best; #2 (60) ranks above #0 (50).
    expect(screen.getByText(/best #1 =/)).toBeInTheDocument();
    const rows = tableRows();
    // Rank-sorted: 1 (#1), 2 (#2), 3 (#0).
    expect(rows.map((r) => r[1])).toEqual(["1", "2", "0"]);
  });
});

describe("OptimizationResults — sortable table", () => {
  it("toggles sort direction on repeated header clicks", () => {
    const study = makeOptimizationStudy();
    render(<OptimizationResults study={study} />);

    // Default rank asc → trial order 1,2,0.
    expect(tableRows().map((r) => r[1])).toEqual(["1", "2", "0"]);

    // Click "obj" header → desc (objectives high→low) = 64,60,55 → #1,#2,#0.
    fireEvent.click(screen.getByRole("button", { name: /^obj/ }));
    expect(tableRows().map((r) => r[1])).toEqual(["1", "2", "0"]);
    // Toggle to asc → 55,60,64 → #0,#2,#1.
    fireEvent.click(screen.getByRole("button", { name: /^obj/ }));
    expect(tableRows().map((r) => r[1])).toEqual(["0", "2", "1"]);
  });

  it("sorts by trial # ascending by default when selected", () => {
    const study = makeOptimizationStudy();
    render(<OptimizationResults study={study} />);
    // Exact "#" matches only the trial-# header button (podium chips read "#1").
    fireEvent.click(screen.getByRole("button", { name: "#" }));
    expect(tableRows().map((r) => r[1])).toEqual(["0", "1", "2"]);
  });

  it("partitions rows without the sorted quantity to the bottom in BOTH directions", () => {
    // Review finding: asc obj sort used to float null-objective pending rows
    // to the top (null → -Infinity). They must sink regardless of direction.
    const study = makeOptimizationStudy({
      status: "running",
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50 }),
        makeTrial({ trialIdx: 1, status: "pending", objectiveValue: null }),
        makeTrial({ trialIdx: 2, objectiveValue: 64 }),
      ],
    });
    render(<OptimizationResults study={study} />);
    fireEvent.click(screen.getByRole("button", { name: /^obj/ })); // desc
    expect(tableRows().map((r) => r[1])).toEqual(["2", "0", "1"]);
    fireEvent.click(screen.getByRole("button", { name: /^obj/ })); // asc
    expect(tableRows().map((r) => r[1])).toEqual(["0", "2", "1"]); // pending still last
  });
});

describe("OptimizationResults — exports", () => {
  it("Copy best recipe writes the best trial's params via copyText", async () => {
    const study = makeOptimizationStudy();
    render(<OptimizationResults study={study} />);

    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy best recipe" }));

    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const payload = copyText.mock.calls[0]![0];
    // Best trial (#1) parameter values, tab-separated.
    expect(payload).toContain("runner_length\t0.32");
    expect(payload).toContain("plenum_volume_l\t1.8");
  });

  it("Copy table (TSV) puts a tab-separated table on the clipboard", async () => {
    const study = makeOptimizationStudy();
    render(<OptimizationResults study={study} />);

    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy table (TSV)" }));

    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const payload = copyText.mock.calls[0]![0];
    expect(payload.split("\n")[0]).toContain("\t");
    expect(payload).toContain("trial\tstatus\trank");
  });

  it("exposes the file export actions (Trials CSV, Study JSON)", () => {
    const study = makeOptimizationStudy();
    render(<OptimizationResults study={study} />);
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    expect(screen.getByRole("menuitem", { name: "Trials CSV" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Study JSON" })).toBeInTheDocument();
  });
});

describe("OptimizationResults — selection + inspector", () => {
  it("clicking a podium card selects the trial in the inspector", () => {
    const study = makeOptimizationStudy();
    render(<OptimizationResults study={study} />);
    const card = screen.getByText("trial #1").closest("button")!;
    fireEvent.click(card);
    // Inspector header shows the selected trial.
    expect(screen.getByText("Trial #1")).toBeInTheDocument();
    expect(screen.getByText("Recipe")).toBeInTheDocument();
  });

  it("inspector Copy button copies the recipe as path\\tvalue lines", async () => {
    const study = makeOptimizationStudy();
    render(<OptimizationResults study={study} />);
    fireEvent.click(screen.getByText("trial #2").closest("button")!);
    // The inspector's recipe Copy button (distinct from the export menu).
    const copyBtn = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const payload = copyText.mock.calls[0]![0];
    expect(payload).toContain("runner_length\t");
    expect(payload).toContain("\n");
  });

  it("labels a tied rank-2 trial with a Δ line, never 'best'", () => {
    // Review finding: deltaToBest === 0 used to short-circuit to "best" for a
    // tied rank-2 trial, contradicting its own #2 badge and the podium.
    const study = makeOptimizationStudy({
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 64 }),
        makeTrial({ trialIdx: 1, objectiveValue: 64 }), // tie → rank 2 by trialIdx
        makeTrial({ trialIdx: 2, objectiveValue: 60 }),
      ],
      bestTrialIdx: 0,
      bestObjectiveValue: 64,
    });
    render(<OptimizationResults study={study} />);
    fireEvent.click(screen.getByText("trial #1").closest("button")!);
    const aside = document.querySelector("aside")!;
    expect(within(aside as HTMLElement).queryByText("best")).toBeNull();
    expect(within(aside as HTMLElement).getByText(/Δ 0\.00/)).toBeInTheDocument();
  });

  it("running rows show a pulse dot + 'running' label", () => {
    const study = makeOptimizationStudy({
      status: "running",
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50 }),
        makeTrial({ trialIdx: 1, status: "running", objectiveValue: null }),
      ],
    });
    render(<OptimizationResults study={study} />);
    expect(screen.getByText("running")).toBeInTheDocument();
  });
});

describe("OptimizationResults — event ranking", () => {
  // A sweep curve at a given peak brake torque, spanning the rev range so the
  // accel sim has torque to integrate from launch to redline. Higher peak →
  // quicker accel → lower (better) time, so the three trials rank distinctly.
  const sweep = (peakNm: number) =>
    [4000, 8000, 11000, 14000].map((rpm, i) =>
      makeSweepPoint({ rpm, lastCycle: { brakeTorqueNm: peakNm - i * 5 } }),
    );

  const eventStudy = (): OptimizationStudy =>
    makeOptimizationStudy({
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50, sweepPoints: sweep(48) }),
        makeTrial({ trialIdx: 1, objectiveValue: 64, sweepPoints: sweep(64) }),
        makeTrial({ trialIdx: 2, objectiveValue: 55, sweepPoints: sweep(56) }),
      ],
    });

  it("re-ranks the whole view + inspector to the chosen event metric", () => {
    render(<OptimizationResults study={eventStudy()} />);

    // Default dimension is the backend objective — the convergence chart says "obj".
    expect(screen.getByText("obj vs trial")).toBeInTheDocument();

    // Switch the active ranking dimension to accel time.
    fireEvent.change(screen.getByLabelText("Rank by"), { target: { value: "accelTime" } });

    // The whole view follows: the convergence chart re-titles to the event.
    expect(screen.getByText("accel (s) vs trial")).toBeInTheDocument();
    expect(screen.queryByText("obj vs trial")).toBeNull();

    // The inspector is dimension-aware: clicking a podium card shows the event
    // label + value, never the (now meaningless) backend "obj" headline.
    fireEvent.click(screen.getAllByText(/trial #\d/)[0]!.closest("button")!);
    const aside = document.querySelector("aside")!;
    expect(within(aside).getByText(/accel \(s\)/)).toBeInTheDocument();
    expect(within(aside).queryByText(/^obj =/)).toBeNull();
  });

  it("shows a best-design-per-objective panel; picking one re-ranks the view", () => {
    render(<OptimizationResults study={eventStudy()} />);
    // The panel lists each objective's winning design.
    expect(screen.getByText("Best design per objective")).toBeInTheDocument();
    // Time metrics always score (no baseline needed); the autocross-best button
    // carries a value + trial number. Clicking it re-ranks the whole view.
    const axBtn = screen.getByRole("button", { name: /autox \(s\)/ });
    fireEvent.click(axBtn);
    expect(screen.getByText("autox (s) vs trial")).toBeInTheDocument();
  });
});

describe("OptimizationResults — cancel", () => {
  it("renders Cancel only while running and calls cancelStudy", () => {
    const study = makeOptimizationStudy({ status: "running" });
    render(<OptimizationResults study={study} />);
    const cancel = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancel);
    expect(cancelStudy).toHaveBeenCalledWith(study.id);
  });

  it("does not render Cancel when the study is done", () => {
    const study = makeOptimizationStudy({ status: "done" });
    render(<OptimizationResults study={study} />);
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });
});

describe("OptimizationResults — knock surfacing", () => {
  it("flags trials whose max KI exceeds 1.0 (table + header count)", () => {
    const study = makeOptimizationStudy({
      trials: [
        makeTrial({
          trialIdx: 0, objectiveValue: 60, status: "done",
          sweepPoints: [
            makeSweepPoint({ rpm: 8000, lastCycle: { knockIntegral: 0.4 } }),
            makeSweepPoint({ rpm: 11000, lastCycle: { knockIntegral: 1.31 } }),
          ],
        }),
        makeTrial({
          trialIdx: 1, objectiveValue: 64, status: "done",
          sweepPoints: [makeSweepPoint({ rpm: 8000, lastCycle: { knockIntegral: 0.62 } })],
        }),
      ],
    });
    render(<OptimizationResults study={study} />);
    // Header count: exactly one knocking trial.
    expect(screen.getByTitle(/knock integral exceeds 1\.0/i).textContent).toContain("1 knock");
    // Table column: the knocking trial shows ⚠ + its max KI; the safe one a plain value.
    const rows = tableRows();
    const flat = rows.map((r) => r.join(" "));
    expect(flat.some((r) => r.includes("⚠ 1.31"))).toBe(true);
    expect(flat.some((r) => r.includes("0.62") && !r.includes("⚠ 0.62"))).toBe(true);
  });
});

// Appended import — top-level statement, hoisted like the ones above.
import { getAutoRefine, setAutoRefine } from "../lib/autoRefine";

describe("OptimizationResults — auto-refine loop", () => {
  afterEach(() => {
    setAutoRefine(null);
    delete (stableCtx as Record<string, unknown>).startOptimization;
  });

  it("advances to the next round when the watched study finishes improved", async () => {
    const startOptimization = vi.fn(async () => "next-job");
    (stableCtx as Record<string, unknown>).startOptimization = startOptimization;
    // Prior best 50 → this study's best 64 (maximize default) = big gain.
    setAutoRefine({ studyId: "opt-1", roundsLeft: 2, round: 1, totalRounds: 3, lastBest: 50 });
    const study = makeOptimizationStudy({ id: "opt-1", status: "done" });
    render(<OptimizationResults study={study} />);
    await waitFor(() => expect(startOptimization).toHaveBeenCalledTimes(1));
    // Narrowed tunables + the loop now waits on the new study.
    const params = (startOptimization.mock.calls[0] as unknown[])[1] as { tunables: unknown[] };
    expect(params.tunables.length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(getAutoRefine()).toMatchObject({ studyId: "next-job", round: 2, roundsLeft: 1, lastBest: 64 }),
    );
  });

  it("stops the loop when the gain is under the 0.5% floor", async () => {
    const startOptimization = vi.fn(async () => "never");
    (stableCtx as Record<string, unknown>).startOptimization = startOptimization;
    setAutoRefine({ studyId: "opt-1", roundsLeft: 2, round: 1, totalRounds: 3, lastBest: 63.9 });
    const study = makeOptimizationStudy({ id: "opt-1", status: "done" }); // best 64 → +0.16%
    render(<OptimizationResults study={study} />);
    await waitFor(() => expect(getAutoRefine()).toBeNull());
    expect(startOptimization).not.toHaveBeenCalled();
  });
});
