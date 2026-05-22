//! End-to-end optimization runner test on SDM26.
//!
//! Drives `run_optimization_job` with a CollectEmitter that captures every
//! event, then asserts the per-trial event counts, best-trial selection,
//! and (cheap) parameter-application semantics.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use cfd_core::dto::{
    JobCancelledEvent, JobDoneEvent, JobDoneSummary, JobErrorEvent, JobProgressEvent,
    JobProgressPayload, JobStartedEvent, JunctionKindDto, ObjectiveAggregator, ObjectiveDirection,
    ObjectiveSpec, OptimizationParams, ParameterBounds, SamplerKind,
};
use cfd_core::runner::{
    run_optimization_job, DefaultDivergenceProbe, JobEmitter, RunOutcome,
};

// Capture-all emitter — records every event so we can assert per-kind
// counts. Mirrors the VecEmitter pattern from the runner unit tests.
// The Started/Cancelled payloads are only inspected via Debug for
// failure messages — silence the dead_code warning rather than
// destructure fields we don't care about.
#[allow(dead_code)]
#[derive(Debug, Clone)]
enum Event {
    Started(JobStartedEvent),
    Progress(JobProgressEvent),
    Done(JobDoneEvent),
    Cancelled(JobCancelledEvent),
    Error(JobErrorEvent),
}

#[derive(Default)]
struct CollectEmitter {
    events: Mutex<Vec<Event>>,
}

impl JobEmitter for CollectEmitter {
    fn emit_started(&self, ev: JobStartedEvent) {
        self.events.lock().unwrap().push(Event::Started(ev));
    }
    fn emit_progress(&self, ev: JobProgressEvent) {
        self.events.lock().unwrap().push(Event::Progress(ev));
    }
    fn emit_done(&self, ev: JobDoneEvent) {
        self.events.lock().unwrap().push(Event::Done(ev));
    }
    fn emit_cancelled(&self, ev: JobCancelledEvent) {
        self.events.lock().unwrap().push(Event::Cancelled(ev));
    }
    fn emit_error(&self, ev: JobErrorEvent) {
        self.events.lock().unwrap().push(Event::Error(ev));
    }
}

/// Resolve the SDM26 config path. Prefer the bundled resources copy,
/// fall back to engine-sim's python_ref/configs which is vendored in-repo
/// and always present. Matches the lookup logic used by params.rs tests.
fn sdm26_config_path() -> PathBuf {
    let candidates = [
        "../../apps/desktop/src-tauri/resources/cfd/configs/sdm26.json",
        "../engine-sim/python_ref/configs/sdm26.json",
    ];
    for c in candidates {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(c);
        if p.exists() {
            return p;
        }
    }
    panic!("could not locate sdm26.json from cfd-core/tests/");
}

fn small_params(
    tunables: Vec<ParameterBounds>,
    rpm_list: Vec<f64>,
    n_trials: u32,
    seed: Option<u64>,
) -> OptimizationParams {
    OptimizationParams {
        tunables,
        objective: ObjectiveSpec {
            metric: "imep_bar".into(),
            aggregator: ObjectiveAggregator::Max,
            rpm_list,
            direction: ObjectiveDirection::Maximize,
        },
        n_trials,
        sampler: SamplerKind::Lhs,
        seed,
        n_cycles_max: 3,
        junction_kind: JunctionKindDto::Stagnation,
        convergence_tol_imep: 0.01,
        convergence_min_cycles: 2,
    }
}

#[test]
fn optimization_runs_4_trials_with_restrictor_cd() {
    let emitter = CollectEmitter::default();
    let probe = DefaultDivergenceProbe;
    let params = small_params(
        vec![ParameterBounds {
            path: "restrictor_cd".into(),
            min: 0.80,
            max: 0.95,
            step: None,
        }],
        vec![6000.0, 8000.0],
        4,
        Some(42),
    );

    let outcome = run_optimization_job(
        &emitter,
        &probe,
        "test-opt-1".into(),
        sdm26_config_path(),
        params,
        Arc::new(AtomicBool::new(false)),
        100,
    );
    assert!(matches!(outcome, RunOutcome::CompletedOptimization));

    let events = emitter.events.lock().unwrap().clone();
    // Started first, Done last.
    assert!(matches!(events.first(), Some(Event::Started(_))));
    assert!(matches!(events.last(), Some(Event::Done(_))));

    // Count per-kind progress payloads.
    let mut started_trials = 0u32;
    let mut done_trials = 0u32;
    let mut started_idxs: Vec<u32> = Vec::new();
    let mut done_idxs: Vec<u32> = Vec::new();
    for e in &events {
        if let Event::Progress(p) = e {
            match &p.payload {
                JobProgressPayload::OptimizationTrialStarted {
                    trial_idx,
                    n_trials,
                    ..
                } => {
                    started_trials += 1;
                    started_idxs.push(*trial_idx);
                    assert_eq!(*n_trials, 4);
                }
                JobProgressPayload::OptimizationTrialDone {
                    trial_idx,
                    n_trials,
                    sweep_points,
                    objective_value,
                    ..
                } => {
                    done_trials += 1;
                    done_idxs.push(*trial_idx);
                    assert_eq!(*n_trials, 4);
                    assert_eq!(sweep_points.len(), 2, "expected 2 RPMs per trial");
                    assert!(objective_value.is_finite(), "objective should be finite");
                }
                _ => {}
            }
        }
    }
    assert_eq!(started_trials, 4);
    assert_eq!(done_trials, 4);
    started_idxs.sort_unstable();
    done_idxs.sort_unstable();
    assert_eq!(started_idxs, vec![0, 1, 2, 3]);
    assert_eq!(done_idxs, vec![0, 1, 2, 3]);

    // Verify summary contents.
    let summary = match events.last().unwrap() {
        Event::Done(d) => d.payload.clone(),
        _ => panic!("expected Done last"),
    };
    match summary {
        JobDoneSummary::Optimization(s) => {
            assert_eq!(s.n_trials_requested, 4);
            assert_eq!(s.n_trials_run, 4);
            assert!(s.best_trial_idx.is_some());
            let best = s.best_objective_value.unwrap();
            assert!(best.is_finite());
            assert_eq!(s.parameter_paths, vec!["restrictor_cd".to_string()]);
            assert_eq!(s.objective_direction, ObjectiveDirection::Maximize);
            assert!(s.total_wall_time_s > 0.0);
        }
        _ => panic!("expected OptimizationDoneSummary"),
    }
}

