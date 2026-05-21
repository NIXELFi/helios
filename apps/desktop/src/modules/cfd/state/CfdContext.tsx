// CFD module's React context. Holds loadedConfig, studies map,
// activeStudyId, activeScreen. Reducer-based so state transitions are
// testable in isolation. Subscribes to Tauri events at mount.

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { loadPersisted, savePersisted } from "../lib/cfdStorage";
import { type CfdBridge, realBridge } from "../lib/tauriBridge";
import type {
  JobEvent,
  LoadedConfig,
  NavId,
  StartJobRequest,
  Study,
  StudyHeader,
  StudyStatus,
} from "./types";

interface State {
  loadedConfig: LoadedConfig | null;
  studies: Record<string, Study>;
  activeStudyId: string | null;
  activeScreen: NavId;
  hydrated: boolean;
}

const initialState: State = {
  loadedConfig: null,
  studies: {},
  activeStudyId: null,
  activeScreen: "config",
  hydrated: false,
};

type Action =
  | { type: "setLoadedConfig"; cfg: LoadedConfig | null }
  | { type: "setActiveScreen"; screen: NavId }
  | { type: "setActiveStudy"; id: string | null }
  | { type: "addStudy"; study: Study }
  | { type: "updateStudy"; id: string; patch: Partial<Study> }
  | { type: "appendCycle"; id: string; cycle: import("./types").CycleStats; total: number }
  | { type: "deleteStudy"; id: string }
  | { type: "rehydrate"; studies: Study[]; lastConfigPath: string | null };

