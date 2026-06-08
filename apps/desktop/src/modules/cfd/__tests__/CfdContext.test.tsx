import { describe, it, expect } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { CfdProvider, useCfd, reducer, initialState } from "../state/CfdContext";
import type { OptimizationParams, OptimizationStudy } from "../state/types";
import { makeFakeBridge } from "./fakes/tauri";
import { makeCycleStats, makeParams, makeOptimizationParams } from "./fakes/study";

function wrap(bridge = makeFakeBridge().bridge) {
  return ({ children }: { children: ReactNode }) => (
    <CfdProvider bridge={bridge} skipRehydrate>{children}</CfdProvider>
  );
}

describe("CfdContext state machine", () => {
  it("hydrates on mount with empty state when localStorage is fresh", async () => {
    window.localStorage.clear();
    const { result } = renderHook(() => useCfd(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.state.hydrated).toBe(true));
    expect(result.current.state.studies).toEqual({});
    expect(result.current.state.loadedConfig).toBeNull();
  });

  it("startSingleRpm adds a running study and navigates to results", async () => {
    window.localStorage.clear();
    const fake = makeFakeBridge();
    fake.setStartJob(async () => ({ jobId: "j-1" }));

    const { result } = renderHook(() => useCfd(), { wrapper: wrap(fake.bridge) });
    await waitFor(() => expect(result.current.state.hydrated).toBe(true));

    await act(async () => {
      await result.current.startSingleRpm("C:/x/sdm26.json", makeParams());
    });

    expect(result.current.state.studies["j-1"]).toBeDefined();
    expect(result.current.state.studies["j-1"]?.status).toBe("running");
    expect(result.current.state.activeStudyId).toBe("j-1");
    expect(result.current.state.activeScreen).toBe("results");
    expect(fake.invocations.some((i) => i.command === "cfd_start_job")).toBe(true);
  });

  it("startOptimization strips rankBy before the backend but keeps it on the study", async () => {
    window.localStorage.clear();
    const fake = makeFakeBridge();
    fake.setStartJob(async () => ({ jobId: "opt-rb" }));

    const { result } = renderHook(() => useCfd(), { wrapper: wrap(fake.bridge) });
    await waitFor(() => expect(result.current.state.hydrated).toBe(true));

    await act(async () => {
      await result.current.startOptimization(
        "C:/x/sdm26.json",
        makeOptimizationParams({ rankBy: "accelTime" }),
      );
    });

    // The sampler runs server-side and can't compute FSAE event metrics, so
    // rankBy must not reach the backend.
    const startJob = fake.invocations.find((i) => i.command === "cfd_start_job");
    const sentParams = (startJob?.args.request as { params?: { rankBy?: unknown } })?.params;
    expect(sentParams).toBeDefined();
    expect(sentParams && "rankBy" in sentParams).toBe(false);

    // ...but the study keeps it so the results screen defaults its "rank by" control.
    const study = result.current.state.studies["opt-rb"];
    expect(study?.kind).toBe("optimization");
    if (study?.kind === "optimization") {
      expect(study.params.rankBy).toBe("accelTime");
    }
  });

  it("progress events append cycles, done event flips status", async () => {
    window.localStorage.clear();
    const fake = makeFakeBridge();
    fake.setStartJob(async () => ({ jobId: "j-2" }));

    const { result } = renderHook(() => useCfd(), { wrapper: wrap(fake.bridge) });
    await waitFor(() => expect(result.current.state.hydrated).toBe(true));

    await act(async () => {
      await result.current.startSingleRpm("C:/x.json", makeParams({ nCyclesMax: 3 }));
    });

    act(() => {
      fake.emit({
        name: "cfd:job-progress",
        payload: {
          jobId: "j-2",
          kind: "single-rpm",
          payload: { kind: "single-rpm", cycle: 1, total: 3, cycleStats: makeCycleStats({ cycle: 1, imepBar: 9.5 }) },
        },
      });
      fake.emit({
        name: "cfd:job-progress",
        payload: {
          jobId: "j-2",
          kind: "single-rpm",
          payload: { kind: "single-rpm", cycle: 2, total: 3, cycleStats: makeCycleStats({ cycle: 2, imepBar: 10.1 }) },
        },
      });
    });

    let study = result.current.state.studies["j-2"];
    expect(study?.kind).toBe("single-rpm");
    if (study?.kind === "single-rpm") {
      expect(study.cycles).toHaveLength(2);
      expect(study.cycles[0]?.imepBar).toBe(9.5);
    }

    act(() => {
      fake.emit({
        name: "cfd:job-done",
        payload: {
          jobId: "j-2",
          kind: "single-rpm",
          payload: { kind: "single-rpm", convergedCycle: -1, nCyclesRun: 2, stepCount: 1234 },
        },
      });
    });

    study = result.current.state.studies["j-2"];
    expect(study?.status).toBe("done");
    expect(study?.finishedAt).toBeDefined();
  });

  it("cancelStudy sets cancelling then cancelled event flips to cancelled", async () => {
    window.localStorage.clear();
    const fake = makeFakeBridge();
    fake.setStartJob(async () => ({ jobId: "j-3" }));

    const { result } = renderHook(() => useCfd(), { wrapper: wrap(fake.bridge) });
    await waitFor(() => expect(result.current.state.hydrated).toBe(true));
    await act(async () => {
      await result.current.startSingleRpm("C:/x.json", makeParams());
    });

    await act(async () => {
      await result.current.cancelStudy("j-3");
    });
    expect(result.current.state.studies["j-3"]?.status).toBe("cancelling");

    act(() => {
      fake.emit({
        name: "cfd:job-cancelled",
        payload: { jobId: "j-3", kind: "single-rpm", partialCycles: [], partialPoints: [] },
      });
    });
    expect(result.current.state.studies["j-3"]?.status).toBe("cancelled");
    expect(fake.invocations.some((i) => i.command === "cfd_cancel_job")).toBe(true);
  });

  it("error event populates error fields and merges partial cycles", async () => {
    window.localStorage.clear();
    const fake = makeFakeBridge();
    fake.setStartJob(async () => ({ jobId: "j-4" }));

    const { result } = renderHook(() => useCfd(), { wrapper: wrap(fake.bridge) });
    await waitFor(() => expect(result.current.state.hydrated).toBe(true));
    await act(async () => {
      await result.current.startSingleRpm("C:/x.json", makeParams({ nCyclesMax: 5 }));
    });

    // No progress emitted yet — error payload carries the partial cycles.
    act(() => {
      fake.emit({
        name: "cfd:job-error",
        payload: {
          jobId: "j-4",
          kind: "single-rpm",
          reason: "solver-diverged",
          message: "non-finite cycle stats at cycle 2",
          partialCycles: [
            makeCycleStats({ cycle: 1, imepBar: 9.9 }),
            makeCycleStats({ cycle: 2, imepBar: NaN }),
          ],
          partialPoints: [],
        },
      });
    });

    const s = result.current.state.studies["j-4"];
    expect(s?.status).toBe("error");
    expect(s?.errorReason).toBe("solver-diverged");
    expect(s?.error).toContain("non-finite");
    if (s?.kind === "single-rpm") {
      expect(s.cycles).toHaveLength(2);
    }
  });
});

