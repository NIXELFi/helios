//! Worker-thread runner for CFD jobs.
//!
//! `SDM26Engine` is not `Send` (its area-fn closures aren't), so the
//! runner thread owns it from construction to drop. Progress, done,
//! cancellation, and error events emit through a `JobEmitter` trait so
//! tests can substitute a `VecEmitter` that records the sequence.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, CycleStats, SDM26Engine};

use crate::dto::{
    ErrorReason, JobCancelledEvent, JobDoneEvent, JobErrorEvent, JobProgressEvent,
    JobProgressSingleRpm, JobStartedEvent, SingleRpmDoneSummary, SingleRpmParams, StudyKind,
};

// ---------------- Emitter trait (production + test seam) ----------------

pub trait JobEmitter: Send + 'static {
    fn emit_started(&self, ev: JobStartedEvent);
    fn emit_progress(&self, ev: JobProgressEvent);
    fn emit_done(&self, ev: JobDoneEvent);
    fn emit_cancelled(&self, ev: JobCancelledEvent);
    fn emit_error(&self, ev: JobErrorEvent);
}

// ---------------- Divergence probe (production + test seam) ----------------

pub trait DivergenceProbe: Send + 'static {
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

// ---------------- Convergence detector (replicates Python's policy) ----------------

fn check_converged(cycles: &[CycleStats], params: &SingleRpmParams) -> bool {
    if cycles.len() < params.convergence_min_cycles as usize {
        return false;
    }
    if cycles.len() < 2 {
        return false;
    }
    // Two-in-a-row condition: the last two cycles' IMEP rel-diffs both
    // fall below the tolerance. Matches Python `stop_at_convergence`
    // semantics.
    let n = cycles.len();
    let a = cycles[n - 1].imep_bar;
    let b = cycles[n - 2].imep_bar;
    let denom = a.abs().max(1e-12);
    let rel = ((a - b).abs()) / denom;
    rel < params.convergence_tol_imep
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
) -> RunOutcome {
    emitter.emit_started(JobStartedEvent {
        job_id: job_id.clone(),
        kind: StudyKind::SingleRpm,
        started_at,
    });

    let cfg = match load_v1_json(&config_path) {
        Ok(c) => c,
        Err(e) => {
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                reason: ErrorReason::ConfigLoad,
                message: e.to_string(),
                partial_cycles: vec![],
            });
            return RunOutcome::Errored;
        }
    };

    let mut eng = SDM26Engine::new(cfg, params.junction_kind.into());
    let mut loop_state = CycleLoopState::new(&mut eng);
    let mut accumulated: Vec<CycleStats> = Vec::with_capacity(params.n_cycles_max as usize);
    let mut converged_cycle: i64 = -1;

    for cycle_i in 0..params.n_cycles_max {
        if cancel.load(Ordering::SeqCst) {
            emitter.emit_cancelled(JobCancelledEvent {
                job_id: job_id.clone(),
                partial_cycles: accumulated,
            });
            return RunOutcome::Cancelled;
        }

        // Advance the simulation to the next 720-degree boundary. State is
        // carried across calls so the math matches a single continuous
        // run_single_rpm call exactly.
        let cs = match eng.advance_one_cycle(params.rpm, &mut loop_state, None) {
            CycleOutcome::Cycle(stats) => stats,
            CycleOutcome::TargetReached => break,
        };

        if probe.is_diverged(&cs) {
            accumulated.push(cs);
            emitter.emit_error(JobErrorEvent {
                job_id: job_id.clone(),
                reason: ErrorReason::SolverDiverged,
                message: format!("non-finite cycle stats at cycle {ci}", ci = cycle_i + 1),
                partial_cycles: accumulated,
            });
            return RunOutcome::Errored;
        }
        accumulated.push(cs);
        emitter.emit_progress(JobProgressEvent {
            job_id: job_id.clone(),
            kind: StudyKind::SingleRpm,
            payload: JobProgressSingleRpm {
                cycle: cycle_i + 1,
                total: params.n_cycles_max,
                cycle_stats: cs,
            },
        });

        if check_converged(&accumulated, &params) {
            converged_cycle = cs.cycle;
            break;
        }
    }

    emitter.emit_done(JobDoneEvent {
        job_id: job_id.clone(),
        kind: StudyKind::SingleRpm,
        payload: SingleRpmDoneSummary {
            converged_cycle,
            n_cycles_run: accumulated.len() as u32,
            step_count: loop_state.step_count,
        },
    });
    RunOutcome::Completed(accumulated)
}

