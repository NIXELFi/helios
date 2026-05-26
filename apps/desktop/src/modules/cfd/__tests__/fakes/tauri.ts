// Fake Tauri bridge for vitest. Records invocations so tests can
// assert on them, exposes an emit() to dispatch events to subscribers.

import type { CfdBridge } from "../../lib/tauriBridge";
import type {
  ExampleConfig,
  JobEvent,
  JobSummary,
  LoadedConfig,
  ParameterMeta,
  StartJobRequest,
} from "../../state/types";

export interface Invocation {
  command: string;
  args: Record<string, unknown>;
}

export interface FakeBridgeState {
  bridge: CfdBridge;
  invocations: Invocation[];
  emit(event: JobEvent): void;
  setLoadConfig(impl: (path: string) => Promise<LoadedConfig>): void;
  setSaveConfig(impl: (path: string, raw: Record<string, unknown>) => Promise<void>): void;
  setDefaultSaveDir(impl: () => Promise<string>): void;
  setListExamples(impl: () => Promise<ExampleConfig[]>): void;
  setStartJob(impl: (req: StartJobRequest) => Promise<{ jobId: string }>): void;
  setCancelJob(impl: (jobId: string) => Promise<void>): void;
  setListJobs(impl: () => Promise<JobSummary[]>): void;
  setLoadCapture(
    impl: (
      jobId: string,
      studyKind: "single-rpm" | "sweep",
      rpmInt: number,
      file: "pv.json" | "profiles.json" | "manifest.json",
    ) => Promise<unknown>,
  ): void;
  setLoadWaves(
    impl: (
      jobId: string,
      studyKind: "single-rpm" | "sweep",
      rpmInt: number,
    ) => Promise<unknown>,
  ): void;
  setGetParameterSchema(impl: (configPath: string) => Promise<ParameterMeta[]>): void;
}

export function makeFakeBridge(): FakeBridgeState {
  const invocations: Invocation[] = [];
  const subscribers = new Set<(e: JobEvent) => void>();

  let loadConfig: (path: string) => Promise<LoadedConfig> = async () => {
    throw new Error("loadConfig not configured");
  };
  let saveConfig: (path: string, raw: Record<string, unknown>) => Promise<void> = async () => {};
  let defaultSaveDir: () => Promise<string> = async () => "C:/Users/test/Documents/Helios/cfd/configs";
  let listExamples: () => Promise<ExampleConfig[]> = async () => [];
  let startJob: (req: StartJobRequest) => Promise<{ jobId: string }> = async () => ({
    jobId: "fake-job",
  });
  let cancelJob: (jobId: string) => Promise<void> = async () => {};
  let listJobs: () => Promise<JobSummary[]> = async () => [];
  let loadCapture: (
    jobId: string,
    studyKind: "single-rpm" | "sweep",
    rpmInt: number,
    file: "pv.json" | "profiles.json" | "manifest.json",
  ) => Promise<unknown> = async () => {
    throw new Error("loadCapture not configured");
  };
  let loadWaves: (
    jobId: string,
    studyKind: "single-rpm" | "sweep",
    rpmInt: number,
  ) => Promise<unknown> = async () => {
    throw new Error("loadWaves not configured");
  };
  let getParameterSchema: (configPath: string) => Promise<ParameterMeta[]> =
    async () => [];

  const bridge: CfdBridge = {
    async loadConfig(path) {
      invocations.push({ command: "cfd_load_config", args: { path } });
      return loadConfig(path);
    },
    async saveConfig(path, raw) {
      invocations.push({ command: "cfd_save_config", args: { path, raw } });
      return saveConfig(path, raw);
    },
    async defaultSaveDir() {
      invocations.push({ command: "cfd_default_save_dir", args: {} });
      return defaultSaveDir();
    },
    async listExamples() {
      invocations.push({ command: "cfd_list_examples", args: {} });
      return listExamples();
    },
    async startJob(request) {
      invocations.push({ command: "cfd_start_job", args: { request } });
      return startJob(request);
    },
    async cancelJob(jobId) {
      invocations.push({ command: "cfd_cancel_job", args: { jobId } });
      return cancelJob(jobId);
    },
    async listJobs() {
      invocations.push({ command: "cfd_list_jobs", args: {} });
      return listJobs();
    },
    async loadCapture(jobId, studyKind, rpmInt, file) {
      invocations.push({ command: "cfd_load_capture", args: { jobId, studyKind, rpmInt, file } });
      return loadCapture(jobId, studyKind, rpmInt, file);
    },
    async loadWaves(jobId, studyKind, rpmInt) {
      invocations.push({ command: "cfd_load_waves", args: { jobId, studyKind, rpmInt } });
      return loadWaves(jobId, studyKind, rpmInt);
    },
    async getParameterSchema(configPath) {
      invocations.push({ command: "cfd_get_parameter_schema", args: { configPath } });
      return getParameterSchema(configPath);
    },
    async subscribe(handler) {
      subscribers.add(handler);
      return async () => {
        subscribers.delete(handler);
      };
    },
  };

  return {
    bridge,
    invocations,
    emit(event) {
      for (const s of subscribers) s(event);
    },
    setLoadConfig(impl) { loadConfig = impl; },
    setSaveConfig(impl) { saveConfig = impl; },
    setDefaultSaveDir(impl) { defaultSaveDir = impl; },
    setListExamples(impl) { listExamples = impl; },
    setStartJob(impl) { startJob = impl; },
    setCancelJob(impl) { cancelJob = impl; },
    setListJobs(impl) { listJobs = impl; },
    setLoadCapture(impl) { loadCapture = impl; },
    setLoadWaves(impl) { loadWaves = impl; },
    setGetParameterSchema(impl) { getParameterSchema = impl; },
  };
}
