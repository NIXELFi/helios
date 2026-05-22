// CFD module's React context. Holds loadedConfig, studies map,
// activeStudyId, activeScreen. Reducer-based so state transitions are
// testable in isolation. Subscribes to Tauri events at mount.

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { loadPersisted, savePersisted } from "../lib/cfdStorage";
import { type CfdBridge, realBridge } from "../lib/tauriBridge";
import type {
  CycleStats,
  JobEvent,
  JobProgressPayload,
  LoadedConfig,
  NavId,
  OptimizationDoneSummary,
  OptimizationParams,
  OptimizationStudy,
  OptimizationTrial,
  SingleRpmParams,
  SingleRpmStudy,
  Study,
  StudyStatus,
  SweepParams,
  SweepPoint,
  SweepStudy,
} from "./types";

export interface State {
  loadedConfig: LoadedConfig | null;
  studies: Record<string, Study>;
  activeStudyId: string | null;
  activeScreen: NavId;
  hydrated: boolean;
}

export const initialState: State = {
  loadedConfig: null,
  studies: {},
  activeStudyId: null,
  activeScreen: "config",
  hydrated: false,
};

export type Action =
  | { type: "setLoadedConfig"; cfg: LoadedConfig | null }
  | { type: "setActiveScreen"; screen: NavId }
  | { type: "setActiveStudy"; id: string | null }
  | { type: "addStudy"; study: Study }
  | { type: "updateStudy"; id: string; patch: Partial<Study> }
  | { type: "appendCycle"; id: string; cycle: CycleStats; total: number }
  | { type: "sweepRpmStarted"; id: string; rpmIdx: number; rpm: number }
  | { type: "sweepCycle"; id: string; rpmIdx: number; rpm: number; cycleStats: CycleStats }
  | { type: "sweepRpmDone"; id: string; point: Omit<SweepPoint, "cycles" | "captureDir">; captureDir?: string }
  | { type: "setSweepCompare"; id: string; compareWithStudyId?: string }
  | { type: "deleteStudy"; id: string }
  | { type: "rehydrate"; studies: Study[]; lastConfigPath: string | null }
  // Optimization (Phase 5):
  | {
      type: "optimizationTrialStarted";
      id: string;
      trialIdx: number;
      parameterValues: Record<string, number>;
    }
  | {
      type: "optimizationTrialDone";
      id: string;
      trialIdx: number;
      objectiveValue: number;
      sweepPoints: Omit<SweepPoint, "cycles" | "captureDir">[];
      wallTimeS: number;
    }
  | {
      type: "optimizationFinished";
      id: string;
      bestTrialIdx: number | null;
      bestObjectiveValue: number | null;
      status: StudyStatus;
      finishedAt: number;
      summary?: OptimizationDoneSummary;
      error?: string;
    };

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "setLoadedConfig":
      return { ...s, loadedConfig: a.cfg };
    case "setActiveScreen":
      return { ...s, activeScreen: a.screen };
    case "setActiveStudy":
      return { ...s, activeStudyId: a.id };
    case "addStudy":
      return {
        ...s,
        studies: { ...s.studies, [a.study.id]: a.study },
        activeStudyId: a.study.id,
      };
    case "updateStudy": {
      const existing = s.studies[a.id];
      if (!existing) return s;
      return {
        ...s,
        studies: { ...s.studies, [a.id]: { ...existing, ...a.patch } as Study },
      };
    }
    case "appendCycle": {
      const existing = s.studies[a.id];
      if (!existing || existing.kind !== "single-rpm") return s;
      return {
        ...s,
        studies: {
          ...s.studies,
          [a.id]: { ...existing, cycles: [...existing.cycles, a.cycle] },
        },
      };
    }
    case "sweepRpmStarted": {
      const existing = s.studies[a.id];
      if (!existing || existing.kind !== "sweep") return s;
      const inFlight = { ...(existing.inFlight ?? {}) };
      inFlight[String(a.rpmIdx)] = { idx: a.rpmIdx, rpm: a.rpm, cycles: [] };
      return {
        ...s,
        studies: { ...s.studies, [a.id]: { ...existing, inFlight } },
      };
    }
    case "sweepCycle": {
      const existing = s.studies[a.id];
      if (!existing || existing.kind !== "sweep") return s;
      const key = String(a.rpmIdx);
      const inFlight = { ...(existing.inFlight ?? {}) };
      const slot = inFlight[key] ?? { idx: a.rpmIdx, rpm: a.rpm, cycles: [] };
      inFlight[key] = { ...slot, cycles: [...slot.cycles, a.cycleStats] };
      return {
        ...s,
        studies: { ...s.studies, [a.id]: { ...existing, inFlight } },
      };
    }
    case "sweepRpmDone": {
      const existing = s.studies[a.id];
      if (!existing || existing.kind !== "sweep") return s;
      // Find the in-flight slot by matching rpm. Drain its cycles into
      // the new SweepPoint and free the slot.
      const inFlight = { ...(existing.inFlight ?? {}) };
      let cycles: CycleStats[] = [];
      for (const key of Object.keys(inFlight)) {
        const slot = inFlight[key];
        if (slot && Math.abs(slot.rpm - a.point.rpm) < 1e-9) {
          cycles = slot.cycles;
          delete inFlight[key];
          break;
        }
      }
      const newPoint: SweepPoint = {
        ...a.point,
        cycles,
        captureDir: a.captureDir,
      };
      return {
        ...s,
        studies: {
          ...s.studies,
          [a.id]: {
            ...existing,
            points: [...existing.points, newPoint],
            inFlight,
          },
        },
      };
    }
    case "setSweepCompare": {
      const existing = s.studies[a.id];
      if (!existing || existing.kind !== "sweep") return s;
      return {
        ...s,
        studies: {
          ...s.studies,
          [a.id]: { ...existing, compareWithStudyId: a.compareWithStudyId },
        },
      };
    }
    case "deleteStudy": {
      const { [a.id]: _drop, ...rest } = s.studies;
      return {
        ...s,
        studies: rest,
        activeStudyId: s.activeStudyId === a.id ? null : s.activeStudyId,
      };
    }
    case "optimizationTrialStarted": {
      const existing = s.studies[a.id];
      if (!existing || existing.kind !== "optimization") return s;
      const trials = existing.trials.slice();
      const prior = trials[a.trialIdx];
      trials[a.trialIdx] = {
        trialIdx: a.trialIdx,
        parameterValues: a.parameterValues,
        status: "running",
        objectiveValue: prior?.objectiveValue ?? null,
        sweepPoints: prior?.sweepPoints ?? null,
        wallTimeS: prior?.wallTimeS ?? null,
      };
      return {
        ...s,
        studies: { ...s.studies, [a.id]: { ...existing, trials } },
      };
    }
    case "optimizationTrialDone": {
      const existing = s.studies[a.id];
      if (!existing || existing.kind !== "optimization") return s;
      const trials = existing.trials.map((t) =>
        t.trialIdx === a.trialIdx
          ? {
              ...t,
              status: "done" as const,
              objectiveValue: a.objectiveValue,
              // Materialize SweepPoint entries with empty cycle arrays —
              // optimization trials don't stream per-cycle data; we have
              // the converged-cycle `lastCycle` from the backend.
              sweepPoints: a.sweepPoints.map((p) => ({
                ...p,
                cycles: [],
              })),
              wallTimeS: a.wallTimeS,
            }
          : t,
      );
      return {
        ...s,
        studies: { ...s.studies, [a.id]: { ...existing, trials } },
      };
    }
    case "optimizationFinished": {
      const existing = s.studies[a.id];
      if (!existing || existing.kind !== "optimization") return s;
      return {
        ...s,
        studies: {
          ...s.studies,
          [a.id]: {
            ...existing,
            status: a.status,
            bestTrialIdx: a.bestTrialIdx,
            bestObjectiveValue: a.bestObjectiveValue,
            finishedAt: a.finishedAt,
            summary: a.summary ?? existing.summary,
            error: a.error ?? existing.error,
          },
        },
      };
    }
    case "rehydrate":
      return {
        ...s,
        hydrated: true,
        studies: Object.fromEntries(a.studies.map((st) => [st.id, st])),
        loadedConfig: s.loadedConfig,
      };
  }
}

