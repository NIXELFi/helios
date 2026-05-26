// Thin typed wrappers around Tauri's invoke + event listen.
// Tests can substitute a fake via the CfdContext constructor.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  ExampleConfig,
  JobEvent,
  JobSummary,
  LoadedConfig,
  ParameterMeta,
  StartJobRequest,
} from "../state/types";

export interface CfdBridge {
  loadConfig(path: string): Promise<LoadedConfig>;
  saveConfig(path: string, raw: Record<string, unknown>): Promise<void>;
  defaultSaveDir(): Promise<string>;
  listExamples(): Promise<ExampleConfig[]>;
  startJob(request: StartJobRequest): Promise<{ jobId: string }>;
  cancelJob(jobId: string): Promise<void>;
  listJobs(): Promise<JobSummary[]>;
  subscribe(handler: (e: JobEvent) => void): Promise<() => Promise<void>>;
  /**
   * Load one of the on-disk capture artifacts written by the runner.
   * `file` is restricted by the Tauri side to `pv.json`, `profiles.json`,
   * or `manifest.json`. Returns raw parsed JSON; cast at call site.
   */
  loadCapture(
    jobId: string,
    studyKind: "single-rpm" | "sweep",
    rpmInt: number,
    file: "pv.json" | "profiles.json" | "manifest.json",
  ): Promise<unknown>;
  /**
   * Load wave data for a given job and RPM point.
   */
  loadWaves(
    jobId: string,
    studyKind: "single-rpm" | "sweep",
    rpmInt: number,
  ): Promise<unknown>;
  /** Optimization (Phase 5): enumerate the optimizable parameter schema
   *  for a given config file. Backend reads `n_cylinders` from the config
   *  to populate `arrayLen` for per-cylinder fields. */
  getParameterSchema(configPath: string): Promise<ParameterMeta[]>;
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
  saveConfig: (path, raw) => invoke<void>("cfd_save_config", { path, raw }),
  defaultSaveDir: () => invoke<string>("cfd_default_save_dir"),
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
  loadCapture: (jobId, studyKind, rpmInt, file) =>
    invoke<unknown>("cfd_load_capture", {
      jobId,
      studyKind,
      rpmInt,
      file,
    }),
  loadWaves: (jobId, studyKind, rpmInt) =>
    invoke<unknown>("cfd_load_waves", { jobId, studyKind, rpmInt }),
  getParameterSchema: (configPath) =>
    invoke<ParameterMeta[]>("cfd_get_parameter_schema", { configPath }),
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
