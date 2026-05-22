//! Validate the restrictor choked-flow physics by sweeping throat
//! diameter from way-below-choke up to unchoked. Compute the predicted
//! choked mass flow and compare against the sim.
//!
//! Compressible isentropic choke equation (for an ideal gas):
//!   m_dot_choke = Cd · A · p0 · sqrt(γ / (R · T0)) · (2/(γ+1))^((γ+1)/(2·(γ-1)))
//!
//! For air at standard atmosphere (p0=101325 Pa, T0=298K, γ=1.4, R=287):
//!   m_dot_choke = Cd · A · 101325 · sqrt(1.4 / (287·298)) · 0.6847
//!              = Cd · A · 101325 · 0.04051 · 0.6847
//!              = Cd · A · 2810  kg/(s·m²)
//!
//! For a 4-cyl 600cc engine at 12000 RPM, displacement mass flow at
//! ρ_atm ≈ 1.184 kg/m³ at unit VE is:
//!   m_displ = ρ · V_d · n · (rpm / 120) = 1.184 · 6e-4 · 6000 / 60 = 0.0710 kg/s
//!
//! So the engine "wants" 0.071 kg/s at peak. At a 20mm throat × Cd=0.97:
//!   A = π × 0.020²/4 = 3.142e-4 m²
//!   m_choke = 0.97 × 3.142e-4 × 2810 = 0.0857 kg/s
//! → engine reaches ~83% of choke at unit VE; choke restricts above that.
//!
//! At a 12mm throat (way below FSAE):
//!   A = π × 0.012²/4 = 1.131e-4 m²
//!   m_choke = 0.97 × 1.131e-4 × 2810 = 0.0308 kg/s
//! → engine only gets ~36% of displacement flow at choke → severe limit.
//!
//! Run:
//!   cargo test --release -p cfd-core --test physics_choke_cliff -- --ignored --nocapture

use std::sync::atomic::AtomicBool;

use engine_sim::config::loader::load_v1_json;
use engine_sim::model::sdm26::{CycleLoopState, CycleOutcome, JunctionKind, SDM26Engine, SDM26Config};

fn sdm26_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine-sim/python_ref/configs/sdm26.json")
}

fn predicted_choke_mdot(d_throat_m: f64, cd: f64) -> f64 {
    let gamma = 1.4_f64;
    let r = 287.0_f64;
    let p0 = 101325.0_f64;
    let t0 = 298.0_f64;
    let a = std::f64::consts::PI * d_throat_m * d_throat_m / 4.0;
    let psi_choke = (2.0_f64 / (gamma + 1.0)).powf((gamma + 1.0) / (2.0 * (gamma - 1.0)));
    cd * a * p0 * (gamma / (r * t0)).sqrt() * psi_choke
}

fn run_mdot(cfg: &SDM26Config, rpm: f64, n_cycles: u32) -> (f64, f64, f64) {
    // Return (mass_in_restrictor_kg_per_cycle, imep_bar, ve_atm)
    let cancel = AtomicBool::new(false);
    let mut eng = SDM26Engine::new(cfg.clone(), JunctionKind::Stagnation);
    let mut state = CycleLoopState::new(&mut eng);
    let mut last = (0.0, 0.0, 0.0);
    for _ in 0..n_cycles {
        match eng.advance_one_cycle(rpm, &mut state, None, None, Some(&cancel)) {
            CycleOutcome::Cycle(cs) => last = (cs.mass_in_restrictor, cs.imep_bar, cs.ve_atm),
            _ => break,
        }
    }
    last
}

#[test]
#[ignore]
fn choke_cliff_sweep() {
    let base = load_v1_json(sdm26_path()).unwrap();
    let rpm = 12000.0;
    let cd = base.restrictor_cd;
    println!("\n=== Restrictor choke-cliff sweep at {rpm} RPM ===");
    println!("Cd = {cd}");
    println!("\nPredicted choked mass per cycle = m_dot_choke · 120 / RPM  (for a 4-stroke 4-cyl, 2 revs/cycle)\n");

    let diameters_mm = [8.0, 10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 22.0, 25.0, 30.0];
    let rev_per_cycle = 2.0;
    let cycle_time_s = 60.0 * rev_per_cycle / rpm;
    println!("{:>6}  {:>12}  {:>14}  {:>12}  {:>10}  {:>8}",
        "D mm", "A mm²", "m_pred kg/c", "m_obs kg/c", "ratio", "IMEP");
    for &d_mm in &diameters_mm {
        let d_m = d_mm / 1000.0;
        let a_m2 = std::f64::consts::PI * d_m * d_m / 4.0;
        let m_choke_per_s = predicted_choke_mdot(d_m, cd);
        let m_choke_per_cycle = m_choke_per_s * cycle_time_s;

        let mut cfg = base.clone();
        cfg.restrictor_throat_diameter = d_m;
        let (m_in, imep, _ve) = run_mdot(&cfg, rpm, 6);
        // sum over 4 cylinders' shared restrictor → already cycle-integrated
        let ratio = if m_choke_per_cycle > 0.0 { m_in / m_choke_per_cycle } else { 0.0 };
        println!("{:>6.1}  {:>12.4}  {:>14.5}  {:>12.5}  {:>10.3}  {:>8.2}",
            d_mm, a_m2 * 1e6, m_choke_per_cycle, m_in, ratio, imep);
    }
    println!("\nInterpretation:");
    println!("  ratio = 1.0  → sim hits choke limit exactly (perfect compressible flow)");
    println!("  ratio < 1.0  → sim flows LESS than choke (engine displacement is the limit, or extra losses)");
    println!("  ratio > 1.0  → sim flows MORE than choke (physically wrong — choke is the universal upper bound)");
}
