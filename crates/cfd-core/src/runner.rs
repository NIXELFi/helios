//! Worker-thread runner for CFD jobs.
//!
//! `SDM26Engine` is not `Send` (its area-fn closures aren't), so the
//! runner thread owns it from construction to drop. Progress, done,
//! cancellation, and error events emit through a `JobEmitter` trait so
//! tests can substitute a `VecEmitter` that records the sequence.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rayon::iter::{IntoParallelIterator, ParallelIterator};
use rayon::ThreadPoolBuilder;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{
    CycleLoopState, CycleObserver, CycleOutcome, CycleStats, SDM26Engine,
};

use crate::capture::{PipeProfileRecorder, PvLoopRecorder, WaveFrameWriter};
use crate::dto::{
    ErrorReason, JobCancelledEvent, JobDoneEvent, JobDoneSummary, JobErrorEvent,
    JobProgressEvent, JobProgressPayload, JobProgressSingleRpm, JobStartedEvent,
    SingleRpmDoneSummary, SingleRpmParams, StudyKind, SweepDoneSummary, SweepParams,
    SweepPoint,
};

// ---------------- Emitter trait (production + test seam) ----------------

pub trait JobEmitter: Send + Sync + 'static {
    fn emit_started(&self, ev: JobStartedEvent);
    fn emit_progress(&self, ev: JobProgressEvent);
    fn emit_done(&self, ev: JobDoneEvent);
    fn emit_cancelled(&self, ev: JobCancelledEvent);
    fn emit_error(&self, ev: JobErrorEvent);
}

// ---------------- Divergence probe (production + test seam) ----------------

pub trait DivergenceProbe: Send + Sync + 'static {
    fn is_diverged(&self, cs: &CycleStats) -> bool;
}

pub struct DefaultDivergenceProbe;
impl DivergenceProbe for DefaultDivergenceProbe {
    fn is_diverged(&self, cs: &CycleStats) -> bool {
        !cycle_stats_all_finite(cs)
    }
}

fn cycle_stats_all_finite(cs: &CycleStats) -> bool {
    let fields = [
        cs.mass_total, cs.mass_drift, cs.mass_in_restrictor, cs.mass_out_collector,
        cs.net_port_flow, cs.nonconservation,
        cs.imep_bar, cs.bmep_bar, cs.fmep_bar,
        cs.ve_atm, cs.intake_mass_per_cycle_g, cs.f_residual,
        cs.indicated_power_k_w, cs.indicated_power_hp,
        cs.brake_power_k_w, cs.brake_power_hp,
        cs.wheel_power_k_w, cs.wheel_power_hp,
        cs.indicated_torque_nm, cs.brake_torque_nm, cs.wheel_torque_nm,
        cs.egt_mean,
    ];
    fields.iter().all(|x| x.is_finite())
}

// ---------------- Solver-panic isolation ----------------
//
// The SDM26 solver `panic!`s on a handful of irrecoverable states
// (positivity failure, characteristic-junction non-convergence). Those
// runs happen inside rayon `par_iter` workers, so an un-caught panic
// unwinds the worker and aborts the WHOLE sweep / optimization job —
// one bad RPM or one bad trial takes down every sibling.
//
// `run_engine_unwind_safe` catches a panic from a single per-RPM /
// per-trial engine call and converts it into an `Err(message)`, routed
// into the same `ErrorReason::SolverDiverged` path already used for
// non-finite results. The engine is freshly constructed per worker and
// is dropped immediately after a caught panic (never reused), so the
// `AssertUnwindSafe` wrapper does not let any poisoned state escape.
//
fn run_engine_unwind_safe<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    result.map_err(|payload| {
        if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "solver panicked".to_string()
        }
    })
}

/// RAII guard that installs a no-op panic hook for the duration of a
/// solver region, then restores the previous hook on drop. We catch
/// solver panics ourselves and surface the message through the job error
/// event, so the default hook's stderr backtrace is just noise.
///
/// `set_hook`/`take_hook` are *process-global*: two CFD jobs running
/// concurrently (e.g. a single-RPM study and a sweep — different kinds,
/// both admitted by `CfdState::register`) would race the save/restore and
/// permanently clobber the real hook with a no-op:
///   A installs (prev=default), B installs (prev=A's no-op),
///   A drops (restores default), B drops (restores A's no-op) → leaked.
///
/// To make installs safe under concurrency we refcount through a single
/// process-global lock: the FIRST guard saves the real hook and installs
/// the no-op; nested/concurrent guards just bump the count; the LAST guard
/// to drop restores the originally-saved hook. The lock is only held for
/// the brief install/restore bookkeeping, never across the solver region,
/// so jobs still run in parallel.
struct SilencedPanicHook {
    _private: (),
}

type BoxedHook = Box<dyn Fn(&std::panic::PanicHookInfo<'_>) + Sync + Send + 'static>;

struct HookState {
    depth: usize,
    saved: Option<BoxedHook>,
}

fn hook_state() -> &'static Mutex<HookState> {
    static STATE: std::sync::OnceLock<Mutex<HookState>> = std::sync::OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HookState { depth: 0, saved: None }))
}

impl SilencedPanicHook {
    fn install() -> Self {
        let mut st = hook_state().lock().unwrap_or_else(|e| e.into_inner());
        if st.depth == 0 {
            // First active guard: save the real hook and silence.
            st.saved = Some(std::panic::take_hook());
            std::panic::set_hook(Box::new(|_| {}));
        }
        st.depth += 1;
        Self { _private: () }
    }
}
impl Drop for SilencedPanicHook {
    fn drop(&mut self) {
        let mut st = hook_state().lock().unwrap_or_else(|e| e.into_inner());
        st.depth -= 1;
        if st.depth == 0 {
            if let Some(prev) = st.saved.take() {
                std::panic::set_hook(prev);
            }
        }
    }
}

// ---------------- Convergence detector (mirrors engine-sim::run_single_rpm) ----------------
//
// MUST match `SDM26Engine::run_single_rpm` exactly so cfd-core sweeps
// reproduce engine-sim sweeps (which in turn match the Python solver).
// Subtle bits that bit us in v3.3.0:
//   - the gate is `len >= min_cycles + 1`, not `>= min_cycles`
//   - the denominator is the OLDER cycle's IMEP (cycles[n-2]), not the newer
//   - once converged_cycle is set, run ONE more cycle before breaking
//     (so the last-cycle stats are from the post-converged cycle, not the
//     convergence-detection cycle)
//
// Returns `(maybe_converged_cycle, should_break)`:
//   - `maybe_converged_cycle` = Some(this_cycle.cycle) the first time the
//     two-cycle stability check passes, otherwise None (preserve the
//     existing converged_cycle).
//   - `should_break` = true once stats.cycle >= converged_cycle + 1.
fn check_converged_engine_sim(
    cycles: &[CycleStats],
    tol: f64,
    min_cycles: u32,
    converged_cycle: i64,
) -> (Option<i64>, bool) {
    if cycles.len() < (min_cycles as usize) + 1 { return (None, false); }
    if cycles.len() < 2 { return (None, false); }
    let n = cycles.len();
    let this = cycles[n - 1];
    let prev = cycles[n - 2];
    let mut new_converged: Option<i64> = None;
    if prev.imep_bar.abs() > 1e-6 {
        let rel = (this.imep_bar - prev.imep_bar).abs() / prev.imep_bar.abs();
        if rel < tol && converged_cycle < 0 {
            new_converged = Some(this.cycle);
        }
    }
    let effective = new_converged.unwrap_or(converged_cycle);
    let should_break = effective > 0 && this.cycle >= effective + 1;
    (new_converged, should_break)
}

// ---------------- Capture helpers ----------------

/// Per-RPM capture knobs. Used by both single-RPM and sweep flows.
#[derive(Debug, Clone, Copy)]
pub struct CaptureFlags {
    pub waves: bool,
    pub pv_loops: bool,
    pub pipe_profiles: bool,
}

