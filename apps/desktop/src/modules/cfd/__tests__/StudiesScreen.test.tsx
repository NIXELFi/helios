// StudiesScreen — Best/Peak summary cells + universal per-row export + the
// header "Export all (JSON)" button. Studies are seeded into context by driving
// the real start functions and emitting the same Tauri events the runner would,
// so the rows reflect genuine reducer state (running studies = partial
// snapshots). The io seam is mocked so no save dialog / disk write runs.

import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

// Mock the single IO seam: capture what gets written, control the returned path.
const saveTextFile = vi.fn(async (_name: string, _ext: string, _contents: string) => "C:/out/cfd-export.json");
vi.mock("../lib/export/io", () => ({
  saveTextFile: (...a: unknown[]) => saveTextFile(...(a as [string, string, string])),
  fileTimestamp: () => "20260605-134501",
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
}));

import { CfdProvider, useCfd, type CfdContextValue } from "../state/CfdContext";
import { StudiesScreen } from "../screens/StudiesScreen";
import { makeFakeBridge } from "./fakes/tauri";
import { makeCycleStats, makeParams, makeSweepParams, makeOptimizationParams } from "./fakes/study";
import type { SweepPoint } from "../state/types";

// A child that hands the live context out to the test so it can start studies
// and emit events from inside act().
let ctx: CfdContextValue;
function Capture() {
  ctx = useCfd();
  return null;
}

function point(rpm: number, brakePowerKW: number): Omit<SweepPoint, "cycles" | "captureDir"> {
  return {
    rpm,
    convergedCycle: 12,
    nCyclesRun: 15,
    lastCycle: makeCycleStats({ brakePowerKW }),
    nonconservationMax: 1e-6,
    wallTimeS: 4.2,
    stepCount: 1000,
  };
}

function renderScreen() {
  const fake = makeFakeBridge();
  let n = 0;
  fake.setStartJob(async () => ({ jobId: `j-${++n}` }));
  fake.setGetParameterSchema(async () => []);
  const ui = (
    <CfdProvider bridge={fake.bridge} skipRehydrate>
      <Capture />
      <StudiesScreen />
    </CfdProvider>
  );
  return { fake, ui };
}

// ---- Seeders. Each returns the seeded study's jobId. -----------------------

async function seedSingleRpm(opts: { imepBar?: number; done?: boolean } = {}): Promise<string> {
  let id = "";
  await act(async () => {
    id = await ctx.startSingleRpm("C:/configs/sdm26.json", makeParams({ nCyclesMax: 3 }));
  });
  if (opts.imepBar !== undefined) {
    act(() => {
      ctx.__dispatchTestEvent!({
        name: "cfd:job-progress",
        payload: {
          jobId: id, kind: "single-rpm",
          payload: { kind: "single-rpm", cycle: 1, total: 3, cycleStats: makeCycleStats({ cycle: 1, imepBar: opts.imepBar! }) },
        },
      });
    });
  }
  if (opts.done) {
    act(() => {
      ctx.__dispatchTestEvent!({
        name: "cfd:job-done",
        payload: { jobId: id, kind: "single-rpm", payload: { kind: "single-rpm", convergedCycle: 1, nCyclesRun: 1, stepCount: 100 } },
      });
    });
  }
  return id;
}

async function seedSweep(opts: { points?: [number, number][]; done?: boolean } = {}): Promise<string> {
  let id = "";
  await act(async () => {
    id = await ctx.startSweep("C:/configs/sdm26.json", makeSweepParams({ rpmList: [8000, 10000, 12000] }));
  });
  for (const [rpm, kw] of opts.points ?? []) {
    act(() => {
      ctx.__dispatchTestEvent!({
        name: "cfd:job-progress",
        payload: {
          jobId: id, kind: "sweep",
          payload: { kind: "sweep-rpm-done", rpmIdx: rpm, rpm, point: point(rpm, kw) },
        },
      });
    });
  }
  if (opts.done) {
    act(() => {
      ctx.__dispatchTestEvent!({
        name: "cfd:job-done",
        payload: { jobId: id, kind: "sweep", payload: { kind: "sweep", nRpms: 3, nCompleted: 3, totalStepCount: 1, totalWallTimeS: 1 } },
      });
    });
  }
  return id;
}

async function seedOptimization(opts: { trials?: [number, number][]; done?: boolean } = {}): Promise<string> {
  let id = "";
  await act(async () => {
    id = await ctx.startOptimization("C:/configs/sdm26.json", makeOptimizationParams({ nTrials: 5 }));
  });
  for (const [trialIdx, obj] of opts.trials ?? []) {
    act(() => {
      ctx.__dispatchTestEvent!({
        name: "cfd:job-progress",
        payload: {
          jobId: id, kind: "optimization",
          payload: {
            kind: "optimization-trial-done", trialIdx, nTrials: 5,
            objectiveValue: obj, sweepPoints: [], wallTimeS: 4.0,
          },
        },
      });
    });
  }
  if (opts.done) {
    act(() => {
      ctx.__dispatchTestEvent!({
        name: "cfd:job-done",
        payload: {
          jobId: id, kind: "optimization",
          payload: {
            kind: "optimization", nTrialsRequested: 5, nTrialsRun: (opts.trials ?? []).length,
            bestTrialIdx: 0, bestObjectiveValue: 0, parameterPaths: ["runner_length", "plenum_volume_l"],
            objectiveDirection: "maximize", totalWallTimeS: 1,
          },
        },
      });
    });
  }
  return id;
}

beforeEach(() => {
  saveTextFile.mockClear();
  window.localStorage.clear();
});