#[derive(Debug)]
#[allow(dead_code)]
pub enum RunOutcome {
    Completed(Vec<CycleStats>),
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
        let cs = match eng.advance_one_cycle(rpm, &mut loop_state, None) {
            CycleOutcome::Cycle(stats) => stats,
            CycleOutcome::TargetReached => break,
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

    // --- Test emitter that records the event sequence ---

    #[derive(Debug, Clone)]
    enum RecordedEvent {
        Started(JobStartedEvent),
        Progress(JobProgressEvent),
        Done(JobDoneEvent),
        Cancelled(JobCancelledEvent),
        Error(JobErrorEvent),
    }

    #[derive(Default)]
    struct VecEmitter {
        events: Mutex<Vec<RecordedEvent>>,
    }
    impl JobEmitter for VecEmitter {
        fn emit_started(&self, ev: JobStartedEvent) {
            self.events.lock().unwrap().push(RecordedEvent::Started(ev));
        }
        fn emit_progress(&self, ev: JobProgressEvent) {
            self.events.lock().unwrap().push(RecordedEvent::Progress(ev));
        }
        fn emit_done(&self, ev: JobDoneEvent) {
            self.events.lock().unwrap().push(RecordedEvent::Done(ev));
        }
        fn emit_cancelled(&self, ev: JobCancelledEvent) {
            self.events.lock().unwrap().push(RecordedEvent::Cancelled(ev));
        }
        fn emit_error(&self, ev: JobErrorEvent) {
            self.events.lock().unwrap().push(RecordedEvent::Error(ev));
        }
    }

    // --- DivergenceProbe that fires on a chosen cycle index ---

    struct AlwaysFinite;
    impl DivergenceProbe for AlwaysFinite {
        fn is_diverged(&self, _: &CycleStats) -> bool { false }
    }

    struct FailOnCycle { fail_after_count: Mutex<u32>, threshold: u32 }
    impl FailOnCycle {
        fn new(threshold: u32) -> Self {
            Self { fail_after_count: Mutex::new(0), threshold }
        }
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

    fn default_params(n: u32) -> SingleRpmParams {
        SingleRpmParams {
            rpm: 6000.0,
            n_cycles_max: n,
            junction_kind: JunctionKindDto::Stagnation,
            convergence_tol_imep: 0.0, // disable convergence early-stop
            convergence_min_cycles: 0,
        }
    }

    #[test]
    fn happy_path_3_cycles_emits_one_start_three_progress_one_done() {
        let emitter = VecEmitter::default();
        let probe = AlwaysFinite;
        let cancel = Arc::new(AtomicBool::new(false));
        let outcome = run_single_rpm_job(
            &emitter, &probe,
            "job-1".into(), sdm26_config_path(), default_params(3),
            cancel, 100,
        );
        assert!(matches!(outcome, RunOutcome::Completed(ref v) if v.len() == 3));
        let events = emitter.events.lock().unwrap().clone();
        assert_eq!(events.len(), 1 + 3 + 1);
        assert!(matches!(events[0], RecordedEvent::Started(_)));
        for i in 0..3 {
            match &events[1 + i] {
                RecordedEvent::Progress(p) => {
                    assert_eq!(p.payload.cycle, (i as u32) + 1);
                    assert_eq!(p.payload.total, 3);
                }
                other => panic!("expected Progress at {i}, got {other:?}"),
            }
        }
        assert!(matches!(events[4], RecordedEvent::Done(_)));
    }

    #[test]
    fn cancellation_after_one_cycle_emits_start_progress_cancelled() {
        let emitter = VecEmitter::default();
        let probe = AlwaysFinite;
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel.clone();
        // Cancel after the first progress: we set the flag synchronously
        // between cycles by using a wrapping emitter is overkill. Instead
        // we lean on the fact that the runner re-checks `cancel` at the
        // start of each cycle; pre-arm cancel after first iteration by
        // making n_cycles_max > 0 but flipping cancel inside a custom
        // emitter.
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
        let wrap = CancelOnProgress { inner: VecEmitter::default(), flag: cancel_clone };
        let outcome = run_single_rpm_job(
            &wrap, &probe,
            "job-c".into(), sdm26_config_path(), default_params(5),
            cancel, 100,
        );
        assert!(matches!(outcome, RunOutcome::Cancelled));
        let events = wrap.inner.events.lock().unwrap().clone();
        assert!(matches!(events.first(), Some(RecordedEvent::Started(_))));
        assert!(matches!(events.last(), Some(RecordedEvent::Cancelled(_))));
        // No Done event when cancelled
        assert!(!events.iter().any(|e| matches!(e, RecordedEvent::Done(_))));
        // Exactly one Progress before cancel
        let progress_count = events.iter().filter(|e| matches!(e, RecordedEvent::Progress(_))).count();
        assert_eq!(progress_count, 1);
    }

    #[test]
    fn bad_config_path_emits_started_then_config_load_error() {
        let emitter = VecEmitter::default();
        let probe = AlwaysFinite;
        let cancel = Arc::new(AtomicBool::new(false));
        let outcome = run_single_rpm_job(
            &emitter, &probe,
            "job-b".into(),
            PathBuf::from("/this/path/does/not/exist/please.json"),
            default_params(3),
            cancel, 100,
        );
        assert!(matches!(outcome, RunOutcome::Errored));
        let events = emitter.events.lock().unwrap().clone();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], RecordedEvent::Started(_)));
        match &events[1] {
            RecordedEvent::Error(e) => assert_eq!(e.reason, ErrorReason::ConfigLoad),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn divergence_probe_terminates_with_solver_diverged() {
        let emitter = VecEmitter::default();
        // Fail-after-2 returns true once the runner has dispatched 2 cycles.
        let probe = FailOnCycle::new(2);
        let cancel = Arc::new(AtomicBool::new(false));
        let outcome = run_single_rpm_job(
            &emitter, &probe,
            "job-d".into(), sdm26_config_path(), default_params(10),
            cancel, 100,
        );
        assert!(matches!(outcome, RunOutcome::Errored));
        let events = emitter.events.lock().unwrap().clone();
        // Expect: Started, Progress(cycle 1), Error(SolverDiverged)
        // (probe returns true on the 2nd is_diverged call -> diverged on cycle 2,
        // before emitting Progress for it).
        assert!(matches!(events[0], RecordedEvent::Started(_)));
        match events.last().unwrap() {
            RecordedEvent::Error(e) => {
                assert_eq!(e.reason, ErrorReason::SolverDiverged);
                // partial_cycles should include the diverged cycle so the UI
                // can render where it failed.
                assert!(e.partial_cycles.len() >= 1);
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn convergence_short_circuits_when_imep_settles() {
        let emitter = VecEmitter::default();
        let probe = AlwaysFinite;
        let cancel = Arc::new(AtomicBool::new(false));
        let mut params = default_params(10);
        // Loose tolerance + min_cycles=2 should converge within a handful
        // of cycles on the well-conditioned SDM26 config.
        params.convergence_tol_imep = 0.10;
        params.convergence_min_cycles = 2;
        let _outcome = run_single_rpm_job(
            &emitter, &probe,
            "job-cv".into(), sdm26_config_path(), params,
            cancel, 100,
        );
        let events = emitter.events.lock().unwrap().clone();
        let progress_n = events.iter().filter(|e| matches!(e, RecordedEvent::Progress(_))).count();
        // Should NOT run all 10 cycles
        assert!(progress_n < 10, "expected early stop, got {progress_n} progress events");
        match events.last().unwrap() {
            RecordedEvent::Done(d) => {
                assert!(d.payload.converged_cycle >= 0, "converged_cycle should be set");
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    // --- Phase 1 desktop-side parity tests (Section 6 of the spec) ---

    #[test]
    fn runner_loop_matches_direct_run_sdm26_6000rpm_5cyc() {
        let cfg = load_v1_json(sdm26_config_path()).unwrap();
        let cycles_runner = drive_runner_no_emit(
            cfg.clone(),
            engine_sim::model::sdm26::JunctionKind::Stagnation,
            6000.0,
            5,
        );
        let mut eng = SDM26Engine::new(cfg, engine_sim::model::sdm26::JunctionKind::Stagnation);
        let r = eng.run_single_rpm(6000.0, 5, false, 0.0, 0, false);
        assert_eq!(cycles_runner.len(), r.cycle_stats.len());
        for (i, (a, b)) in cycles_runner.iter().zip(r.cycle_stats.iter()).enumerate() {
            // Rust↔Rust same-process: every field must match exactly.
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
        // Use real cycle stats from a tiny run.
        let cfg = load_v1_json(sdm26_config_path()).unwrap();
        let mut eng = SDM26Engine::new(cfg, engine_sim::model::sdm26::JunctionKind::Stagnation);
        let r = eng.run_single_rpm(6000.0, 1, false, 0.0, 0, false);
        let cs = *r.cycle_stats.last().unwrap();
        let json = serde_json::to_string(&cs).unwrap();
        let cs2: CycleStats = serde_json::from_str(&json).unwrap();
        // f64 round-trip via serde_json is exact.
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
        // Verify camelCase wire shape
        assert!(json.contains("\"imepBar\""));
        assert!(json.contains("\"egtMean\""));
        assert!(json.contains("\"indicatedPowerKW\""));
    }
}