function reducer(s: State, a: Action): State {
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
      if (!existing) return s;
      return {
        ...s,
        studies: {
          ...s.studies,
          [a.id]: { ...existing, cycles: [...existing.cycles, a.cycle] },
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
    case "rehydrate":
      return {
        ...s,
        hydrated: true,
        studies: Object.fromEntries(a.studies.map((st) => [st.id, st])),
        loadedConfig: s.loadedConfig, // never re-hydrate the loaded config; user re-opens
      };
  }
}

export interface CfdContextValue {
  state: State;
  bridge: CfdBridge;
  setLoadedConfig: (cfg: LoadedConfig | null) => void;
  navigateTo: (screen: NavId) => void;
  setActiveStudy: (id: string | null) => void;
  startSingleRpm: (
    configPath: string,
    params: import("./types").SingleRpmParams
  ) => Promise<string>;
  cancelStudy: (id: string) => Promise<void>;
  deleteStudy: (id: string) => void;
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
  /** Tests inject a fake bridge; production uses the real one. */
  bridge?: CfdBridge;
  /** Tests skip the rehydration network call. */
  skipRehydrate?: boolean;
}

export function applyEvent(state: State, event: JobEvent): State {
  switch (event.name) {
    case "cfd:job-started": {
      // No-op: addStudy already set status to "running" optimistically.
      return state;
    }
    case "cfd:job-progress": {
      const p = event.payload;
      const existing = state.studies[p.jobId];
      if (!existing || existing.kind !== "single-rpm") return state;
      return {
        ...state,
        studies: {
          ...state.studies,
          [p.jobId]: { ...existing, cycles: [...existing.cycles, p.payload.cycleStats] },
        },
      };
    }
    case "cfd:job-done": {
      const p = event.payload;
      const existing = state.studies[p.jobId];
      if (!existing || existing.kind !== "single-rpm") return state;
      return {
        ...state,
        studies: {
          ...state.studies,
          [p.jobId]: {
            ...existing,
            status: "done" as StudyStatus,
            finishedAt: Date.now(),
            summary: p.payload,
          },
        },
      };
    }
    case "cfd:job-cancelled": {
      const p = event.payload;
      const existing = state.studies[p.jobId];
      if (!existing) return state;
      return {
        ...state,
        studies: {
          ...state.studies,
          [p.jobId]: { ...existing, status: "cancelled", finishedAt: Date.now() } as Study,
        },
      };
    }
    case "cfd:job-error": {
      const p = event.payload;
      const existing = state.studies[p.jobId];
      if (!existing) return state;
      return {
        ...state,
        studies: {
          ...state.studies,
          [p.jobId]: {
            ...existing,
            status: "error",
            finishedAt: Date.now(),
            error: p.message,
            errorReason: p.reason,
            cycles: existing.kind === "single-rpm"
              ? mergePartial(existing.cycles, p.partialCycles)
              : existing.cycles,
          } as Study,
        },
      };
    }
  }
}

function mergePartial<T extends { cycle: number }>(have: T[], partial: T[]): T[] {
  // Prefer cycles we already streamed (they came through progress); fill
  // any missing trailing cycles from the partial payload.
  if (partial.length <= have.length) return have;
  return [...have, ...partial.slice(have.length)];
}

export function CfdProvider({ children, bridge = realBridge, skipRehydrate = false }: ProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Apply incoming events through the same reducer path.
  function applyEventAction(event: JobEvent) {
    // Compute the new state with applyEvent (pure) then dispatch a single
    // "rehydrate"-style action. We model it as a specific action for each
    // event type via the existing reducer where possible.
    switch (event.name) {
      case "cfd:job-progress": {
        const p = event.payload;
        dispatch({ type: "appendCycle", id: p.jobId, cycle: p.payload.cycleStats, total: p.payload.total });
        return;
      }
      case "cfd:job-done": {
        const p = event.payload;
        dispatch({
          type: "updateStudy",
          id: p.jobId,
          patch: { status: "done", finishedAt: Date.now(), summary: p.payload } as Partial<Study>,
        });
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
          type: "updateStudy",
          id: p.jobId,
          patch: { status: "error", finishedAt: Date.now(), error: p.message, errorReason: p.reason } as Partial<Study>,
        });
        // Merge any partial cycles we missed.
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

  // Mount: rehydrate from localStorage + Rust, subscribe to events.
  useEffect(() => {
    let cancelled = false;
    let unsubPromise: Promise<() => Promise<void>> | null = null;

    const persisted = loadPersisted();
    // Re-materialize StudyHeader -> Study with empty cycles. We don't
    // refetch cycle data — Phase 1 keeps that in memory only.
    const rehydratedStudies: Study[] = persisted.studies.map((h) => ({
      id: h.id,
      kind: h.kind,
      status: h.status,
      configPath: h.configPath,
      startedAt: h.startedAt,
      finishedAt: h.finishedAt,
      params: h.params,
      cycles: [],
    }));
    dispatch({
      type: "rehydrate",
      studies: rehydratedStudies,
      lastConfigPath: persisted.lastConfigPath,
    });

    unsubPromise = bridge.subscribe((event) => {
      if (cancelled) return;
      applyEventAction(event);
    });

    // Fetch live Rust-side jobs to recover after HMR.
    if (!skipRehydrate) {
      bridge.listJobs().then((jobs) => {
        if (cancelled) return;
        for (const j of jobs) {
          dispatch({
            type: "updateStudy",
            id: j.id,
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

  // Persist headers + last config path whenever they change.
  useEffect(() => {
    if (!state.hydrated) return;
    const headers: StudyHeader[] = Object.values(state.studies)
      .filter((s): s is import("./types").SingleRpmStudy => s.kind === "single-rpm")
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        status: s.status,
        configPath: s.configPath,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        params: s.params,
      }));
    savePersisted({ lastConfigPath: state.loadedConfig?.path ?? null, studies: headers });
  }, [state.studies, state.loadedConfig, state.hydrated]);

  const value: CfdContextValue = useMemo(
    () => ({
      state,
      bridge,
      setLoadedConfig: (cfg) => dispatch({ type: "setLoadedConfig", cfg }),
      navigateTo: (screen) => dispatch({ type: "setActiveScreen", screen }),
      setActiveStudy: (id) => dispatch({ type: "setActiveStudy", id }),
      startSingleRpm: async (configPath, params) => {
        const { jobId } = await bridge.startJob({
          kind: "single-rpm",
          configPath,
          params,
        });
        dispatch({
          type: "addStudy",
          study: {
            id: jobId,
            kind: "single-rpm",
            status: "running",
            configPath,
            startedAt: Date.now(),
            params,
            cycles: [],
          },
        });
        dispatch({ type: "setActiveScreen", screen: "results" });
        return jobId;
      },
      cancelStudy: async (id) => {
        dispatch({ type: "updateStudy", id, patch: { status: "cancelling" } });
        await bridge.cancelJob(id);
      },
      deleteStudy: (id) => dispatch({ type: "deleteStudy", id }),
      __dispatchTestEvent: (event: JobEvent) => applyEventAction(event),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, bridge]
  );

  return <CfdCtx.Provider value={value}>{children}</CfdCtx.Provider>;
}
