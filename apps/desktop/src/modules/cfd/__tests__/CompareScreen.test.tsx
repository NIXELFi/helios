// CompareScreen: pin two seeded sweeps (one sdm26-named, one sdm25-named so
// vehicleForCar gives them different chassis), check the scoreboard renders
// both with a total-points delta, and the gap-attribution table shows the
// morph steps with a telescoping bottom line.

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";

import { CfdProvider, useCfd, type CfdContextValue } from "../state/CfdContext";
import { CompareScreen } from "../screens/CompareScreen";
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
      <CompareScreen />
    </CfdProvider>,
  );
}

async function seedSweep(configPath: string, torques: [number, number][]): Promise<string> {
  let id = "";
  await act(async () => {
    id = await ctx.startSweep(configPath, makeSweepParams({ rpmList: torques.map(([r]) => r) }));
  });
  for (const [rpm, nm] of torques) {
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
      payload: { jobId: id, kind: "sweep", payload: { kind: "sweep", nRpms: torques.length, nCompleted: torques.length, totalStepCount: 1, totalWallTimeS: 1 } },
    });
  });
  return id;
}

async function pinAll() {
  const select = screen.getByLabelText("Pin a design") as HTMLSelectElement;
  while (select.options.length > 1) {
    fireEvent.change(select, { target: { value: select.options[1]!.value } });
    await waitFor(() => {});
  }
}

describe("CompareScreen", () => {
  beforeEach(() => {
    // CfdProvider rehydrates studies from localStorage even with
    // skipRehydrate (that flag only skips listJobs) — clear so studies
    // seeded by one test can't leak into the next.
    localStorage.clear();
  });

  it("shows the empty state with no pins", async () => {
    renderScreen();
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    expect(screen.getByText(/Pin two or more designs/)).toBeInTheDocument();
  });

  it("pins two designs and renders the scoreboard with a Δ on the second", async () => {
    renderScreen();
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSweep("C:/configs/sdm26.json", [[6000, 58], [9000, 62], [12000, 45]]);
    await seedSweep("C:/configs/sdm25.json", [[6000, 60], [9000, 59], [12000, 47]]);
    await pinAll();

    // Both rows present, with chassis identity shown.
    expect(screen.getByText(/SDM26 · 267 kg · FD 3.00/)).toBeInTheDocument();
    expect(screen.getByText(/SDM25 · 281 kg · FD 3.50/)).toBeInTheDocument();
    // Second row carries a signed total-points delta chip (the attribution
    // table below also shows signed deltas, so assert at-least-one).
    expect(screen.getAllByText(/^[+-]\d+\.\d$/).length).toBeGreaterThan(0);
  });

  it("renders the gap attribution morph steps that end at B", async () => {
    renderScreen();
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSweep("C:/configs/sdm26.json", [[6000, 58], [9000, 62], [12000, 45]]);
    await seedSweep("C:/configs/sdm25.json", [[6000, 60], [9000, 59], [12000, 47]]);
    await pinAll();

    expect(screen.getByText("Gap attribution")).toBeInTheDocument();
    for (const step of ["+ engine (torque curve)", "+ mass", "+ gearing", "+ chassis (aero/grip/rest)"]) {
      expect(screen.getByText(step)).toBeInTheDocument();
    }
    expect(screen.getByText(/^B = .+\(total Δ\)$/)).toBeInTheDocument();
  });

  it("unpin removes a row", async () => {
    renderScreen();
    await waitFor(() => expect(ctx.state.hydrated).toBe(true));
    await seedSweep("C:/configs/sdm26.json", [[6000, 58], [9000, 62], [12000, 45]]);
    const select = screen.getByLabelText("Pin a design") as HTMLSelectElement;
    expect(select.options.length).toBe(2); // placeholder + the one sweep
    fireEvent.change(select, { target: { value: select.options[1]!.value } });
    expect(screen.getByText(/SDM26 · 267 kg/)).toBeInTheDocument();
    const unpins = screen.getAllByRole("button", { name: /Unpin/ });
    expect(unpins.length).toBe(1); // exactly one pinned row
    fireEvent.click(unpins[0]!);
    expect(screen.getByText(/Pin two or more designs/)).toBeInTheDocument();
  });
});
