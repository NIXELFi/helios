// Fake Tauri bridge for vitest. Records invocations so tests can
// assert on them, exposes an emit() to dispatch events to subscribers.

import type { CfdBridge } from "../../lib/tauriBridge";
import type {
  ExampleConfig,
  JobEvent,
  JobSummary,
  LoadedConfig,
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
  setListExamples(impl: () => Promise<ExampleConfig[]>): void;
  setStartJob(impl: (req: StartJobRequest) => Promise<{ jobId: string }>): void;
  setCancelJob(impl: (jobId: string) => Promise<void>): void;
  setListJobs(impl: () => Promise<JobSummary[]>): void;
}

export function makeFakeBridge(): FakeBridgeState {
  const invocations: Invocation[] = [];
  const subscribers = new Set<(e: JobEvent) => void>();

  let loadConfig: (path: string) => Promise<LoadedConfig> = async () => {
    throw new Error("loadConfig not configured");
  };
  let listExamples: () => Promise<ExampleConfig[]> = async () => [];
  let startJob: (req: StartJobRequest) => Promise<{ jobId: string }> = async () => ({
    jobId: "fake-job",
  });
  let cancelJob: (jobId: string) => Promise<void> = async () => {};
  let listJobs: () => Promise<JobSummary[]> = async () => [];

  const bridge: CfdBridge = {
    async loadConfig(path) {
      invocations.push({ command: "cfd_load_config", args: { path } });
      return loadConfig(path);
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
    setListExamples(impl) { listExamples = impl; },
    setStartJob(impl) { startJob = impl; },
    setCancelJob(impl) { cancelJob = impl; },
    setListJobs(impl) { listJobs = impl; },
  };
}