describe("optimization reducer", () => {
  const baseParams: OptimizationParams = {
    tunables: [
      { path: "restrictor_cd", min: 0.7, max: 0.99, step: null },
      { path: "plenum_volume", min: 0.0005, max: 0.005, step: null },
    ],
    objective: {
      metric: "imep_bar",
      aggregator: { kind: "max" },
      rpmList: [6000, 8000, 10000],
      direction: "maximize",
    },
    nTrials: 2,
    sampler: "lhs",
    seed: 42,
    nCyclesMax: 4,
    junctionKind: "characteristic",
    convergenceTolImep: 5e-3,
    convergenceMinCycles: 3,
    lockedPairs: [],
  };

  const baseStudy = (overrides: Partial<OptimizationStudy> = {}): OptimizationStudy => ({
    id: "opt-1",
    kind: "optimization",
    status: "running",
    configPath: "/x.json",
    startedAt: 1_700_000_000_000,
    params: baseParams,
    trials: [
      { trialIdx: 0, parameterValues: {}, status: "pending", objectiveValue: null, sweepPoints: null, wallTimeS: null },
      { trialIdx: 1, parameterValues: {}, status: "pending", objectiveValue: null, sweepPoints: null, wallTimeS: null },
    ],
    bestTrialIdx: null,
    bestObjectiveValue: null,
    parameterPaths: ["restrictor_cd", "plenum_volume"],
    objectiveDirection: "maximize",
    ...overrides,
  });

  it("addStudy puts an optimization study in the registry and activates it", () => {
    const s = reducer(initialState, { type: "addStudy", study: baseStudy() });
    expect(s.studies["opt-1"]).toBeDefined();
    expect(s.studies["opt-1"]?.kind).toBe("optimization");
    expect(s.activeStudyId).toBe("opt-1");
  });

  it("optimizationTrialStarted transitions pending -> running with parameterValues", () => {
    const s0 = reducer(initialState, { type: "addStudy", study: baseStudy() });
    const s1 = reducer(s0, {
      type: "optimizationTrialStarted",
      id: "opt-1",
      trialIdx: 1,
      parameterValues: { restrictor_cd: 0.88, plenum_volume: 0.0015 },
    });
    const study = s1.studies["opt-1"];
    expect(study?.kind).toBe("optimization");
    if (study?.kind === "optimization") {
      expect(study.trials[1]?.status).toBe("running");
      expect(study.trials[1]?.parameterValues.restrictor_cd).toBe(0.88);
      // Other trial untouched.
      expect(study.trials[0]?.status).toBe("pending");
    }
  });

  it("optimizationTrialDone populates objective and sweep points", () => {
    const s0 = reducer(initialState, { type: "addStudy", study: baseStudy() });
    const s1 = reducer(s0, {
      type: "optimizationTrialDone",
      id: "opt-1",
      trialIdx: 0,
      objectiveValue: 9.4,
      sweepPoints: [
        {
          rpm: 6000,
          convergedCycle: 3,
          nCyclesRun: 4,
          lastCycle: makeCycleStats({ imepBar: 9.4 }),
          nonconservationMax: 0,
          wallTimeS: 0.5,
          stepCount: 1000,
        },
      ],
      wallTimeS: 1.23,
    });
    const study = s1.studies["opt-1"];
    expect(study?.kind).toBe("optimization");
    if (study?.kind === "optimization") {
      expect(study.trials[0]?.status).toBe("done");
      expect(study.trials[0]?.objectiveValue).toBe(9.4);
      expect(study.trials[0]?.sweepPoints).toHaveLength(1);
      expect(study.trials[0]?.sweepPoints?.[0]?.cycles).toEqual([]);
    }
  });

  it("optimizationFinished sets bestTrialIdx, status, and finishedAt", () => {
    const s0 = reducer(initialState, { type: "addStudy", study: baseStudy() });
    const s1 = reducer(s0, {
      type: "optimizationFinished",
      id: "opt-1",
      bestTrialIdx: 1,
      bestObjectiveValue: 9.7,
      status: "done",
      finishedAt: 1_700_000_060_000,
    });
    const study = s1.studies["opt-1"];
    expect(study?.status).toBe("done");
    if (study?.kind === "optimization") {
      expect(study.bestTrialIdx).toBe(1);
      expect(study.bestObjectiveValue).toBe(9.7);
      expect(study.finishedAt).toBe(1_700_000_060_000);
    }
  });
});