export interface CfdContextValue {
  state: State;
  bridge: CfdBridge;
  setLoadedConfig: (cfg: LoadedConfig | null) => void;
  navigateTo: (screen: NavId) => void;
  setActiveStudy: (id: string | null) => void;
  startSingleRpm: (configPath: string, params: SingleRpmParams) => Promise<string>;
  startSweep: (configPath: string, params: SweepParams) => Promise<string>;
  startOptimization: (configPath: string, params: OptimizationParams) => Promise<string>;
  cancelStudy: (id: string) => Promise<void>;
  deleteStudy: (id: string) => void;
  setSweepCompare: (id: string, compareWithStudyId?: string) => void;
  /** Test-only entry point. Dispatches actions as if a Tauri event fired. */
  __dispatchTestEvent?: (event: JobEvent) => void;
}

const CfdCtx = createContext<CfdContextValue | null>(null);

export function useCfd(): CfdContextValue {
  const v = useContext(CfdCtx);
  if (!v) throw new Error("useCfd must be used inside <CfdProvider>");
  return v;
}

interface ProviderProps {
  children: ReactNode;
  bridge?: CfdBridge;
  skipRehydrate?: boolean;
}

export function CfdProvider({ children, bridge = realBridge, skipRehydrate = false }: ProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  function applyEventAction(event: JobEvent) {
    switch (event.name) {
      case "cfd:job-progress": {
        const p = event.payload;
        const payload: JobProgressPayload = p.payload;
        switch (payload.kind) {
          case "single-rpm":
            dispatch({ type: "appendCycle", id: p.jobId, cycle: payload.cycleStats, total: payload.total });
            return;
          case "sweep-rpm-started":
            dispatch({ type: "sweepRpmStarted", id: p.jobId, rpmIdx: payload.rpmIdx, rpm: payload.rpm });
            return;
          case "sweep-cycle":
            dispatch({ type: "sweepCycle", id: p.jobId, rpmIdx: payload.rpmIdx, rpm: payload.rpm, cycleStats: payload.cycleStats });
            return;
          case "sweep-rpm-done":
            dispatch({ type: "sweepRpmDone", id: p.jobId, point: payload.point, captureDir: payload.captureDir });
            return;
          case "optimization-trial-started":
            dispatch({
              type: "optimizationTrialStarted",
              id: p.jobId,
              trialIdx: payload.trialIdx,
              parameterValues: payload.parameterValues,
            });
            return;
          case "optimization-trial-done":
            dispatch({
              type: "optimizationTrialDone",
              id: p.jobId,
              trialIdx: payload.trialIdx,
              objectiveValue: payload.objectiveValue,
              sweepPoints: payload.sweepPoints,
              wallTimeS: payload.wallTimeS,
            });
            return;
        }
        return;
      }
      case "cfd:job-done": {
        const p = event.payload;
        if (p.payload.kind === "single-rpm") {
          dispatch({
            type: "updateStudy", id: p.jobId,
            patch: {
              status: "done", finishedAt: Date.now(),
              summary: {
                convergedCycle: p.payload.convergedCycle,
                nCyclesRun: p.payload.nCyclesRun,
                stepCount: p.payload.stepCount,
                captureDir: p.payload.captureDir,
              },
            } as Partial<SingleRpmStudy>,
          });
        } else if (p.payload.kind === "sweep") {
          dispatch({
            type: "updateStudy", id: p.jobId,
            patch: {
              status: "done", finishedAt: Date.now(),
              summary: {
                nRpms: p.payload.nRpms,
                nCompleted: p.payload.nCompleted,
                totalStepCount: p.payload.totalStepCount,
                totalWallTimeS: p.payload.totalWallTimeS,
              },
            } as Partial<SweepStudy>,
          });
        } else {
          // optimization
          const summary: OptimizationDoneSummary = {
            nTrialsRequested: p.payload.nTrialsRequested,
            nTrialsRun: p.payload.nTrialsRun,
            bestTrialIdx: p.payload.bestTrialIdx,
            bestObjectiveValue: p.payload.bestObjectiveValue,
            parameterPaths: p.payload.parameterPaths,
            objectiveDirection: p.payload.objectiveDirection,
            totalWallTimeS: p.payload.totalWallTimeS,
          };
          dispatch({
            type: "optimizationFinished",
            id: p.jobId,
            bestTrialIdx: p.payload.bestTrialIdx,
            bestObjectiveValue: p.payload.bestObjectiveValue,
            status: "done",
            finishedAt: Date.now(),
            summary,
          });
        }
        return;
      }
      case "cfd:job-cancelled": {
        const p = event.payload;
        dispatch({ type: "updateStudy", id: p.jobId, patch: { status: "cancelled", finishedAt: Date.now() } });
        return;
      }
      case "cfd:job-error": {
        const p = event.payload;
        dispatch({
          type: "updateStudy", id: p.jobId,
          patch: { status: "error", finishedAt: Date.now(), error: p.message, errorReason: p.reason } as Partial<Study>,
        });
        // Single-RPM: merge any missed cycles.
        const existing = stateRef.current.studies[p.jobId];
        if (existing && existing.kind === "single-rpm" && p.partialCycles.length > existing.cycles.length) {
          for (let i = existing.cycles.length; i < p.partialCycles.length; i++) {
            const cycle = p.partialCycles[i];
            if (!cycle) continue;
            dispatch({ type: "appendCycle", id: p.jobId, cycle, total: existing.params.nCyclesMax });
          }
        }
        return;
      }
      case "cfd:job-started":
        return;
    }
  }

  // Mount: rehydrate from localStorage, subscribe to events.
  useEffect(() => {
    let cancelled = false;
    let unsubPromise: Promise<() => Promise<void>> | null = null;

    const persisted = loadPersisted();
    // v2 persistence carries full studies (cycles + sweep points) so a
    // dev-server restart preserves the data, not just the headers.
    // Studies that were `running` when the previous session ended are
    // demoted to `cancelled` since their worker thread is dead.
    const rehydratedStudies: Study[] = persisted.studies.map((s) => {
      if (s.status === "running" || s.status === "cancelling") {
        return { ...s, status: "cancelled" as StudyStatus,
                 finishedAt: s.finishedAt ?? Date.now() };
      }
      return s;
    });
    dispatch({
      type: "rehydrate",
      studies: rehydratedStudies,
      lastConfigPath: persisted.lastConfigPath,
    });

    unsubPromise = bridge.subscribe((event) => {
      if (cancelled) return;
      applyEventAction(event);
    });

    if (!skipRehydrate) {
      bridge.listJobs().then((jobs) => {
        if (cancelled) return;
        for (const j of jobs) {
          dispatch({
            type: "updateStudy", id: j.id,
            patch: { status: j.status, finishedAt: j.finishedAt } as Partial<Study>,
          });
        }
      }).catch(() => { /* non-fatal */ });
    }

    return () => {
      cancelled = true;
      unsubPromise?.then((u) => u()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  // Persist full studies + last config path whenever they change. v2
  // storage keeps per-cycle stats and sweep points so a dev-server
  // restart preserves data the user already paid solver time for.
  useEffect(() => {
    if (!state.hydrated) return;
    const studies = Object.values(state.studies)
      .sort((a, b) => b.startedAt - a.startedAt);
    savePersisted({ lastConfigPath: state.loadedConfig?.path ?? null, studies });
  }, [state.studies, state.loadedConfig, state.hydrated]);

  const value: CfdContextValue = useMemo(
    () => ({
      state,
      bridge,
      setLoadedConfig: (cfg) => dispatch({ type: "setLoadedConfig", cfg }),
      navigateTo: (screen) => dispatch({ type: "setActiveScreen", screen }),
      setActiveStudy: (id) => dispatch({ type: "setActiveStudy", id }),
      startSingleRpm: async (configPath, params) => {
        const { jobId } = await bridge.startJob({ kind: "single-rpm", configPath, params });
        dispatch({
          type: "addStudy",
          study: {
            id: jobId, kind: "single-rpm", status: "running", configPath,
            startedAt: Date.now(), params, cycles: [],
          },
        });
        dispatch({ type: "setActiveScreen", screen: "results" });
        return jobId;
      },
      startSweep: async (configPath, params) => {
        const { jobId } = await bridge.startJob({ kind: "sweep", configPath, params });
        dispatch({
          type: "addStudy",
          study: {
            id: jobId, kind: "sweep", status: "running", configPath,
            startedAt: Date.now(), params, points: [],
          },
        });
        dispatch({ type: "setActiveScreen", screen: "results" });
        return jobId;
      },
      startOptimization: async (configPath, params) => {
        const { jobId } = await bridge.startJob({ kind: "optimization", configPath, params });
        const trials: OptimizationTrial[] = Array.from(
          { length: params.nTrials },
          (_, i): OptimizationTrial => ({
            trialIdx: i,
            parameterValues: {},
            status: "pending",
            objectiveValue: null,
            sweepPoints: null,
            wallTimeS: null,
          }),
        );
        const study: OptimizationStudy = {
          id: jobId,
          kind: "optimization",
          status: "running",
          configPath,
          startedAt: Date.now(),
          params,
          trials,
          bestTrialIdx: null,
          bestObjectiveValue: null,
          parameterPaths: params.tunables.map((t) => t.path),
          objectiveDirection: params.objective.direction,
        };
        dispatch({ type: "addStudy", study });
        dispatch({ type: "setActiveScreen", screen: "results" });
        return jobId;
      },
      cancelStudy: async (id) => {
        dispatch({ type: "updateStudy", id, patch: { status: "cancelling" } });
        await bridge.cancelJob(id);
      },
      deleteStudy: (id) => dispatch({ type: "deleteStudy", id }),
      setSweepCompare: (id, compareWithStudyId) => dispatch({ type: "setSweepCompare", id, compareWithStudyId }),
      __dispatchTestEvent: (event: JobEvent) => applyEventAction(event),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, bridge]
  );

  return <CfdCtx.Provider value={value}>{children}</CfdCtx.Provider>;
}
