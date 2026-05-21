// CFD module TS types — single source of truth on the frontend.
// Field names match the Rust DTO crate (cfd-core::dto) via serde's
// rename_all = "camelCase" / "kebab-case".

export type StudyKind = "single-rpm"; // future: "sweep" | "optimization"

export type StudyStatus =
  | "idle"
  | "running"
  | "cancelling"
  | "done"
  | "cancelled"
  | "error";

export type JunctionKind = "stagnation" | "characteristic";

export type ErrorReason = "config-load" | "solver-diverged" | "panic" | "other";

export interface CycleStats {
  cycle: number;
  massTotal: number;
  massDrift: number;
  massInRestrictor: number;
  massOutCollector: number;
  netPortFlow: number;
  nonconservation: number;
  imepBar: number;
  bmepBar: number;
  fmepBar: number;
  veAtm: number;
  intakeMassPerCycleG: number;
  fResidual: number;
  indicatedPowerKW: number;
  indicatedPowerHp: number;
  brakePowerKW: number;
  brakePowerHp: number;
  wheelPowerKW: number;
  wheelPowerHp: number;
  indicatedTorqueNm: number;
  brakeTorqueNm: number;
  wheelTorqueNm: number;
  egtMean: number;
}

export interface ConfigSummary {
  displayName: string;
  nCylinders: number;
  boreMm: number;
  strokeMm: number;
  compressionRatio: number;
  displacementL: number;
  restrictorThroatMm: number;
  plenumVolumeL: number;
}

export interface LoadedConfig {
  path: string;
  raw: Record<string, unknown>;
  summary: ConfigSummary;
  isExample: boolean;
}

export interface ExampleConfig {
  id: string;
  name: string;
  description: string;
  path: string;
}

export interface SingleRpmParams {
  rpm: number;
  nCyclesMax: number;
  junctionKind: JunctionKind;
  convergenceTolImep: number;
  convergenceMinCycles: number;
}

export type StartJobRequest =
  | { kind: "single-rpm"; configPath: string; params: SingleRpmParams };

export interface SingleRpmDoneSummary {
  convergedCycle: number;
  nCyclesRun: number;
  stepCount: number;
}

// ---- Studies (frontend state) ----

interface StudyBase {
  id: string;
  kind: StudyKind;
  status: StudyStatus;
  configPath: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  errorReason?: ErrorReason;
}

export interface SingleRpmStudy extends StudyBase {
  kind: "single-rpm";
  params: SingleRpmParams;
  cycles: CycleStats[];
  summary?: SingleRpmDoneSummary;
}

export type Study = SingleRpmStudy;

// Stored snapshot — cycle data omitted for storage hygiene.
export interface StudyHeader {
  id: string;
  kind: StudyKind;
  status: StudyStatus;
  configPath: string;
  startedAt: number;
  finishedAt?: number;
  params: SingleRpmParams;
}

// ---- Tauri event payloads (camelCase from serde) ----

export interface JobStartedEvent {
  jobId: string;
  kind: StudyKind;
  startedAt: number;
}

export interface JobProgressEvent {
  jobId: string;
  kind: StudyKind;
  payload: {
    cycle: number;
    total: number;
    cycleStats: CycleStats;
  };
}

export interface JobDoneEvent {
  jobId: string;
  kind: StudyKind;
  payload: SingleRpmDoneSummary;
}

export interface JobCancelledEvent {
  jobId: string;
  partialCycles: CycleStats[];
}

export interface JobErrorEvent {
  jobId: string;
  reason: ErrorReason;
  message: string;
  partialCycles: CycleStats[];
}

export type JobEvent =
  | { name: "cfd:job-started"; payload: JobStartedEvent }
  | { name: "cfd:job-progress"; payload: JobProgressEvent }
  | { name: "cfd:job-done"; payload: JobDoneEvent }
  | { name: "cfd:job-cancelled"; payload: JobCancelledEvent }
  | { name: "cfd:job-error"; payload: JobErrorEvent };

export interface JobSummary {
  id: string;
  kind: StudyKind;
  status: "running" | "done" | "cancelled" | "error";
  configPath: string;
  startedAt: number;
  finishedAt?: number;
}

// Active screen inside the module.
export type NavId = "config" | "studies" | "results";
