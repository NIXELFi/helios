import { describe, it, expect } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { CfdProvider, useCfd } from "../state/CfdContext";
import { makeFakeBridge } from "./fakes/tauri";
import { makeCycleStats, makeParams } from "./fakes/study";

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
          payload: { cycle: 1, total: 3, cycleStats: makeCycleStats({ cycle: 1, imepBar: 9.5 }) },
        },
      });
      fake.emit({
        name: "cfd:job-progress",
        payload: {
          jobId: "j-2",
          kind: "single-rpm",
          payload: { cycle: 2, total: 3, cycleStats: makeCycleStats({ cycle: 2, imepBar: 10.1 }) },
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
          payload: { convergedCycle: -1, nCyclesRun: 2, stepCount: 1234 },
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
        payload: { jobId: "j-3", partialCycles: [] },
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
          reason: "solver-diverged",
          message: "non-finite cycle stats at cycle 2",
          partialCycles: [
            makeCycleStats({ cycle: 1, imepBar: 9.9 }),
            makeCycleStats({ cycle: 2, imepBar: NaN }),
          ],
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
