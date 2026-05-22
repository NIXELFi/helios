//! Regression: cancel observed inside advance_one_cycle's step loop.
//!
//! Before v3.4.1, cancel was only checked between cycles in the runner.
//! A bad parameter combo that made a single cycle take many seconds would
//! trap the cancel button. This test confirms that, given a cancel atomic
//! that is `true` at call time, advance_one_cycle returns
//! `CycleOutcome::Cancelled` within a few inner steps rather than running
//! the cycle to completion.

use std::sync::atomic::{AtomicBool, Ordering};

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python_ref/configs/sdm26.json")
}

#[test]
fn cancel_pre_armed_returns_cancelled_within_one_step() {
    let cfg = load_v1_json(&sdm26_path()).expect("load sdm26");
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let cancel = AtomicBool::new(true);

    let outcome = eng.advance_one_cycle(8000.0, &mut state, None, None, Some(&cancel));
    assert!(matches!(outcome, CycleOutcome::Cancelled),
        "expected Cancelled with pre-armed atomic, got {outcome:?}");
    // step_count may be 0 or 1 depending on where the check fires; the
    // important contract is "doesn't run a whole cycle".
    assert!(state.step_count < 100,
        "cancel was too slow to observe — ran {} steps", state.step_count);
}

#[test]
fn cancel_none_runs_to_completion_unchanged() {
    let cfg = load_v1_json(&sdm26_path()).expect("load sdm26");
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);

    let outcome = eng.advance_one_cycle(8000.0, &mut state, None, None, None);
    assert!(matches!(outcome, CycleOutcome::Cycle(_)),
        "expected Cycle with None cancel, got {outcome:?}");
}

#[test]
fn cancel_unset_runs_to_completion() {
    let cfg = load_v1_json(&sdm26_path()).expect("load sdm26");
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let cancel = AtomicBool::new(false);

    let outcome = eng.advance_one_cycle(8000.0, &mut state, None, None, Some(&cancel));
    assert!(matches!(outcome, CycleOutcome::Cycle(_)),
        "expected Cycle with unset cancel, got {outcome:?}");
}
