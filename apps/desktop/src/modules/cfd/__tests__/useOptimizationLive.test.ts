// Unit tests for the live optimization view-model hook. We exercise the pure
// memo (rankings, podium, history, ETA gating) and the gated elapsed clock.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useOptimizationLive, useElapsedSeconds } from "../state/useOptimizationLive";
import { makeOptimizationStudy, makeTrial } from "./fakes/study";

describe("useOptimizationLive", () => {
  it("ranks done+finite trials best-first; rank 1 is the backend best after done", () => {
    const study = makeOptimizationStudy();
    const { result } = renderHook(() => useOptimizationLive(study));

    // Trials: idx0=55, idx1=64, idx2=60, maximize → 64,60,55.
    expect(result.current.ranked.map((r) => r.trial.trialIdx)).toEqual([1, 2, 0]);
    expect(result.current.ranked[0]?.rank).toBe(1);
    // Backend best is trialIdx 1 — rank 1 agrees.
    expect(result.current.ranked[0]?.trial.trialIdx).toBe(study.bestTrialIdx);
    expect(result.current.nDone).toBe(3);
    expect(result.current.rankByIdx.get(1)).toBe(1);
    expect(result.current.rankByIdx.get(2)).toBe(2);
    expect(result.current.rankByIdx.get(0)).toBe(3);
  });

  it("podium fills in rank order and caps at 3", () => {
    const study = makeOptimizationStudy({
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 10 }),
        makeTrial({ trialIdx: 1, objectiveValue: 40 }),
        makeTrial({ trialIdx: 2, objectiveValue: 30 }),
        makeTrial({ trialIdx: 3, objectiveValue: 20 }),
      ],
    });
    const { result } = renderHook(() => useOptimizationLive(study));
    expect(result.current.top3.map((r) => r.trial.objectiveValue)).toEqual([40, 30, 20]);
    expect(result.current.top3).toHaveLength(3);
  });

  it("excludes pending / running / error / non-finite trials from rank", () => {
    const study = makeOptimizationStudy({
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50 }),
        makeTrial({ trialIdx: 1, status: "running", objectiveValue: null }),
        makeTrial({ trialIdx: 2, status: "pending", objectiveValue: null }),
        makeTrial({ trialIdx: 3, status: "error", objectiveValue: null }),
        makeTrial({ trialIdx: 4, objectiveValue: Number.NaN }),
      ],
    });
    const { result } = renderHook(() => useOptimizationLive(study));
    expect(result.current.nDone).toBe(1);
    expect(result.current.ranked.map((r) => r.trial.trialIdx)).toEqual([0]);
    expect(result.current.running.map((t) => t.trialIdx)).toEqual([1]);
  });

  it("rankings are stable (no reorder) across an incremental trial-done update", () => {
    const base = makeOptimizationStudy({
      status: "running",
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50 }),
        makeTrial({ trialIdx: 1, objectiveValue: 70 }),
        makeTrial({ trialIdx: 2, status: "pending", objectiveValue: null }),
      ],
    });
    const { result, rerender } = renderHook(
      ({ study }) => useOptimizationLive(study),
      { initialProps: { study: base } },
    );
    const before = result.current.ranked.map((r) => r.trial.trialIdx);
    expect(before).toEqual([1, 0]);

    // New event lands trial 2 with a middling objective — a NEW trials array
    // (reducer returns new arrays). Existing relative order must hold.
    const next = {
      ...base,
      trials: [
        base.trials[0]!,
        base.trials[1]!,
        makeTrial({ trialIdx: 2, objectiveValue: 60 }),
      ],
    };
    rerender({ study: next });
    expect(result.current.ranked.map((r) => r.trial.trialIdx)).toEqual([1, 2, 0]);
    // 1 and 0 keep their relative order; 2 slots in between.
    expect(result.current.rankByIdx.get(1)).toBe(1);
    expect(result.current.rankByIdx.get(0)).toBe(3);
  });

  it("history (running-best curve) is monotone over done trials", () => {
    const study = makeOptimizationStudy({
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50 }),
        makeTrial({ trialIdx: 1, objectiveValue: 40 }),
        makeTrial({ trialIdx: 2, objectiveValue: 70 }),
      ],
    });
    const { result } = renderHook(() => useOptimizationLive(study));
    expect(result.current.history.map((h) => h.bestSoFar)).toEqual([50, 50, 70]);
    expect(result.current.history.map((h) => h.trialIdx)).toEqual([0, 1, 2]);
  });

  it("eta is null with <3 done trials carrying wall time", () => {
    const study = makeOptimizationStudy({
      params: { ...makeOptimizationStudy().params, nTrials: 10 },
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50, wallTimeS: 4 }),
        makeTrial({ trialIdx: 1, objectiveValue: 60, wallTimeS: 4 }),
      ],
    });
    const { result } = renderHook(() => useOptimizationLive(study));
    expect(result.current.eta).toBeNull();
  });

  it("eta = mean(wall) × remaining once ≥3 done trials carry wall time", () => {
    const study = makeOptimizationStudy({
      params: { ...makeOptimizationStudy().params, nTrials: 10 },
      trials: [
        makeTrial({ trialIdx: 0, objectiveValue: 50, wallTimeS: 2 }),
        makeTrial({ trialIdx: 1, objectiveValue: 60, wallTimeS: 4 }),
        makeTrial({ trialIdx: 2, objectiveValue: 55, wallTimeS: 6 }),
      ],
    });
    const { result } = renderHook(() => useOptimizationLive(study));
    // mean = 4, remaining = 10 - 3 = 7 → 28.
    expect(result.current.eta).toBe(28);
  });
});

describe("useElapsedSeconds", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns finishedAt − startedAt for a finished study (no ticking)", () => {
    const study = makeOptimizationStudy({
      status: "done",
      startedAt: 1_000_000,
      finishedAt: 1_000_000 + 42_000,
    });
    const { result } = renderHook(() => useElapsedSeconds(study));
    expect(result.current).toBe(42);
  });

  it("ticks while running and stops after unmount (interval cleaned up)", () => {
    const start = Date.now();
    const study = makeOptimizationStudy({
      status: "running",
      startedAt: start,
      finishedAt: undefined,
    });
    const { result, unmount } = renderHook(() => useElapsedSeconds(study));
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBeGreaterThanOrEqual(first);
    expect(result.current).toBeGreaterThanOrEqual(2.9);
    // After unmount, advancing timers must not throw (interval cleared).
    unmount();
    expect(() => act(() => vi.advanceTimersByTime(5000))).not.toThrow();
  });
});