describe("StudiesScreen — Best/Peak cell", () => {
  it("single-rpm shows IMEP of the last cycle, em-dash with 0 cycles", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));

    await seedSingleRpm({ imepBar: 11.92, done: true });
    expect(screen.getByText("IMEP 11.92")).toBeInTheDocument();

    // A second single-rpm study with no cycles → em-dash.
    await seedSingleRpm({ done: false });
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("sweep shows ~peak kW @ rpm (interpolated, rounded), em-dash with <1 point", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));

    // Interior peak at 10000 (64 kW); parabola through 50/64/58 lands near 10k.
    await seedSweep({ points: [[8000, 50], [10000, 64], [12000, 58]], done: true });
    const cell = screen.getByText(/^~64\.0 kW @ \d+$/);
    expect(cell).toBeInTheDocument();

    // No-point sweep → em-dash.
    await seedSweep({ done: false });
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("optimization shows best objective toPrecision(4) with (#idx), live + em-dash with 0 done", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));

    // Running study with two done trials (mid-run partial). Best (maximize) = 64 at trial 1.
    await seedOptimization({ trials: [[0, 55], [1, 64]], done: false });
    expect(screen.getByText("best 64.00 (#1)")).toBeInTheDocument();

    // A second optimization with no done trials → em-dash.
    await seedOptimization({ done: false });
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });
});

describe("StudiesScreen — Export all (JSON)", () => {
  it("is disabled with no studies and enabled once a study exists", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));

    const btn = () => screen.getByRole("button", { name: /^Export all \(JSON\)/i });
    expect(btn()).toBeDisabled();

    await seedSingleRpm({ imepBar: 10, done: true });
    expect(btn()).not.toBeDisabled();
  });

  it("writes a workspace bundle and toasts on success", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSingleRpm({ imepBar: 10, done: true });

    fireEvent.click(screen.getByRole("button", { name: /^Export all \(JSON\)/i }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(1));
    // Workspace stem + json ext.
    expect(saveTextFile.mock.calls[0]![0]).toMatch(/^cfd-workspace-/);
    expect(saveTextFile.mock.calls[0]![1]).toBe("json");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Exported → cfd-export.json"));
  });
});

describe("StudiesScreen — per-row export", () => {
  it("renders an Export menu for a done study and runs the Study JSON action", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSingleRpm({ imepBar: 10, done: true });

    const exportBtns = screen.getAllByRole("button", { name: /^Export ▾$/ });
    expect(exportBtns).toHaveLength(1);
    fireEvent.click(exportBtns[0]!);

    const menu = screen.getByRole("menu");
    const jsonItem = within(menu).getByRole("menuitem", { name: "Study JSON" });
    fireEvent.click(jsonItem);
    await waitFor(() => expect(saveTextFile).toHaveBeenCalled());
  });

  it("renders an Export menu for a RUNNING study (partial snapshot)", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    // Running study (no done event), with one done trial → exportable snapshot.
    await seedOptimization({ trials: [[0, 60]], done: false });

    const exportBtns = screen.getAllByRole("button", { name: /^Export ▾$/ });
    expect(exportBtns).toHaveLength(1);
    fireEvent.click(exportBtns[0]!);
    // Optimization exposes a Trials CSV action.
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Trials CSV" })).toBeInTheDocument();
  });

  it("a cancelled save (null path) toasts 'Cancelled' rather than an empty toast", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSingleRpm({ imepBar: 10, done: true });

    saveTextFile.mockResolvedValueOnce(null as unknown as string);
    fireEvent.click(screen.getByRole("button", { name: /^Export ▾$/ }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Study JSON" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Cancelled"));
  });
});

describe("StudiesScreen — sortable headers", () => {
  it("clicking a header shows the active caret and persists the pref to localStorage", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSingleRpm({ imepBar: 10, done: true });

    // Click the Name column header → ascending by default (DEFAULT_DIR.name).
    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));

    // Active caret rendered on the Name header.
    const nameHeader = screen.getByRole("button", { name: /^Name/ });
    expect(nameHeader).toHaveTextContent("▲");
    // aria-sort on the owning <th> reflects the direction.
    expect(nameHeader.closest("th")).toHaveAttribute("aria-sort", "ascending");
    // Preference persisted.
    expect(window.localStorage.getItem("helios:cfd:studiesSort")).toBe("name:asc");

    // Clicking again toggles to descending.
    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));
    expect(screen.getByRole("button", { name: /^Name/ })).toHaveTextContent("▼");
    expect(window.localStorage.getItem("helios:cfd:studiesSort")).toBe("name:desc");
  });

  it("reorders the data rows when sorting by Name ascending then descending", async () => {
    const { ui } = renderScreen();
    render(ui);
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));

    // Two studies with KNOWN distinct names (the config basename is shared, so
    // give them custom names to make the Name ordering deterministic).
    const idA = await seedSingleRpm({ imepBar: 10, done: true });
    const idZ = await seedSingleRpm({ imepBar: 11, done: true });
    act(() => {
      ctx.renameStudy(idA, "Alpha");
      ctx.renameStudy(idZ, "Zeta");
    });

    // The first DATA row's name cell — getAllByRole("row") includes the thead
    // row, so skip it (rows.slice(1)).
    const firstDataName = () => {
      const rows = screen.getAllByRole("row");
      return within(rows[1]!).getByRole("button", { name: /^Rename / }).textContent ?? "";
    };

    // Ascending: Alpha sorts before Zeta → first data row is Alpha.
    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));
    expect(firstDataName()).toContain("Alpha");

    // Descending toggle: order flips → first data row is now Zeta.
    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));
    expect(firstDataName()).toContain("Zeta");
  });
});
