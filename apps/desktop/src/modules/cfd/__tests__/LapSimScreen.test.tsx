// LapSimScreen smoke + behavior: seeds a completed sweep through the real
// provider/reducer (same pattern as StudiesScreen.test), then checks the lap
// runs, the headline stats render, the limit-state bar shows the engine share,
// the channel selector drives the map, and Export CSV writes a channel CSV.

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const saveTextFile = vi.fn(async (_n: string, _e: string, _c: string) => "C:/out/lap.csv");
vi.mock("../lib/export/io", () => ({
  saveTextFile: (...a: unknown[]) => saveTextFile(...(a as [string, string, string])),
  fileTimestamp: () => "20260609-120000",
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
}));

import { CfdProvider, useCfd, type CfdContextValue } from "../state/CfdContext";
import { LapSimScreen } from "../screens/LapSimScreen";
import { makeFakeBridge } from "./fakes/tauri";
import { makeCycleStats, makeSweepParams } from "./fakes/study";
import type { SweepPoint } from "../state/types";

let ctx: CfdContextValue;
function Capture() {
  ctx = useCfd();
  return null;
}

function point(rpm: number, brakeTorqueNm: number): Omit<SweepPoint, "cycles" | "captureDir"> {
  return {
    rpm,
    convergedCycle: 12,
    nCyclesRun: 15,
    lastCycle: makeCycleStats({ brakeTorqueNm }),
    nonconservationMax: 1e-6,
    wallTimeS: 4.2,
    stepCount: 1000,
  };
}

function renderScreen() {
  const fake = makeFakeBridge();
  let n = 0;
  fake.setStartJob(async () => ({ jobId: `j-${++n}` }));
  return render(
    <CfdProvider bridge={fake.bridge} skipRehydrate>
      <Capture />
      <LapSimScreen />
    </CfdProvider>,
  );
}

/** Seed one completed sweep (a usable torque curve) through the reducer. */
async function seedSweep(configPath = "C:/configs/sdm26.json"): Promise<string> {
  let id = "";
  await act(async () => {
    id = await ctx.startSweep(configPath, makeSweepParams({ rpmList: [6000, 9000, 12000] }));
  });
  for (const [rpm, nm] of [[6000, 58], [9000, 62], [12000, 45]] as const) {
    act(() => {
      ctx.__dispatchTestEvent!({
        name: "cfd:job-progress",
        payload: { jobId: id, kind: "sweep", payload: { kind: "sweep-rpm-done", rpmIdx: rpm, rpm, point: point(rpm, nm) } },
      });
    });
  }
  act(() => {
    ctx.__dispatchTestEvent!({
      name: "cfd:job-done",
      payload: { jobId: id, kind: "sweep", payload: { kind: "sweep", nRpms: 3, nCompleted: 3, totalStepCount: 1, totalWallTimeS: 1 } },
    });
  });
  return id;
}

beforeEach(() => {
  saveTextFile.mockClear();
});

describe("LapSimScreen", () => {
  it("shows the empty state without a torque curve", async () => {
    renderScreen();
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    expect(screen.getByText(/No torque curve available/)).toBeInTheDocument();
  });

  it("runs the lap and renders headline stats + limit-state bar", async () => {
    renderScreen();
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSweep();

    // Headline: a lap time and the power-limited share render.
    expect(await screen.findByText(/^\d+\.\d{2} s$/)).toBeInTheDocument();
    expect(screen.getByText("power-limited")).toBeInTheDocument();
    // Limit bar exists with the engine-share legend.
    expect(screen.getByText(/gold = engine-bound/i)).toBeInTheDocument();
    // Both events offered; autocross is the default.
    expect(screen.getByRole("button", { name: "Autocross" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Endurance" })).toBeInTheDocument();
  });

  it("switching to endurance re-runs on the endurance track (map label updates)", async () => {
    renderScreen();
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSweep();

    fireEvent.click(screen.getByRole("button", { name: "Endurance" }));
    expect(await screen.findByText(/Track map — Endurance/)).toBeInTheDocument();
  });

  it("limit-state channel swaps the gradient legend for categorical chips", async () => {
    renderScreen();
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSweep();

    fireEvent.change(screen.getByLabelText("Map channel"), { target: { value: "limit" } });
    // Categorical legend chips (the map legend, beside the limit bar legend).
    expect((await screen.findAllByText("corner")).length).toBeGreaterThan(0);
  });

  it("Export CSV writes a channel CSV via the io seam", async () => {
    renderScreen();
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSweep();

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(1));
    const [stem, ext, contents] = saveTextFile.mock.calls[0]!;
    expect(stem).toMatch(/^cfd-lapsim-autocross-/);
    expect(ext).toBe("csv");
    expect(contents).toContain("dist_m,time_s,speed_kph,rpm,gear,lat_g,long_g,limit_state,fuel_cum_g");
    expect(contents).toContain("# Helios CFD lap-sim channel export");
  });
});
