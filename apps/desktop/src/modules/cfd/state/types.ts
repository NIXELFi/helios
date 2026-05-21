// CFD module TS types — single source of truth on the frontend.
// Field names match the Rust DTO crate (cfd-core::dto) via serde's
// rename_all = "camelCase" / "kebab-case".

export type StudyKind = "single-rpm" | "sweep";

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
  captureWaves: boolean;
  capturePvLoops: boolean;
  capturePipeProfiles: boolean;
}

export interface SweepParams {
  rpmList: number[];
  nCyclesMax: number;
  junctionKind: JunctionKind;
  convergenceTolImep: number;
  convergenceMinCycles: number;
  captureWaves: boolean;
  capturePvLoops: boolean;
  capturePipeProfiles: boolean;
}

export type StartJobRequest =
  | { kind: "single-rpm"; configPath: string; params: SingleRpmParams }
  | { kind: "sweep"; configPath: string; params: SweepParams };

export interface SingleRpmDoneSummary {
  convergedCycle: number;
  nCyclesRun: number;
  stepCount: number;
  captureDir?: string;
}

export interface SweepPoint {
  rpm: number;
  convergedCycle: number;
  nCyclesRun: number;
  lastCycle: CycleStats;
  nonconservationMax: number;
  wallTimeS: number;
  stepCount: number;
  // Frontend-only enrichment as SweepCycle events arrive:
  cycles: CycleStats[];
  captureDir?: string;
}

export interface SweepDoneSummary {
  nRpms: number;
  nCompleted: number;
  totalStepCount: number;
  totalWallTimeS: number;
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

export interface SweepStudy extends StudyBase {
  kind: "sweep";
  params: SweepParams;
  points: SweepPoint[];
  /** In-flight per-RPM cycle buffers, keyed by `rpmIdx` as a string. */
  inFlight?: Record<string, { idx: number; rpm: number; cycles: CycleStats[] }>;
  summary?: SweepDoneSummary;
  compareWithStudyId?: string;
}

export type Study = SingleRpmStudy | SweepStudy;

// Stored snapshot — bulk data omitted for storage hygiene.
export type StudyHeader =
  | {
      id: string;
      kind: "single-rpm";
      status: StudyStatus;
      configPath: string;
      startedAt: number;
      finishedAt?: number;
      params: SingleRpmParams;
    }
  | {
      id: string;
      kind: "sweep";
      status: StudyStatus;
      configPath: string;
      startedAt: number;
      finishedAt?: number;
      params: SweepParams;
    };

// ---- Tauri event payloads (camelCase from serde) ----

export interface JobStartedEvent {
  jobId: string;
  kind: StudyKind;
  startedAt: number;
}

export type JobProgressPayload =
  | {
      kind: "single-rpm";
      cycle: number;
      total: number;
      cycleStats: CycleStats;
    }
  | {
      kind: "sweep-rpm-started";
      rpmIdx: number;
      totalRpms: number;
      rpm: number;
    }
  | {
      kind: "sweep-cycle";
      rpmIdx: number;
      rpm: number;
      cycle: number;
      total: number;
      cycleStats: CycleStats;
    }
  | {
      kind: "sweep-rpm-done";
      rpmIdx: number;
      rpm: number;
      point: Omit<SweepPoint, "cycles" | "captureDir"> & { captureDir?: string };
      captureDir?: string;
    };

export interface JobProgressEvent {
  jobId: string;
  kind: StudyKind;
  payload: JobProgressPayload;
}

export type JobDoneSummary =
  | { kind: "single-rpm"; convergedCycle: number; nCyclesRun: number; stepCount: number; captureDir?: string }
  | { kind: "sweep"; nRpms: number; nCompleted: number; totalStepCount: number; totalWallTimeS: number };

export interface JobDoneEvent {
  jobId: string;
  kind: StudyKind;
  payload: JobDoneSummary;
}

export interface JobCancelledEvent {
  jobId: string;
  kind: StudyKind;
  partialCycles: CycleStats[];
  partialPoints: Omit<SweepPoint, "cycles" | "captureDir">[];
}

export interface JobErrorEvent {
  jobId: string;
  kind: StudyKind;
  reason: ErrorReason;
  message: string;
  partialCycles: CycleStats[];
  partialPoints: Omit<SweepPoint, "cycles" | "captureDir">[];
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

// ---- Capture artifacts (loaded on demand via cfd_load_capture) ----

export interface PvSample {
  thetaLocalDeg: number;
  volume: number;
  pressure: number;
  temperature: number;
  xB: number;
}

export interface PvLoopArtifact {
  /** Outer index = cylinder index (0..n). */
  cylinders: PvSample[][];
}

export type PipeRole = "plenum" | "runner" | "primary" | "secondary" | "collector";

export interface PipeProfile {
  role: PipeRole;
  label: string;
  lengthM: number;
  xM: number[];
  rho: number[];
  u: number[];
  p: number[];
  t: number[];
}

export interface PipeProfileArtifact {
  profiles: PipeProfile[];
}