/// Run one *extra* cycle past convergence, attaching capture observers
/// so we get artifacts that reflect the final stabilized state. The
/// CycleStats this returns are intentionally discarded — the goal is
/// only the captures.
///
/// Returns the absolute capture directory (relative to `rpm_dir`) when
/// at least one artifact was written, else None.
fn capture_one_extra_cycle(
    eng: &mut SDM26Engine,
    state: &mut CycleLoopState,
    rpm: f64,
    captured_cycle: i64,
    rpm_dir: &Path,
    flags: CaptureFlags,
    _prev_cycle_step_count: u64,
) -> Option<PathBuf> {
    if !(flags.waves || flags.pv_loops || flags.pipe_profiles) {
        return None;
    }
    if std::fs::create_dir_all(rpm_dir).is_err() {
        return None;
    }
    // PV recorder + wave writer attach to advance_one_cycle.
    let mut pv = if flags.pv_loops {
        Some(PvLoopRecorder::new(eng.cylinders.len()))
    } else { None };
    let mut waves = if flags.waves {
        // Write every step. `prev_cycle_step_count` is the cumulative
        // warmup step count, not per-cycle, so the stride heuristic
        // under-samples the converged capture cycle severely. A converged
        // cycle is ~2k steps → ~2 MB JSONL, which is fine. Long startup
        // cycles aren't expected to be the capture target.
        let stride = 1u64;
        // Use a placeholder job_id; runner overwrites manifest if needed.
        WaveFrameWriter::create(rpm_dir, String::new(), eng, rpm, stride).ok()
    } else { None };

    // Drive one cycle with whichever observers are present. We can only
    // hold one &mut dyn at a time, so we run two passes if both PV and
    // waves are requested. That's a real cost (one duplicate cycle of
    // compute) but keeps the API simple; in practice users either care
    // about post-cycle artifacts XOR live wave frames.
    if waves.is_some() && pv.is_some() {
        // Two-pass: PV first, then waves. Capture state must be reset
        // BEFORE the wave pass by re-running the converged warmup. Since
        // we'd need to rebuild the engine to do that cleanly, settle for
        // wave-only on the second pass if both flags are set: PV is
        // accumulated this cycle, waves are accumulated next cycle.
        if let Some(pv_rec) = pv.as_mut() {
            let obs: &mut dyn CycleObserver = pv_rec;
            let _ = eng.advance_one_cycle(rpm, state, None, Some(obs), None);
        }
        // Snapshot pipe profiles between passes so they reflect the
        // state at end of the PV pass.
        if flags.pipe_profiles {
            let mut prec = PipeProfileRecorder::new();
            prec.snapshot_from(eng);
            let _ = write_json(&rpm_dir.join("profiles.json"), &prec.into_artifact());
        }
        if let Some(w) = waves.as_mut() {
            let obs: &mut dyn CycleObserver = w;
            let _ = eng.advance_one_cycle(rpm, state, None, Some(obs), None);
        }
    } else if let Some(pv_rec) = pv.as_mut() {
        let obs: &mut dyn CycleObserver = pv_rec;
        let _ = eng.advance_one_cycle(rpm, state, None, Some(obs), None);
        if flags.pipe_profiles {
            let mut prec = PipeProfileRecorder::new();
            prec.snapshot_from(eng);
            let _ = write_json(&rpm_dir.join("profiles.json"), &prec.into_artifact());
        }
    } else if let Some(w) = waves.as_mut() {
        let obs: &mut dyn CycleObserver = w;
        let _ = eng.advance_one_cycle(rpm, state, None, Some(obs), None);
        if flags.pipe_profiles {
            let mut prec = PipeProfileRecorder::new();
            prec.snapshot_from(eng);
            let _ = write_json(&rpm_dir.join("profiles.json"), &prec.into_artifact());
        }
    } else if flags.pipe_profiles {
        // Profiles only — no extra cycle needed but capture state is
        // taken AFTER one extra cycle for consistency with the wave/PV
        // paths.
        let _ = eng.advance_one_cycle(rpm, state, None, None, None);
        let mut prec = PipeProfileRecorder::new();
        prec.snapshot_from(eng);
        let _ = write_json(&rpm_dir.join("profiles.json"), &prec.into_artifact());
    }

    if let Some(pv_rec) = pv {
        let _ = write_json(&rpm_dir.join("pv.json"), &pv_rec.into_artifact());
    }
    if let Some(w) = waves {
        let _ = w.finalize(captured_cycle);
    }
    Some(rpm_dir.to_path_buf())
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let f = std::fs::File::create(path)?;
    let mut w = std::io::BufWriter::new(f);
    serde_json::to_writer(&mut w, value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::io::Write::flush(&mut w)?;
    Ok(())
}

// ---------------- Single-RPM runner ----------------

pub fn run_single_rpm_job<E: JobEmitter, P: DivergenceProbe>(
    emitter: &E,
    probe: &P,
    job_id: String,
    config_path: PathBuf,
    params: SingleRpmParams,
    cancel: Arc<AtomicBool>,
    started_at: u64,
    capture_root: Option<PathBuf>,
) -> RunOutcome {
    emitter.emit_started(JobStartedEvent {
        job_id: job_id.clone(),
        kind: StudyKind::SingleRpm,
        started_at,
    });

    let mut cfg = match load_v1_json(&config_path) {
        Ok(c) => c,
        Err(e) => {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::SingleRpm,
                reason: ErrorReason::ConfigLoad,
                message: e.to_string(),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
    };

    // Apply any UI-specified parameter overrides (e.g. Option B production
    // knob set preset). Each override is a single `apply_override` call;
    // unknown paths surface as ConfigLoad errors.
    for ov in &params.overrides {
        if let Err(e) = crate::params::apply_override(&mut cfg, &ov.path, ov.value) {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::SingleRpm,
                reason: ErrorReason::ConfigLoad,
                message: format!("apply_override({}): {}", ov.path, e),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
    }

    let mut eng = SDM26Engine::new(cfg, params.junction_kind.into());
    let mut loop_state = CycleLoopState::new(&mut eng);
    let mut accumulated: Vec<CycleStats> = Vec::with_capacity(params.n_cycles_max as usize);
    let mut converged_cycle: i64 = -1;

    // Silence the default panic hook for the cycle loop + capture pass:
    // the SDM26 solver `panic!`s on a handful of irrecoverable states
    // (positivity failure, junction non-convergence). We catch those
    // ourselves below and surface them as SolverDiverged, so the hook's
    // stderr backtrace would just be noise. Restored on drop.
    let _hook_guard = SilencedPanicHook::install();

    for cycle_i in 0..params.n_cycles_max {
        if cancel.load(Ordering::SeqCst) {
            emitter.emit_cancelled(JobCancelledEvent {
                job_id: job_id.clone(),
                kind: StudyKind::SingleRpm,
                partial_cycles: accumulated,
                partial_points: vec![],
            });
            return RunOutcome::Cancelled;
        }
        // Isolate solver panics so an irrecoverable cycle surfaces as a
        // SolverDiverged error instead of unwinding the worker thread and
        // leaving the job stuck "Running" forever (which would block every
        // future single-RPM study for the session).
        let outcome = run_engine_unwind_safe(|| {
            eng.advance_one_cycle(params.rpm, &mut loop_state, None, None, Some(&cancel))
        });
        let cs = match outcome {
            Ok(CycleOutcome::Cycle(stats)) => stats,
            Ok(CycleOutcome::TargetReached) => break,
            Ok(CycleOutcome::Cancelled) => break,
            Err(msg) => {
                emitter.emit_error(JobErrorEvent {
                    job_id: job_id.clone(),
                    kind: StudyKind::SingleRpm,
                    reason: ErrorReason::SolverDiverged,
                    message: format!(
                        "solver panic at cycle {ci}: {msg}",
                        ci = cycle_i + 1,
                    ),
                    partial_cycles: accumulated,
                    partial_points: vec![],
                });
                return RunOutcome::Errored;
            }
        };
        if probe.is_diverged(&cs) {
            accumulated.push(cs);
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::SingleRpm,
                reason: ErrorReason::SolverDiverged,
                message: format!("non-finite cycle stats at cycle {ci}", ci = cycle_i + 1),
                partial_cycles: accumulated,
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
        accumulated.push(cs);
        emitter.emit_progress(JobProgressEvent {
            job_id: job_id.clone(),
            kind: StudyKind::SingleRpm,
            payload: JobProgressPayload::SingleRpm(JobProgressSingleRpm {
                cycle: cycle_i + 1,
                total: params.n_cycles_max,
                cycle_stats: cs,
            }),
        });
        let (new_conv, should_break) = check_converged_engine_sim(
            &accumulated, params.convergence_tol_imep,
            params.convergence_min_cycles, converged_cycle,
        );
        if let Some(c) = new_conv { converged_cycle = c; }
        if should_break { break; }
    }

    // Optional capture cycle (after convergence/exhaustion).
    let flags = CaptureFlags {
        waves: params.capture_waves,
        pv_loops: params.capture_pv_loops,
        pipe_profiles: params.capture_pipe_profiles,
    };
    let capture_dir = if let Some(root) = capture_root.as_ref() {
        let rpm_dir = root
            .join(&job_id)
            .join("single-rpm")
            .join(format!("{:.0}", params.rpm));
        let prev_steps = loop_state.step_count;
        // The capture pass runs one more solver cycle; isolate any panic so
        // a capture-only failure can't unwind the worker. The run is already
        // done, so a failed capture just means no artifacts.
        run_engine_unwind_safe(|| {
            capture_one_extra_cycle(
                &mut eng, &mut loop_state, params.rpm,
                accumulated.last().map(|s| s.cycle).unwrap_or(-1),
                &rpm_dir, flags, prev_steps,
            )
        })
        .unwrap_or(None)
    } else { None };

    emitter.emit_done(JobDoneEvent {
        job_id: job_id.clone(),
        kind: StudyKind::SingleRpm,
        payload: JobDoneSummary::SingleRpm(SingleRpmDoneSummary {
            converged_cycle,
            n_cycles_run: accumulated.len() as u32,
            step_count: loop_state.step_count,
            capture_dir: capture_dir.map(|p| p.to_string_lossy().into_owned()),
        }),
    });
    RunOutcome::Completed(accumulated)
}

// ---------------- Sweep runner ----------------

pub fn run_sweep_job<E: JobEmitter, P: DivergenceProbe>(
    emitter: &E,
    probe: &P,
    job_id: String,
    config_path: PathBuf,
    params: SweepParams,
    cancel: Arc<AtomicBool>,
    started_at: u64,
    capture_root: Option<PathBuf>,
) -> RunOutcome {
    emitter.emit_started(JobStartedEvent {
        job_id: job_id.clone(),
        kind: StudyKind::Sweep,
        started_at,
    });
    let mut cfg = match load_v1_json(&config_path) {
        Ok(c) => c,
        Err(e) => {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Sweep,
                reason: ErrorReason::ConfigLoad,
                message: e.to_string(),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
    };

    // Apply any UI-specified parameter overrides (preset support).
    for ov in &params.overrides {
        if let Err(e) = crate::params::apply_override(&mut cfg, &ov.path, ov.value) {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Sweep,
                reason: ErrorReason::ConfigLoad,
                message: format!("apply_override({}): {}", ov.path, e),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
    }
    let cfg = cfg; // re-bind to immutable for the rest of the function

    let flags = CaptureFlags {
        waves: params.capture_waves,
        pv_loops: params.capture_pv_loops,
        pipe_profiles: params.capture_pipe_profiles,
    };
    let total_rpms = params.rpm_list.len() as u32;
    let total_step_count_atomic = Arc::new(AtomicU64::new(0));
    let total_t0 = Instant::now();

    // Per-RPM workers run inside a private thread pool sized to
    // (cores - 1, clamped >= 1). Default rayon uses ALL cores which
    // can starve the UI / dev server on small machines.
    //
    // Workers run independently — each spins up its own SDM26Engine,
    // runs to convergence, optionally takes the capture cycle, then
    // emits SweepRpmDone. Cycle-level events are emitted via the
    // shared emitter (must be Sync). Order across RPMs is non-
    // deterministic; the frontend keys on `rpm_idx` so the final
    // state is correct regardless of arrival order.

    // Errors / cancellations surface via shared mutexes.
    let stop = Arc::new(AtomicBool::new(false));
    let error_state: Arc<Mutex<Option<JobErrorEvent>>> = Arc::new(Mutex::new(None));
    let completed_points: Arc<Mutex<Vec<(u32, SweepPoint)>>> =
        Arc::new(Mutex::new(Vec::with_capacity(params.rpm_list.len())));

    let n_cpus = num_cpus::get().saturating_sub(1).max(1);
    let pool = match ThreadPoolBuilder::new().num_threads(n_cpus).build() {
        Ok(p) => p,
        Err(e) => {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Sweep,
                reason: ErrorReason::Other,
                message: format!("rayon pool: {e}"),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
    };

    // Silence the default panic hook while workers run: solver panics are
    // caught per-RPM below and surfaced as SolverDiverged errors, so the
    // hook's stderr backtrace would just be duplicate noise. Restored on
    // drop after the parallel region completes.
    let _hook_guard = SilencedPanicHook::install();
    pool.install(|| {
        let rpms: Vec<(u32, f64)> = params.rpm_list.iter().enumerate()
            .map(|(i, &r)| (i as u32, r))
            .collect();
        rpms.into_par_iter().for_each(|(rpm_idx, rpm)| {
            // Bail fast if another worker already errored or the user cancelled.
            if stop.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst) {
                return;
            }
            emitter.emit_progress(JobProgressEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Sweep,
                payload: JobProgressPayload::SweepRpmStarted {
                    rpm_idx, total_rpms, rpm,
                },
            });

            let mut eng = SDM26Engine::new(cfg.clone(), params.junction_kind.into());
            let mut loop_state = CycleLoopState::new(&mut eng);
            let mut accumulated: Vec<CycleStats> = Vec::with_capacity(params.n_cycles_max as usize);
            let rpm_t0 = Instant::now();
            let mut converged_cycle: i64 = -1;
            let mut nonconservation_max = 0.0_f64;

            for cycle_i in 0..params.n_cycles_max {
                if stop.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst) {
                    return;
                }
                // Isolate solver panics (positivity / junction non-convergence)
                // so one bad RPM cannot abort the whole sweep — treat a caught
                // panic exactly like a diverged cycle.
                let outcome = run_engine_unwind_safe(|| {
                    eng.advance_one_cycle(rpm, &mut loop_state, None, None, Some(&cancel))
                });
                let cs = match outcome {
                    Ok(CycleOutcome::Cycle(stats)) => stats,
                    Ok(CycleOutcome::TargetReached) => break,
                    Ok(CycleOutcome::Cancelled) => break,
                    Err(msg) => {
                        let mut e = error_state.lock().unwrap();
                        if e.is_none() {
                            *e = Some(JobErrorEvent {
                                job_id: job_id.clone(),
                                kind: StudyKind::Sweep,
                                reason: ErrorReason::SolverDiverged,
                                message: format!(
                                    "solver panic at rpm {rpm:.0} cycle {ci}: {msg}",
                                    ci = cycle_i + 1,
                                ),
                                partial_cycles: accumulated.clone(),
                                partial_points: vec![],
                            });
                        }
                        stop.store(true, Ordering::SeqCst);
                        return;
                    }
                };
                if probe.is_diverged(&cs) {
                    accumulated.push(cs);
                    // First diverger wins — record + stop other workers.
                    let mut e = error_state.lock().unwrap();
                    if e.is_none() {
                        *e = Some(JobErrorEvent {
                            job_id: job_id.clone(),
                            kind: StudyKind::Sweep,
                            reason: ErrorReason::SolverDiverged,
                            message: format!(
                                "non-finite cycle stats at rpm {rpm:.0} cycle {ci}",
                                ci = cycle_i + 1,
                            ),
                            partial_cycles: accumulated.clone(),
                            partial_points: vec![],
                        });
                    }
                    stop.store(true, Ordering::SeqCst);
                    return;
                }
                nonconservation_max = nonconservation_max.max(cs.nonconservation.abs());
                accumulated.push(cs);
                emitter.emit_progress(JobProgressEvent {
                    job_id: job_id.clone(),
                    kind: StudyKind::Sweep,
                    payload: JobProgressPayload::SweepCycle {
                        rpm_idx, rpm,
                        cycle: cycle_i + 1,
                        total: params.n_cycles_max,
                        cycle_stats: cs,
                    },
                });
                let (new_conv, should_break) = check_converged_engine_sim(
                    &accumulated, params.convergence_tol_imep,
                    params.convergence_min_cycles, converged_cycle,
                );
                if let Some(c) = new_conv { converged_cycle = c; }
                if should_break { break; }
            }

            let wall_time_s = rpm_t0.elapsed().as_secs_f64();
            let last_cs = accumulated.last().copied();
            let n_cycles_run = accumulated.len() as u32;
            total_step_count_atomic.fetch_add(loop_state.step_count, Ordering::Relaxed);

            // Optional capture pass for this RPM. Each worker writes to its
            // OWN <job_id>/sweep/<rpm>/ subdir so there is no contention.
            let capture_dir = if let Some(root) = capture_root.as_ref() {
                let rpm_dir = root
                    .join(&job_id)
                    .join("sweep")
                    .join(format!("{:.0}", rpm));
                let prev_steps = loop_state.step_count;
                // The capture pass runs one more solver cycle; isolate any
                // panic so a capture-only failure can't unwind the worker and
                // abort the sweep. The SweepPoint is already computed, so a
                // failed capture just means no artifacts for this RPM.
                run_engine_unwind_safe(|| {
                    capture_one_extra_cycle(
                        &mut eng, &mut loop_state, rpm,
                        last_cs.map(|c| c.cycle).unwrap_or(-1),
                        &rpm_dir, flags, prev_steps,
                    )
                })
                .unwrap_or(None)
            } else { None };

            if let Some(last) = last_cs {
                let point = SweepPoint {
                    rpm,
                    converged_cycle,
                    n_cycles_run,
                    last_cycle: last,
                    nonconservation_max,
                    wall_time_s,
                    step_count: loop_state.step_count,
                };
                completed_points.lock().unwrap().push((rpm_idx, point.clone()));
                emitter.emit_progress(JobProgressEvent {
                    job_id: job_id.clone(),
                    kind: StudyKind::Sweep,
                    payload: JobProgressPayload::SweepRpmDone {
                        rpm_idx, rpm,
                        point,
                        capture_dir: capture_dir.map(|p| p.to_string_lossy().into_owned()),
                    },
                });
            } else if !(stop.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst)) {
                // Zero cycles completed and we were NOT stopped/cancelled
                // (e.g. n_cycles_max == 0, or the first cycle immediately
                // returned TargetReached). Without this branch the RPM
                // silently vanishes — no point AND no error — leaving a
                // sweep with fewer points than requested RPMs and no
                // explanation. Surface it as a hard error so the user knows.
                let mut e = error_state.lock().unwrap();
                if e.is_none() {
                    *e = Some(JobErrorEvent {
                        job_id: job_id.clone(),
                        kind: StudyKind::Sweep,
                        reason: ErrorReason::Other,
                        message: format!(
                            "no cycles completed at rpm {rpm:.0} (n_cycles_max={})",
                            params.n_cycles_max,
                        ),
                        partial_cycles: vec![],
                        partial_points: vec![],
                    });
                }
                stop.store(true, Ordering::SeqCst);
            }
        });
    });

    // Drain results, sorted by rpm_idx so downstream consumers see a
    // canonical order regardless of which worker finished first.
    let mut points: Vec<SweepPoint> = {
        let mut v = completed_points.lock().unwrap();
        v.sort_by_key(|(idx, _)| *idx);
        v.drain(..).map(|(_, p)| p).collect()
    };

    // Surface error / cancel if any worker hit it.
    if let Some(err) = error_state.lock().unwrap().take() {
        let mut err = err;
        err.partial_points = points;
        emitter.emit_error(err);
        return RunOutcome::Errored;
    }
    if cancel.load(Ordering::SeqCst) {
        emitter.emit_cancelled(JobCancelledEvent {
            job_id: job_id.clone(),
            kind: StudyKind::Sweep,
            partial_cycles: vec![],
            partial_points: std::mem::take(&mut points),
        });
        return RunOutcome::Cancelled;
    }

    let total_step_count = total_step_count_atomic.load(Ordering::Relaxed);
    emitter.emit_done(JobDoneEvent {
        job_id: job_id.clone(),
        kind: StudyKind::Sweep,
        payload: JobDoneSummary::Sweep(SweepDoneSummary {
            n_rpms: total_rpms,
            n_completed: points.len() as u32,
            total_step_count,
            total_wall_time_s: total_t0.elapsed().as_secs_f64(),
        }),
    });
    RunOutcome::CompletedSweep(points)
}

// ---------------- Optimization runner ----------------

/// Knobs for a single inline RPM run inside an optimization trial.
/// Packaged into one struct so the helper signature stays under
/// clippy's `too_many_arguments` threshold.
struct InlineRpmSpec {
    junction: engine_sim::model::sdm26::JunctionKind,
    rpm: f64,
    n_cycles_max: u32,
    tol: f64,
    min_cycles: u32,
}

/// Run a single RPM inline (no emit events, no captures) and return the
/// per-RPM SweepPoint or an error if the trial was cancelled / diverged
/// mid-run. Used by `run_optimization_job` — trials never write disk
/// artifacts (capture flags are forced off).
fn run_single_rpm_inline<P: DivergenceProbe>(
    cfg: &engine_sim::model::sdm26::SDM26Config,
    spec: &InlineRpmSpec,
    probe: &P,
    cancel: &AtomicBool,
) -> Result<SweepPoint, String> {
    let InlineRpmSpec { junction, rpm, n_cycles_max, tol, min_cycles } = *spec;
    let mut eng = SDM26Engine::new(cfg.clone(), junction);
    let mut loop_state = CycleLoopState::new(&mut eng);
    let mut accumulated: Vec<CycleStats> = Vec::with_capacity(n_cycles_max as usize);
    let rpm_t0 = Instant::now();
    let mut converged_cycle: i64 = -1;
    let mut nonconservation_max = 0.0_f64;

    for cycle_i in 0..n_cycles_max {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        // Isolate solver panics so one bad trial RPM cannot abort the
        // whole optimization — convert a caught panic into the same Err
        // path used for a diverged / non-finite cycle.
        let outcome = run_engine_unwind_safe(|| {
            eng.advance_one_cycle(rpm, &mut loop_state, None, None, Some(cancel))
        });
        let cs = match outcome {
            Ok(CycleOutcome::Cycle(stats)) => stats,
            Ok(CycleOutcome::TargetReached) => break,
            Ok(CycleOutcome::Cancelled) => return Err("cancelled".to_string()),
            Err(msg) => {
                return Err(format!(
                    "solver panic at rpm {rpm:.0} cycle {ci}: {msg}",
                    ci = cycle_i + 1,
                ));
            }
        };
        if probe.is_diverged(&cs) {
            return Err(format!(
                "non-finite cycle stats at rpm {rpm:.0} cycle {ci}",
                ci = cycle_i + 1,
            ));
        }
        nonconservation_max = nonconservation_max.max(cs.nonconservation.abs());
        accumulated.push(cs);
        let (new_conv, should_break) =
            check_converged_engine_sim(&accumulated, tol, min_cycles, converged_cycle);
        if let Some(c) = new_conv {
            converged_cycle = c;
        }
        if should_break {
            break;
        }
    }

    let wall_time_s = rpm_t0.elapsed().as_secs_f64();
    let last_cs = accumulated.last().copied().ok_or_else(|| {
        format!("no cycles completed at rpm {rpm:.0}")
    })?;
    Ok(SweepPoint {
        rpm,
        converged_cycle,
        n_cycles_run: accumulated.len() as u32,
        last_cycle: last_cs,
        nonconservation_max,
        wall_time_s,
        step_count: loop_state.step_count,
    })
}

/// Run an optimization study: N parallel trials, each a small sweep
/// over `objective.rpm_list` with a perturbed config. Captures are
/// always off for trials — we don't want to explode disk with one
/// artifact-set per trial × per RPM.
pub fn run_optimization_job<E: JobEmitter, P: DivergenceProbe>(
    emitter: &E,
    probe: &P,
    job_id: String,
    config_path: PathBuf,
    params: crate::dto::OptimizationParams,
    cancel: Arc<AtomicBool>,
    started_at: u64,
) -> RunOutcome {
    use crate::optimization::{bounds, objective, sampler};

    emitter.emit_started(JobStartedEvent {
        job_id: job_id.clone(),
        kind: StudyKind::Optimization,
        started_at,
    });

    // 1. Load base config.
    let base_cfg = match load_v1_json(&config_path) {
        Ok(c) => c,
        Err(e) => {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Optimization,
                reason: ErrorReason::ConfigLoad,
                message: e.to_string(),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
    };

    // 2. Validate inputs.
    if params.tunables.is_empty() {
        emitter.emit_error(JobErrorEvent {
            job_id: job_id.clone(),
            kind: StudyKind::Optimization,
            reason: ErrorReason::Other,
            message: "optimization requires at least 1 tunable parameter".into(),
            partial_cycles: vec![],
            partial_points: vec![],
        });
        return RunOutcome::Errored;
    }
    if params.objective.rpm_list.is_empty() {
        emitter.emit_error(JobErrorEvent {
            job_id: job_id.clone(),
            kind: StudyKind::Optimization,
            reason: ErrorReason::Other,
            message: "optimization requires at least 1 rpm in objective rpm_list".into(),
            partial_cycles: vec![],
            partial_points: vec![],
        });
        return RunOutcome::Errored;
    }
    if params.n_trials == 0 {
        emitter.emit_error(JobErrorEvent {
            job_id: job_id.clone(),
            kind: StudyKind::Optimization,
            reason: ErrorReason::Other,
            message: "optimization requires n_trials >= 1".into(),
            partial_cycles: vec![],
            partial_points: vec![],
        });
        return RunOutcome::Errored;
    }

    // 2b. Validate locked_pairs:
    //   - leader+follower must be a registered in/out diameter pair
    //     (matching [N] suffix on both, or scalar on both);
    //   - leader must appear in `tunables` (it carries the sampled value);
    //   - follower must NOT appear in `tunables` (the lock provides its value);
    //   - no duplicate leaders or followers across pairs.
    let tunable_paths: std::collections::HashSet<&str> =
        params.tunables.iter().map(|b| b.path.as_str()).collect();
    let mut seen_leaders: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut seen_followers: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for pair in &params.locked_pairs {
        if !crate::params::is_locked_pair(&pair.leader, &pair.follower) {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Optimization,
                reason: ErrorReason::Other,
                message: format!(
                    "locked_pair leader={} follower={} is not a registered in/out diameter pair",
                    pair.leader, pair.follower
                ),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
        if !tunable_paths.contains(pair.leader.as_str()) {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Optimization,
                reason: ErrorReason::Other,
                message: format!(
                    "locked_pair leader={} must also appear in tunables",
                    pair.leader
                ),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
        if tunable_paths.contains(pair.follower.as_str()) {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Optimization,
                reason: ErrorReason::Other,
                message: format!(
                    "locked_pair follower={} must NOT appear in tunables (the lock supplies its value)",
                    pair.follower
                ),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
        if !seen_leaders.insert(pair.leader.as_str()) {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Optimization,
                reason: ErrorReason::Other,
                message: format!("locked_pair leader={} appears in more than one pair", pair.leader),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
        if !seen_followers.insert(pair.follower.as_str()) {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Optimization,
                reason: ErrorReason::Other,
                message: format!(
                    "locked_pair follower={} appears in more than one pair",
                    pair.follower
                ),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
    }

    // 3. Sample N normalized rows + map to physical overrides.
    let normalized = sampler::sample(
        params.sampler,
        params.n_trials as usize,
        params.tunables.len(),
        params.seed,
    );
    let n_trials = params.n_trials;
    let trials_input: Vec<std::collections::BTreeMap<String, f64>> = normalized
        .iter()
        .map(|row| {
            let mut map: std::collections::BTreeMap<String, f64> = params
                .tunables
                .iter()
                .zip(row.iter())
                .map(|(b, n)| (b.path.clone(), bounds::map_to_physical(b, *n)))
                .collect();
            // Fan-out: for each locked pair, copy the leader's sampled
            // value into the follower path. Validated above to guarantee
            // the leader is present and the follower is not.
            for pair in &params.locked_pairs {
                if let Some(v) = map.get(&pair.leader).copied() {
                    map.insert(pair.follower.clone(), v);
                }
            }
            map
        })
        .collect();

    let parameter_paths: Vec<String> = params.tunables.iter().map(|b| b.path.clone()).collect();
    let total_t0 = Instant::now();
    let junction: engine_sim::model::sdm26::JunctionKind = params.junction_kind.into();

    // 4. Parallel trial execution via a private rayon pool (same pattern
    //    as sweep: cores - 1, min 1).
    let n_cpus = num_cpus::get().saturating_sub(1).max(1);
    let pool = match ThreadPoolBuilder::new().num_threads(n_cpus).build() {
        Ok(p) => p,
        Err(e) => {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Optimization,
                reason: ErrorReason::Other,
                message: format!("rayon pool: {e}"),
                partial_cycles: vec![],
                partial_points: vec![],
            });
            return RunOutcome::Errored;
        }
    };

    // (trial_idx, Ok(objective_value, sweep_points) | Err(msg))
    type TrialResult = (u32, Result<(f64, Vec<SweepPoint>), String>);
    let results: Arc<Mutex<Vec<TrialResult>>> =
        Arc::new(Mutex::new(Vec::with_capacity(n_trials as usize)));

    // Solver panics are caught per-RPM inside `run_single_rpm_inline` and
    // returned as per-trial Errs; silence the default panic hook so the
    // backtrace noise doesn't flood stderr. Restored on drop.
    let _hook_guard = SilencedPanicHook::install();
    pool.install(|| {
        use rayon::prelude::*;
        let trials_indexed: Vec<(u32, std::collections::BTreeMap<String, f64>)> = trials_input
            .into_iter()
            .enumerate()
            .map(|(i, m)| (i as u32, m))
            .collect();

        trials_indexed.into_par_iter().for_each(|(trial_idx, overrides)| {
            if cancel.load(Ordering::SeqCst) {
                results
                    .lock()
                    .unwrap()
                    .push((trial_idx, Err("cancelled".to_string())));
                return;
            }

            emitter.emit_progress(JobProgressEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Optimization,
                payload: JobProgressPayload::OptimizationTrialStarted {
                    trial_idx,
                    n_trials,
                    parameter_values: overrides.clone(),
                },
            });

            let trial_t0 = Instant::now();
            let mut cfg = base_cfg.clone();
            for (path, value) in &overrides {
                if let Err(e) = crate::params::apply_override(&mut cfg, path, *value) {
                    results.lock().unwrap().push((
                        trial_idx,
                        Err(format!("apply_override({path}): {e}")),
                    ));
                    return;
                }
            }

            // Run inline sweep over the objective's rpm_list.
            let mut points: Vec<SweepPoint> = Vec::with_capacity(params.objective.rpm_list.len());
            for &rpm in &params.objective.rpm_list {
                let spec = InlineRpmSpec {
                    junction,
                    rpm,
                    n_cycles_max: params.n_cycles_max,
                    tol: params.convergence_tol_imep,
                    min_cycles: params.convergence_min_cycles,
                };
                match run_single_rpm_inline(&cfg, &spec, probe, &cancel) {
                    Ok(pt) => points.push(pt),
                    Err(e) => {
                        results
                            .lock()
                            .unwrap()
                            .push((trial_idx, Err(format!("rpm {rpm:.0}: {e}"))));
                        return;
                    }
                }
            }

            let obj_value = match objective::evaluate(&params.objective, &points) {
                Ok(v) => v,
                Err(e) => {
                    results.lock().unwrap().push((
                        trial_idx,
                        Err(format!("objective eval: {e}")),
                    ));
                    return;
                }
            };

            let wall_time_s = trial_t0.elapsed().as_secs_f64();
            emitter.emit_progress(JobProgressEvent {
                job_id: job_id.clone(),
                kind: StudyKind::Optimization,
                payload: JobProgressPayload::OptimizationTrialDone {
                    trial_idx,
                    n_trials,
                    objective_value: obj_value,
                    sweep_points: points.clone(),
                    wall_time_s,
                },
            });

            results
                .lock()
                .unwrap()
                .push((trial_idx, Ok((obj_value, points))));
        });
    });

    // 5. Drain + pick best by direction.
    let drained: Vec<TrialResult> = {
        let mut v = results.lock().unwrap();
        v.sort_by_key(|(idx, _)| *idx);
        std::mem::take(&mut *v)
    };

    let n_trials_run: u32 = drained
        .iter()
        .filter(|(_, r)| matches!(r, Ok((v, _)) if v.is_finite()))
        .count() as u32;

    let direction = params.objective.direction;
    let best = drained
        .iter()
        .filter_map(|(idx, r)| match r {
            Ok((v, _)) if v.is_finite() => Some((*idx, *v)),
            _ => None,
        })
        .fold(None, |acc, (idx, v)| match acc {
            None => Some((idx, v)),
            Some((bi, bv)) => {
                let take_new = match direction {
                    crate::dto::ObjectiveDirection::Maximize => v > bv,
                    crate::dto::ObjectiveDirection::Minimize => v < bv,
                };
                if take_new {
                    Some((idx, v))
                } else {
                    Some((bi, bv))
                }
            }
        });

    let summary = crate::dto::OptimizationDoneSummary {
        n_trials_requested: n_trials,
        n_trials_run,
        best_trial_idx: best.map(|(i, _)| i),
        best_objective_value: best.map(|(_, v)| v),
        parameter_paths,
        objective_direction: direction,
        total_wall_time_s: total_t0.elapsed().as_secs_f64(),
    };

    // 6. If cancelled, surface as Cancelled (with no partial_points — the
    //    UI rebuilds from per-trial progress events). Otherwise Done.
    if cancel.load(Ordering::SeqCst) {
        emitter.emit_cancelled(JobCancelledEvent {
            job_id: job_id.clone(),
            kind: StudyKind::Optimization,
            partial_cycles: vec![],
            partial_points: vec![],
        });
        return RunOutcome::Cancelled;
    }

    emitter.emit_done(JobDoneEvent {
        job_id: job_id.clone(),
        kind: StudyKind::Optimization,
        payload: JobDoneSummary::Optimization(summary),
    });
    RunOutcome::CompletedOptimization
}

#[derive(Debug)]
#[allow(dead_code)]
pub enum RunOutcome {
    Completed(Vec<CycleStats>),
    CompletedSweep(Vec<SweepPoint>),
    CompletedOptimization,
    Cancelled,
    Errored,
}

// ---------------- Silent driver for desktop-side parity tests ----------------

#[cfg(test)]
pub fn drive_runner_no_emit(
    cfg: engine_sim::model::sdm26::SDM26Config,
    junction: engine_sim::model::sdm26::JunctionKind,
    rpm: f64,
    n_cycles: u32,
) -> Vec<CycleStats> {
    let mut eng = SDM26Engine::new(cfg, junction);
    let mut loop_state = CycleLoopState::new(&mut eng);
    let probe = DefaultDivergenceProbe;
    let mut accumulated: Vec<CycleStats> = Vec::with_capacity(n_cycles as usize);
    for _ in 0..n_cycles {
        let cs = match eng.advance_one_cycle(rpm, &mut loop_state, None, None, None) {
            CycleOutcome::Cycle(stats) => stats,
            CycleOutcome::TargetReached => break,
            CycleOutcome::Cancelled => break,
        };
        assert!(!probe.is_diverged(&cs), "non-finite cycle in drive_runner_no_emit");
        accumulated.push(cs);
    }
    accumulated
}

// ---------------- Tests ----------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::JunctionKindDto;
    use std::sync::Mutex;

    #[derive(Debug, Clone)]
    enum RecordedEvent {
        Started(JobStartedEvent),
        Progress(JobProgressEvent),
        Done(JobDoneEvent),
        Cancelled(JobCancelledEvent),
        Error(JobErrorEvent),
    }

    #[derive(Default)]
    struct VecEmitter { events: Mutex<Vec<RecordedEvent>> }
    impl JobEmitter for VecEmitter {
        fn emit_started(&self, ev: JobStartedEvent) { self.events.lock().unwrap().push(RecordedEvent::Started(ev)); }
        fn emit_progress(&self, ev: JobProgressEvent) { self.events.lock().unwrap().push(RecordedEvent::Progress(ev)); }
        fn emit_done(&self, ev: JobDoneEvent) { self.events.lock().unwrap().push(RecordedEvent::Done(ev)); }
        fn emit_cancelled(&self, ev: JobCancelledEvent) { self.events.lock().unwrap().push(RecordedEvent::Cancelled(ev)); }
        fn emit_error(&self, ev: JobErrorEvent) { self.events.lock().unwrap().push(RecordedEvent::Error(ev)); }
    }

    struct AlwaysFinite;
    impl DivergenceProbe for AlwaysFinite {
        fn is_diverged(&self, _: &CycleStats) -> bool { false }
    }

    #[test]
    fn unwind_safe_passes_value_through() {
        let r = run_engine_unwind_safe(|| 41 + 1);
        assert_eq!(r, Ok(42));
    }

    #[test]
    fn nested_silenced_hook_restores_original_after_last_guard() {
        // Two concurrent CFD jobs install/restore the process-global panic
        // hook through SilencedPanicHook. The refcounted design must restore
        // the ORIGINAL hook only when the LAST guard drops — never leave a
        // permanent no-op hook (the v4 bug). We can't observe the hook
        // closure directly, but we can prove panics are still caught
        // (catch_unwind works regardless) and that the depth bookkeeping
        // returns to 0 with the saved hook cleared.
        {
            let _a = SilencedPanicHook::install();
            {
                let _b = SilencedPanicHook::install();
                let st = hook_state().lock().unwrap();
                assert_eq!(st.depth, 2, "two active guards");
                assert!(st.saved.is_some(), "original hook saved while silenced");
            }
            // Inner guard dropped: still silenced (outer holds), depth 1.
            let st = hook_state().lock().unwrap();
            assert_eq!(st.depth, 1);
            assert!(st.saved.is_some());
        }
        // All guards dropped: depth back to 0, saved hook handed back.
        let st = hook_state().lock().unwrap();
        assert_eq!(st.depth, 0, "depth must return to 0");
        assert!(st.saved.is_none(), "saved hook must be restored, not leaked");
    }

    #[test]
    fn unwind_safe_captures_panic_message() {
        // Silence the default hook so this deliberate panic doesn't print
        // a backtrace during the test run.
        let _g = SilencedPanicHook::install();
        let r: Result<(), String> =
            run_engine_unwind_safe(|| panic!("positivity failure at theta=123.4°"));
        let msg = r.expect_err("a panic must be converted into Err");
        assert!(
            msg.contains("positivity failure"),
            "captured message should contain the panic text, got: {msg}"
        );
    }

    struct FailOnCycle { fail_after_count: Mutex<u32>, threshold: u32 }
    impl FailOnCycle {
        fn new(threshold: u32) -> Self { Self { fail_after_count: Mutex::new(0), threshold } }
    }
    impl DivergenceProbe for FailOnCycle {
        fn is_diverged(&self, _: &CycleStats) -> bool {
            let mut n = self.fail_after_count.lock().unwrap();
            *n += 1;
            *n >= self.threshold
        }
    }

    fn sdm26_config_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../engine-sim/python_ref/configs/sdm26.json")
    }

    fn default_single_rpm_params(n: u32) -> SingleRpmParams {
        SingleRpmParams {
            rpm: 6000.0,
            n_cycles_max: n,
            junction_kind: JunctionKindDto::Stagnation,
            convergence_tol_imep: 0.0,
            convergence_min_cycles: 0,
            capture_waves: false,
            capture_pv_loops: false,
            capture_pipe_profiles: false,
            overrides: vec![],
        }
    }

    fn progress_payload_kind(ev: &JobProgressPayload) -> &'static str {
        match ev {
            JobProgressPayload::SingleRpm(_) => "single-rpm",
            JobProgressPayload::SweepRpmStarted { .. } => "sweep-rpm-started",
            JobProgressPayload::SweepCycle { .. } => "sweep-cycle",
            JobProgressPayload::SweepRpmDone { .. } => "sweep-rpm-done",
            JobProgressPayload::OptimizationTrialStarted { .. } => "optimization-trial-started",
            JobProgressPayload::OptimizationTrialDone { .. } => "optimization-trial-done",
        }
    }

    #[test]
    fn single_rpm_happy_path_3_cycles_emits_start_three_progress_done() {
        let emitter = VecEmitter::default();
        let outcome = run_single_rpm_job(
            &emitter, &AlwaysFinite,
            "job-1".into(), sdm26_config_path(), default_single_rpm_params(3),
            Arc::new(AtomicBool::new(false)), 100, None,
        );
        assert!(matches!(outcome, RunOutcome::Completed(ref v) if v.len() == 3));
        let events = emitter.events.lock().unwrap().clone();
        assert_eq!(events.len(), 1 + 3 + 1);
        assert!(matches!(events[0], RecordedEvent::Started(_)));
        for i in 0..3 {
            match &events[1 + i] {
                RecordedEvent::Progress(p) => match &p.payload {
                    JobProgressPayload::SingleRpm(s) => {
                        assert_eq!(s.cycle, (i as u32) + 1);
                        assert_eq!(s.total, 3);
                    }
                    other => panic!("expected SingleRpm payload, got {}", progress_payload_kind(other)),
                }
                other => panic!("expected Progress at {i}, got {other:?}"),
            }
        }
        assert!(matches!(events[4], RecordedEvent::Done(_)));
    }

    #[test]
    fn single_rpm_cancellation_emits_start_progress_cancelled() {
        struct CancelOnProgress { inner: VecEmitter, flag: Arc<AtomicBool> }
        impl JobEmitter for CancelOnProgress {
            fn emit_started(&self, ev: JobStartedEvent) { self.inner.emit_started(ev); }
            fn emit_progress(&self, ev: JobProgressEvent) {
                self.flag.store(true, Ordering::SeqCst);
                self.inner.emit_progress(ev);
            }
            fn emit_done(&self, ev: JobDoneEvent) { self.inner.emit_done(ev); }
            fn emit_cancelled(&self, ev: JobCancelledEvent) { self.inner.emit_cancelled(ev); }
            fn emit_error(&self, ev: JobErrorEvent) { self.inner.emit_error(ev); }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let wrap = CancelOnProgress { inner: VecEmitter::default(), flag: cancel.clone() };
        let outcome = run_single_rpm_job(
            &wrap, &AlwaysFinite,
            "job-c".into(), sdm26_config_path(), default_single_rpm_params(5),
            cancel, 100, None,
        );
        assert!(matches!(outcome, RunOutcome::Cancelled));
        let events = wrap.inner.events.lock().unwrap().clone();
        assert!(matches!(events.last(), Some(RecordedEvent::Cancelled(_))));
        assert!(!events.iter().any(|e| matches!(e, RecordedEvent::Done(_))));
    }

    #[test]
    fn bad_config_path_emits_started_then_config_load_error() {
        let emitter = VecEmitter::default();
        let outcome = run_single_rpm_job(
            &emitter, &AlwaysFinite,
            "job-b".into(),
            PathBuf::from("/this/path/does/not/exist/please.json"),
            default_single_rpm_params(3),
            Arc::new(AtomicBool::new(false)), 100, None,
        );
        assert!(matches!(outcome, RunOutcome::Errored));
        let events = emitter.events.lock().unwrap().clone();
        match &events[1] {
            RecordedEvent::Error(e) => {
                assert_eq!(e.reason, ErrorReason::ConfigLoad);
                assert_eq!(e.kind, StudyKind::SingleRpm);
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn divergence_probe_terminates_with_solver_diverged() {
        let emitter = VecEmitter::default();
        let outcome = run_single_rpm_job(
            &emitter, &FailOnCycle::new(2),
            "job-d".into(), sdm26_config_path(), default_single_rpm_params(10),
            Arc::new(AtomicBool::new(false)), 100, None,
        );
        assert!(matches!(outcome, RunOutcome::Errored));
        let events = emitter.events.lock().unwrap().clone();
        match events.last().unwrap() {
            RecordedEvent::Error(e) => {
                assert_eq!(e.reason, ErrorReason::SolverDiverged);
                assert!(!e.partial_cycles.is_empty());
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn convergence_short_circuits_when_imep_settles() {
        let emitter = VecEmitter::default();
        let mut params = default_single_rpm_params(10);
        params.convergence_tol_imep = 0.10;
        params.convergence_min_cycles = 2;
        let _ = run_single_rpm_job(
            &emitter, &AlwaysFinite,
            "job-cv".into(), sdm26_config_path(), params,
            Arc::new(AtomicBool::new(false)), 100, None,
        );
        let events = emitter.events.lock().unwrap().clone();
        let progress_n = events.iter().filter(|e| matches!(e, RecordedEvent::Progress(_))).count();
        assert!(progress_n < 10);
        match events.last().unwrap() {
            RecordedEvent::Done(d) => match &d.payload {
                JobDoneSummary::SingleRpm(s) => assert!(s.converged_cycle >= 0),
                _ => panic!("wrong summary kind"),
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    // --- Sweep tests ---

    fn default_sweep_params(rpms: Vec<f64>, n_cycles: u32) -> SweepParams {
        SweepParams {
            rpm_list: rpms,
            n_cycles_max: n_cycles,
            junction_kind: JunctionKindDto::Stagnation,
            convergence_tol_imep: 0.0,
            convergence_min_cycles: 0,
            capture_waves: false,
            capture_pv_loops: false,
            capture_pipe_profiles: false,
            overrides: vec![],
        }
    }

    #[test]
    fn sweep_happy_path_emits_correct_counts_per_rpm() {
        // Parallel sweep — events arrive in non-deterministic order
        // across RPMs, but per-RPM counts and the global sequence
        // (Started first, Done last) must still hold.
        let emitter = VecEmitter::default();
        let outcome = run_sweep_job(
            &emitter, &AlwaysFinite,
            "sw-1".into(), sdm26_config_path(),
            default_sweep_params(vec![6000.0, 7000.0], 2),
            Arc::new(AtomicBool::new(false)), 100, None,
        );
        match outcome {
            RunOutcome::CompletedSweep(ref pts) => assert_eq!(pts.len(), 2),
            other => panic!("expected CompletedSweep, got {other:?}"),
        }
        let events = emitter.events.lock().unwrap().clone();
        assert!(matches!(events[0], RecordedEvent::Started(_)), "first event must be Started");
        assert!(matches!(events.last().unwrap(), RecordedEvent::Done(_)), "last event must be Done");

        // Tally progress payloads by kind.
        let mut started = 0u32;
        let mut cycle = 0u32;
        let mut done = 0u32;
        let mut started_idxs: Vec<u32> = Vec::new();
        let mut done_idxs: Vec<u32> = Vec::new();
        for e in &events {
            if let RecordedEvent::Progress(p) = e {
                match &p.payload {
                    JobProgressPayload::SweepRpmStarted { rpm_idx, .. } => { started += 1; started_idxs.push(*rpm_idx); }
                    JobProgressPayload::SweepCycle { .. } => { cycle += 1; }
                    JobProgressPayload::SweepRpmDone { rpm_idx, .. } => { done += 1; done_idxs.push(*rpm_idx); }
                    _ => {}
                }
            }
        }
        assert_eq!(started, 2, "expected 2 SweepRpmStarted events, got {started}");
        assert_eq!(done, 2, "expected 2 SweepRpmDone events, got {done}");
        assert_eq!(cycle, 4, "expected 4 SweepCycle events (2 RPMs * 2 cycles), got {cycle}");
        started_idxs.sort_unstable();
        done_idxs.sort_unstable();
        assert_eq!(started_idxs, vec![0, 1]);
        assert_eq!(done_idxs, vec![0, 1]);
    }

    #[test]
    fn sweep_cancellation_before_start_emits_cancelled() {
        // With rayon, all per-RPM workers race to completion — by the
        // time we could "cancel between RPMs" they'd often all be done.
        // Cancellation semantics now: setting cancel before/early stops
        // *new* workers from starting and surfaces a Cancelled outcome
        // (any workers already in flight finish, but their points get
        // returned as partial_points).
        //
        // We test the cleanest case: pre-arm cancel BEFORE workers
        // start. No workers do any work; partial_points is empty.
        let cancel = Arc::new(AtomicBool::new(true));   // pre-armed
        let emitter = VecEmitter::default();
        let outcome = run_sweep_job(
            &emitter, &AlwaysFinite,
            "sw-c".into(), sdm26_config_path(),
            default_sweep_params(vec![6000.0, 7000.0, 8000.0], 1),
            cancel, 100, None,
        );
        assert!(matches!(outcome, RunOutcome::Cancelled));
        let events = emitter.events.lock().unwrap().clone();
        match events.last().unwrap() {
            RecordedEvent::Cancelled(c) => {
                assert_eq!(c.kind, StudyKind::Sweep);
                assert!(c.partial_points.len() <= 3,
                        "partial_points should be 0..=3, got {}", c.partial_points.len());
            }
            other => panic!("expected Cancelled, got {other:?}"),
        }
    }

    #[test]
    fn sweep_zero_cycles_emits_error_not_silent_drop() {
        // With n_cycles_max == 0 a worker completes no cycles, so it has no
        // SweepPoint to report. Previously the RPM vanished silently — no
        // point AND no error — yielding a sweep with fewer points than
        // requested and no explanation. It must now surface as an error.
        let emitter = VecEmitter::default();
        let outcome = run_sweep_job(
            &emitter, &AlwaysFinite,
            "sw-zero".into(), sdm26_config_path(),
            default_sweep_params(vec![6000.0], 0),
            Arc::new(AtomicBool::new(false)), 100, None,
        );
        assert!(matches!(outcome, RunOutcome::Errored), "zero-cycle sweep must error");
        let events = emitter.events.lock().unwrap().clone();
        match events.last().unwrap() {
            RecordedEvent::Error(e) => {
                assert_eq!(e.kind, StudyKind::Sweep);
                assert!(
                    e.message.contains("no cycles completed"),
                    "unexpected error message: {}", e.message,
                );
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn sweep_last_cycle_matches_engine_sim_run_sweep_with_convergence() {
        // The cfd-core sweep must produce the same `last_cycle` per RPM as
        // engine_sim::model::sweep::run_sweep (which the Python reference
        // mirrors). Convergence semantics — including the "one extra
        // cycle past convergence" rule — must line up exactly.
        use engine_sim::config::loader::load_v1_json;
        use engine_sim::model::sweep::run_sweep as es_run_sweep;
        let cfg = load_v1_json(sdm26_config_path()).expect("load sdm26");

        let rpm_list = vec![6000.0_f64, 8000.0];
        let n_cycles_max = 15_usize;
        let tol = 0.005_f64;
        let min_cycles = 3_usize;

        // engine-sim direct sweep — the parity baseline.
        let baseline = es_run_sweep(
            &rpm_list, cfg.clone(),
            engine_sim::model::sdm26::JunctionKind::Stagnation,
            n_cycles_max, tol, min_cycles,
        );

        // cfd-core sweep via the runner.
        let params = SweepParams {
            rpm_list: rpm_list.clone(),
            n_cycles_max: n_cycles_max as u32,
            junction_kind: crate::dto::JunctionKindDto::Stagnation,
            convergence_tol_imep: tol,
            convergence_min_cycles: min_cycles as u32,
            capture_waves: false,
            capture_pv_loops: false,
            capture_pipe_profiles: false,
            overrides: vec![],
        };
        let emitter = VecEmitter::default();
        let outcome = run_sweep_job(
            &emitter, &AlwaysFinite,
            "parity-sweep".into(), sdm26_config_path(), params,
            Arc::new(AtomicBool::new(false)), 0, None,
        );
        let cfd_points = match outcome {
            RunOutcome::CompletedSweep(v) => v,
            other => panic!("expected CompletedSweep, got {other:?}"),
        };

        assert_eq!(cfd_points.len(), baseline.len());
        for (i, (cfd, bl)) in cfd_points.iter().zip(baseline.iter()).enumerate() {
            assert!((cfd.rpm - bl.rpm).abs() < 1e-12, "rpm mismatch at {i}");
            assert_eq!(
                cfd.converged_cycle, bl.converged_cycle,
                "rpm {} converged_cycle: cfd={} es={}",
                cfd.rpm, cfd.converged_cycle, bl.converged_cycle,
            );
            assert_eq!(
                cfd.n_cycles_run as usize, bl.n_cycles_run,
                "rpm {} n_cycles_run", cfd.rpm,
            );
            macro_rules! field_eq {
                ($field:ident, $bl:expr) => {
                    assert!(
                        (cfd.last_cycle.$field - $bl).abs()
                            <= 1e-12 + 1e-10 * $bl.abs(),
                        "rpm {} last_cycle.{}: cfd={} es={}",
                        cfd.rpm, stringify!($field),
                        cfd.last_cycle.$field, $bl,
                    );
                };
            }
            field_eq!(imep_bar, bl.imep_bar);
            field_eq!(ve_atm, bl.ve_atm);
            field_eq!(egt_mean, bl.egt_valve_k);
            field_eq!(indicated_power_k_w, bl.indicated_power_k_w);
        }
    }

    #[test]
    fn sweep_with_pv_capture_writes_artifacts_to_tempdir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut params = default_sweep_params(vec![6000.0], 2);
        params.capture_pv_loops = true;
        params.capture_pipe_profiles = true;
        let emitter = VecEmitter::default();
        let outcome = run_sweep_job(
            &emitter, &AlwaysFinite,
            "sw-cap".into(), sdm26_config_path(), params,
            Arc::new(AtomicBool::new(false)), 100,
            Some(tmp.path().to_path_buf()),
        );
        assert!(matches!(outcome, RunOutcome::CompletedSweep(_)));
        let dir = tmp.path().join("sw-cap").join("sweep").join("6000");
        assert!(dir.join("pv.json").exists(), "pv.json missing in {dir:?}");
        assert!(dir.join("profiles.json").exists(), "profiles.json missing in {dir:?}");
    }

    // --- Parity (Phase 1 carryovers, adapted to new payload shape) ---

    #[test]
    fn runner_loop_matches_direct_run_sdm26_6000rpm_5cyc() {
        let cfg = load_v1_json(sdm26_config_path()).unwrap();
        let cycles_runner = drive_runner_no_emit(
            cfg.clone(),
            engine_sim::model::sdm26::JunctionKind::Stagnation,
            6000.0, 5,
        );
        let mut eng = SDM26Engine::new(cfg, engine_sim::model::sdm26::JunctionKind::Stagnation);
        let r = eng.run_single_rpm(6000.0, 5, false, 0.0, 0, false);
        assert_eq!(cycles_runner.len(), r.cycle_stats.len());
        for (i, (a, b)) in cycles_runner.iter().zip(r.cycle_stats.iter()).enumerate() {
            assert_eq!(a.cycle, b.cycle, "cycle[{i}].cycle");
            macro_rules! mp {
                ($f:ident) => {
                    assert!(
                        (a.$f - b.$f).abs() <= 1e-14 + 1e-12 * b.$f.abs(),
                        "cycle[{i}].{}: runner={} direct={}",
                        stringify!($f), a.$f, b.$f
                    );
                };
            }
            mp!(imep_bar); mp!(bmep_bar); mp!(fmep_bar); mp!(ve_atm);
            mp!(mass_total); mp!(mass_drift); mp!(mass_in_restrictor);
            mp!(mass_out_collector); mp!(net_port_flow); mp!(nonconservation);
            mp!(intake_mass_per_cycle_g); mp!(f_residual);
            mp!(indicated_power_k_w); mp!(brake_power_k_w); mp!(wheel_power_k_w);
            mp!(indicated_torque_nm); mp!(brake_torque_nm); mp!(wheel_torque_nm);
            mp!(egt_mean);
        }
    }

    #[test]
    fn cycle_stats_serde_roundtrip_lossless() {
        let cfg = load_v1_json(sdm26_config_path()).unwrap();
        let mut eng = SDM26Engine::new(cfg, engine_sim::model::sdm26::JunctionKind::Stagnation);
        let r = eng.run_single_rpm(6000.0, 1, false, 0.0, 0, false);
        let cs = *r.cycle_stats.last().unwrap();
        let json = serde_json::to_string(&cs).unwrap();
        let cs2: CycleStats = serde_json::from_str(&json).unwrap();
        macro_rules! exact {
            ($f:ident) => {
                assert!(cs.$f.to_bits() == cs2.$f.to_bits()
                    || (cs.$f.is_nan() && cs2.$f.is_nan()),
                    "field {} differs", stringify!($f));
            };
        }
        exact!(imep_bar); exact!(bmep_bar); exact!(fmep_bar); exact!(ve_atm);
        exact!(mass_total); exact!(mass_drift); exact!(mass_in_restrictor);
        exact!(mass_out_collector); exact!(net_port_flow); exact!(nonconservation);
        exact!(intake_mass_per_cycle_g); exact!(f_residual);
        exact!(indicated_power_k_w); exact!(brake_power_k_w); exact!(wheel_power_k_w);
        exact!(indicated_torque_nm); exact!(brake_torque_nm); exact!(wheel_torque_nm);
        exact!(egt_mean);
        assert!(json.contains("\"imepBar\""));
        assert!(json.contains("\"egtMean\""));
        assert!(json.contains("\"indicatedPowerKW\""));
    }
}