#[test]
fn optimization_with_two_tunables_two_trials() {
    let emitter = CollectEmitter::default();
    let probe = DefaultDivergenceProbe;
    let mut params = small_params(
        vec![
            ParameterBounds {
                path: "restrictor_cd".into(),
                min: 0.80,
                max: 0.95,
                step: None,
            },
            ParameterBounds {
                path: "plenum_volume".into(),
                min: 0.001,
                max: 0.003,
                step: None,
            },
        ],
        vec![6000.0, 9000.0],
        2,
        Some(7),
    );
    params.objective.metric = "ve_atm".into();
    params.objective.aggregator = ObjectiveAggregator::Mean;
    params.n_cycles_max = 2;

    let outcome = run_optimization_job(
        &emitter,
        &probe,
        "test-opt-2".into(),
        sdm26_config_path(),
        params,
        Arc::new(AtomicBool::new(false)),
        100,
    );
    assert!(matches!(outcome, RunOutcome::CompletedOptimization));

    let events = emitter.events.lock().unwrap().clone();
    let summary = match events.last().unwrap() {
        Event::Done(d) => d.payload.clone(),
        _ => panic!("expected Done last"),
    };
    match summary {
        JobDoneSummary::Optimization(s) => {
            assert_eq!(s.n_trials_run, 2);
            assert_eq!(s.parameter_paths.len(), 2);
            assert!(s.parameter_paths.contains(&"restrictor_cd".to_string()));
            assert!(s.parameter_paths.contains(&"plenum_volume".to_string()));
        }
        _ => panic!("expected OptimizationDoneSummary"),
    }

    // Each trial-started payload must carry both parameter paths.
    for e in &events {
        if let Event::Progress(p) = e {
            if let JobProgressPayload::OptimizationTrialStarted {
                parameter_values, ..
            } = &p.payload
            {
                assert!(parameter_values.contains_key("restrictor_cd"));
                assert!(parameter_values.contains_key("plenum_volume"));
            }
        }
    }
}

#[test]
fn optimization_pre_cancelled_short_circuits() {
    let emitter = CollectEmitter::default();
    let probe = DefaultDivergenceProbe;
    let params = small_params(
        vec![ParameterBounds {
            path: "restrictor_cd".into(),
            min: 0.80,
            max: 0.95,
            step: None,
        }],
        vec![6000.0],
        8,
        Some(1),
    );

    let cancel = Arc::new(AtomicBool::new(true)); // pre-armed
    let outcome = run_optimization_job(
        &emitter,
        &probe,
        "test-opt-3".into(),
        sdm26_config_path(),
        params,
        cancel,
        100,
    );
    assert!(matches!(outcome, RunOutcome::Cancelled));

    let events = emitter.events.lock().unwrap().clone();
    // Started first, Cancelled last.
    assert!(matches!(events.first(), Some(Event::Started(_))));
    assert!(matches!(events.last(), Some(Event::Cancelled(_))));
}

#[test]
fn optimization_rejects_empty_tunables() {
    let emitter = CollectEmitter::default();
    let probe = DefaultDivergenceProbe;
    let params = small_params(vec![], vec![6000.0], 2, Some(1));
    let outcome = run_optimization_job(
        &emitter,
        &probe,
        "test-opt-empty".into(),
        sdm26_config_path(),
        params,
        Arc::new(AtomicBool::new(false)),
        100,
    );
    assert!(matches!(outcome, RunOutcome::Errored));

    let events = emitter.events.lock().unwrap().clone();
    match events.last().unwrap() {
        Event::Error(e) => assert!(e.message.contains("tunable")),
        other => panic!("expected Error, got {other:?}"),
    }
}
