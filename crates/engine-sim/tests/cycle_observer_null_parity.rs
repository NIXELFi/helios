//! Parity test for the new CycleObserver hook on `advance_one_cycle`.
//!
//! Confirms that attaching a no-op observer to the SDM26 stepper does
//! NOT perturb the math. Without this guarantee the Phase 3 capture
//! hooks would be a parity hazard — instead they remain a strict
//! read-side viewer the optimizer can elide when `None`.

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{
    CycleLoopState, CycleObserver, CycleOutcome, CycleStats, JunctionKind, SDM26Engine,
};

struct NoopObserver {
    step_count: u64,
}

impl CycleObserver for NoopObserver {
    fn on_step(
        &mut self,
        _theta_global_deg: f64,
        _dt: f64,
        _eng: &SDM26Engine,
    ) {
        self.step_count = self.step_count.saturating_add(1);
    }
}

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("python_ref/configs/sdm26.json")
}

fn run_5_cycles_baseline() -> Vec<CycleStats> {
    let cfg = load_v1_json(sdm26_path()).expect("load sdm26");
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut out = Vec::with_capacity(5);
    for _ in 0..5 {
        match eng.advance_one_cycle(8000.0, &mut state, None, None) {
            CycleOutcome::Cycle(s) => out.push(s),
            CycleOutcome::TargetReached => break,
        }
    }
    out
}

fn run_5_cycles_with(obs: &mut NoopObserver) -> Vec<CycleStats> {
    let cfg = load_v1_json(sdm26_path()).expect("load sdm26");
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut out = Vec::with_capacity(5);
    for _ in 0..5 {
        // Reborrow `obs` each iteration so the loop body owns a fresh
        // &mut dyn CycleObserver each call.
        let observer: &mut dyn CycleObserver = &mut *obs;
        match eng.advance_one_cycle(8000.0, &mut state, None, Some(observer)) {
            CycleOutcome::Cycle(s) => out.push(s),
            CycleOutcome::TargetReached => break,
        }
    }
    out
}

#[test]
fn noop_observer_is_bitwise_identical_to_none() {
    let baseline = run_5_cycles_baseline();

    let mut obs = NoopObserver { step_count: 0 };
    let observed = run_5_cycles_with(&mut obs);

    assert_eq!(baseline.len(), observed.len(), "cycle count differs");
    assert!(obs.step_count > 0, "observer was never called");

    for (i, (a, b)) in baseline.iter().zip(observed.iter()).enumerate() {
        macro_rules! exact_bits {
            ($f:ident) => {
                assert!(
                    a.$f.to_bits() == b.$f.to_bits()
                        || (a.$f.is_nan() && b.$f.is_nan()),
                    "cycle[{i}].{}: baseline={} observed={}",
                    stringify!($f), a.$f, b.$f,
                );
            };
        }
        exact_bits!(imep_bar);
        exact_bits!(bmep_bar);
        exact_bits!(fmep_bar);
        exact_bits!(ve_atm);
        exact_bits!(mass_total);
        exact_bits!(mass_drift);
        exact_bits!(mass_in_restrictor);
        exact_bits!(mass_out_collector);
        exact_bits!(net_port_flow);
        exact_bits!(nonconservation);
        exact_bits!(intake_mass_per_cycle_g);
        exact_bits!(f_residual);
        exact_bits!(indicated_power_k_w);
        exact_bits!(brake_power_k_w);
        exact_bits!(wheel_power_k_w);
        exact_bits!(indicated_torque_nm);
        exact_bits!(brake_torque_nm);
        exact_bits!(wheel_torque_nm);
        exact_bits!(egt_mean);
    }
}
