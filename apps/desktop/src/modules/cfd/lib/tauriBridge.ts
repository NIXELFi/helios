// Thin typed wrappers around Tauri's invoke + event listen.
// Tests can substitute a fake via the CfdContext constructor.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  ExampleConfig,
  JobEvent,
  JobSummary,
  LoadedConfig,
  StartJobRequest,
} from "../state/types";

export interface CfdBridge {
  loadConfig(path: string): Promise<LoadedConfig>;
  listExamples(): Promise<ExampleConfig[]>;
  startJob(request: StartJobRequest): Promise<{ jobId: string }>;
  cancelJob(jobId: string): Promise<void>;
  listJobs(): Promise<JobSummary[]>;
  subscribe(handler: (e: JobEvent) => void): Promise<() => Promise<void>>;
}

const EVENT_NAMES = [
  "cfd:job-started",
  "cfd:job-progress",
  "cfd:job-done",
  "cfd:job-cancelled",
  "cfd:job-error",
] as const;

export const realBridge: CfdBridge = {
  loadConfig: (path) => invoke<LoadedConfig>("cfd_load_config", { path }),
  listExamples: () => invoke<ExampleConfig[]>("cfd_list_examples"),
  startJob: (request) => {
    // Tauri receives camelCase top-level args; the discriminated union
    // body lives under the `request` arg.
    return invoke<{ job_id: string }>("cfd_start_job", { request }).then((r) => ({
      jobId: (r as unknown as { jobId: string }).jobId ?? r.job_id,
    }));
  },
  cancelJob: (jobId) => invoke<void>("cfd_cancel_job", { jobId }),
  listJobs: () => invoke<JobSummary[]>("cfd_list_jobs"),
  subscribe: async (handler) => {
    const w = getCurrentWindow();
    const unsubs = await Promise.all(
      EVENT_NAMES.map((name) =>
        w.listen(name, (ev) =>
          handler({ name, payload: ev.payload as never })
        )
      )
    );
    return async () => {
      for (const u of unsubs) u();
    };
  },
};
