//! SDM26 engine assembly — Honda CBR600RR I4 with FSAE 20 mm restrictor.
//! Direct port of `models/sdm26.py`.

use std::f64::consts::PI;

use crate::bcs::junction_characteristic::{CharJunctionLeg, CharacteristicJunction, LossMode as CharLossMode};
use crate::bcs::junction_cv::{JunctionCV, JunctionCVLeg, PipeEnd};
use crate::cylinder::valve::LiftProfile;
use crate::bcs::restrictor::{fill_choked_restrictor_left, fill_choked_restrictor_left_full};

/// Idelchik diagram 5-2 piecewise approximation: conical-diffuser loss
/// coefficient φ(α) as a function of half-angle α (deg) for a diffuser
/// discharging into a much larger downstream area. The total loss
/// referenced to upstream throat dynamic head is
/// `K = φ(α) × (1 − A_throat/A_plenum)^2`. Pure geometry — no
/// per-engine tuning. Used by `SDM26Engine::step` when
/// `restrictor_loss_from_diffuser_geometry = true`.
#[inline]
fn idelchik_diffuser_phi(half_angle_deg: f64) -> f64 {
    let a = half_angle_deg.max(0.0);
    // Anchors from Idelchik 3rd ed Diagram 5-2 (interpolated):
    //   α ≤ 5°:  φ = 0.10 (best-case diffuser)
    //   α = 10°: φ = 0.27
    //   α = 15°: φ = 0.50
    //   α = 20°: φ = 0.80
    //   α ≥ 30°: φ = 1.00 (≈ sudden expansion)
    if a <= 5.0 {
        0.10
    } else if a <= 10.0 {
        0.10 + (a - 5.0) / 5.0 * (0.27 - 0.10)
    } else if a <= 15.0 {
        0.27 + (a - 10.0) / 5.0 * (0.50 - 0.27)
    } else if a <= 20.0 {
        0.50 + (a - 15.0) / 5.0 * (0.80 - 0.50)
    } else if a <= 30.0 {
        0.80 + (a - 20.0) / 10.0 * (1.00 - 0.80)
    } else {
        1.00
    }
}
use crate::bcs::simple::{fill_open_end_right, fill_transmissive_right};
use crate::bcs::valve::{fill_valve_ghost_characteristic, PipeEndStr, ValveType};
use crate::cylinder::combustion::WiebeParams;
use crate::cylinder::cylinder::{CylinderGeom, CylinderModel};
use crate::cylinder::heat_transfer::WoschniParams;
use crate::cylinder::kinematics::{cylinder_phase_offsets, omega_from_rpm};
use crate::cylinder::valve::{
    ValveParams, EXHAUST_CD_TABLE, EXHAUST_LD_TABLE,
    INTAKE_CD_TABLE, INTAKE_LD_TABLE,
};
use crate::solver::muscl::{cfl_dt, muscl_hancock_step, LIMITER_MINMOD};
use crate::solver::sources::apply_sources;
use crate::solver::state::{
    make_pipe_state, set_uniform, PipeState, ScratchBuffers,
    N_VARS, I_RHO_A,
};

/// Build an area_fn(x) for a linearly-tapered circular pipe.
pub fn linear_diameter_area(length: f64, d_in: f64, d_out: f64)
    -> impl FnMut(f64) -> f64
{
    let l = length.max(1e-20);
    move |x: f64| {
        let mut t = x / l;
        if t < 0.0 { t = 0.0; }
        if t > 1.0 { t = 1.0; }
        let d = d_in + (d_out - d_in) * t;
        0.25 * PI * d * d
    }
}

#[derive(Debug, Clone)]
pub struct SDM26Config {
    // engine geometry
    pub bore: f64,
    pub stroke: f64,
    pub con_rod: f64,
    pub cr: f64,
    pub n_cylinders: usize,
    pub firing_order: Vec<i32>,
    pub firing_interval: f64,
    // intake runners
    pub runner_length: f64,
    pub runner_diameter_in: f64,
    pub runner_diameter_out: Option<f64>,
    pub runner_n_cells: usize,
    pub runner_wall_t: f64,
    pub runner_lengths: Option<Vec<f64>>,
    pub runner_diameters_in: Option<Vec<f64>>,
    pub runner_diameters_out: Option<Vec<Option<f64>>>,
    pub runner_wall_ts: Option<Vec<f64>>,
    // exhaust primaries
    pub primary_length: f64,
    pub primary_diameter_in: f64,
    pub primary_diameter_out: Option<f64>,
    pub primary_n_cells: usize,
    pub primary_wall_t: f64,
    pub primary_lengths: Option<Vec<f64>>,
    pub primary_diameters_in: Option<Vec<f64>>,
    pub primary_diameters_out: Option<Vec<Option<f64>>>,
    pub primary_wall_ts: Option<Vec<f64>>,
    // exhaust secondaries
    pub secondary_length: f64,
    pub secondary_diameter_in: f64,
    pub secondary_diameter_out: Option<f64>,
    pub secondary_n_cells: usize,
    pub secondary_wall_t: f64,
    pub secondary_lengths: Option<Vec<f64>>,
    pub secondary_diameters_in: Option<Vec<f64>>,
    pub secondary_diameters_out: Option<Vec<Option<f64>>>,
    pub secondary_wall_ts: Option<Vec<f64>>,
    // collector
    pub collector_length: f64,
    pub collector_diameter_in: f64,
    pub collector_diameter_out: Option<f64>,
    pub collector_n_cells: usize,
    pub collector_wall_t: f64,
    // plenum
    pub plenum_volume: f64,
    pub plenum_length: f64,
    pub plenum_n_cells: usize,
    pub plenum_wall_t: f64,
    /// 0006: RPM-dependent spark advance slope (deg/krpm).
    /// `spark_advance` is the value at `spark_advance_rpm_ref` (default
    /// 10000); the effective advance is
    ///   spark_advance + slope × (rpm − ref) / 1000
    /// Default 0.0 → constant spark_advance, parity preserved.
    /// Bonatesta-Waters-Shayler (IJER 2010) gives ~1.7 deg/krpm for
    /// high-RPM SI engines.
    pub spark_advance_rpm_slope_deg_per_krpm: f64,
    /// Reference RPM for `spark_advance_rpm_slope_deg_per_krpm`. Default 10000.
    pub spark_advance_rpm_ref: f64,

    /// 0006: RPM-dependent burn-duration exponent (Bonatesta).
    /// `combustion_duration` is the value at `duration_rpm_ref`; the
    /// effective duration is `combustion_duration × (rpm/ref)^exp`.
    /// Default 0.0 → constant duration, parity preserved.
    pub duration_rpm_exp: f64,
    pub duration_rpm_ref: f64,

    /// 0007: RPM-dependent Wiebe a (turbulent flame speed scaling).
    /// Default 0.0 → no scaling, parity preserved. Bonatesta/Heywood:
    /// flame speed ∝ mean piston speed ∝ RPM; a_eff(rpm) = a × (rpm/ref)^exp
    /// with exp ≈ 0.3-0.5.
    pub wiebe_a_rpm_exp: f64,
    pub wiebe_a_rpm_ref: f64,

    /// 0007: open-end reflection coefficient at the exhaust collector
    /// outlet. Default 0.0 = legacy transmissive BC (no reflection,
    /// zero scavenging benefit; preserves parity). For a real open-end
    /// pipe well below cutoff frequency (`ka << 1`) the linear-acoustics
    /// limit is r ≈ 1 (full pressure-release inversion). SDM26 collector
    /// d = 50 mm; exhaust pulse fundamental at peak RPM ~ 430 Hz; ka ≈
    /// 0.097 → r ≈ 1 from Munjal §2.7. Set to 1.0 for the physically
    /// correct open-end behavior. Intermediate values model the partial
    /// radiation transition (ka approaching unity → r → 0).
    pub exhaust_collector_reflection_coef: f64,

    /// 0006: optional geometry-derived restrictor diffuser loss.
    /// When true, the BC's loss_coef is set from the diverging-cone
    /// half-angle and the throat/plenum area ratio per Idelchik (3rd ed,
    /// Diagram 5-2):
    ///   K = φ(half_angle) × (1 − A_throat / A_plenum)^2
    /// where φ(α): 0.10 (α≤5°), 0.27 (10°), 0.50 (15°), 0.80 (20°),
    /// 1.0 (≥30°), linearly interpolated. Default `false` preserves the
    /// legacy `restrictor_loss_coef`-driven behavior.
    pub restrictor_loss_from_diffuser_geometry: bool,
    /// Diffuser half-angle (deg) for the geometric loss formula above.
    /// Read from the JSON `restrictor.diverging_half_angle` (which the
    /// legacy loader silently ignored). Only used when
    /// `restrictor_loss_from_diffuser_geometry = true`. Default 6.0
    /// (SDM26 JSON value).
    pub restrictor_diverging_half_angle_deg: f64,

    /// 0006: Mach-dependent Cd correction strength for the restrictor.
    /// Effective Cd = Cd · (1 − k · M_throat^2). Default 0.0 preserves
    /// parity. NASA TM X-1570 / Cruz-Maya 2006 give k ≈ 0.30-0.40 for
    /// subsonic venturi flow. Real Cd drops a few % as throat Mach
    /// approaches 1.0; the simulator's previously-constant Cd over-
    /// predicts mass flow at high-Mach (high-RPM, near-choke) regimes.
    pub restrictor_cd_mach_k: f64,

    pub intake_junction_loss_coef: f64,
    /// When true, the intake junction uses per-leg Borda-Carnot loss
    /// K_leg = (1 − A_leg/A_max)^2 derived from junction geometry, scaled
    /// by `intake_junction_loss_coef` as a multiplier (default 1.0 if
    /// coef is 0). When false (default), the legacy scalar-K behavior
    /// applies the single `intake_junction_loss_coef` to every inflow
    /// leg. Default `false` preserves bit-exact parity with K=0 configs.
    ///
    /// New configs (e.g. SDM27) should set this `true` so the loss
    /// coefficient is geometry-derived, not per-engine tuned.
    pub intake_junction_borda_carnot: bool,
    /// Exhaust-side per-junction loss coefficient (default 0.0 for parity).
    /// Active on Char and CV junctions for ALL exhaust junctions
    /// (primaries→secondary, secondaries→collector, and the 4→1 case).
    pub exhaust_junction_loss_coef: f64,
    /// When true, exhaust junctions use per-leg Borda-Carnot K from
    /// geometry, scaled by `exhaust_junction_loss_coef`. Default false.
    pub exhaust_junction_borda_carnot: bool,
    // restrictor
    pub restrictor_throat_diameter: f64,
    pub restrictor_cd: f64,
    pub restrictor_loss_coef: f64,
    // ambient
    pub p_ambient: f64,
    pub t_ambient: f64,
    // combustion
    pub wiebe_a: f64,
    pub wiebe_m: f64,
    pub combustion_duration: f64,
    pub spark_advance: f64,
    pub ignition_delay: f64,
    pub eta_comb: f64,
    pub q_lhv: f64,
    pub afr_target: f64,
    /// When true, multiply `eta_comb` by a Heywood-shape AFR factor that
    /// models rich-quench and lean-misfire (φ = AFR_stoich / AFR).
    /// Default false → bit-exact Python parity preserved.
    pub afr_eta_enabled: bool,
    pub t_wall_cylinder: f64,
    // Woschni
    pub woschni_c1_gas_exchange: f64,
    pub woschni_c1_compression: f64,
    pub woschni_c1_combustion: f64,
    pub woschni_c2_combustion: f64,
    // intake valve
    pub intake_valve_diameter: f64,
    pub intake_valve_max_lift: f64,
    pub intake_valve_open_angle: f64,
    pub intake_valve_close_angle: f64,
    pub intake_valve_seat_angle: f64,
    pub intake_n_valves: usize,
    pub intake_ld_table: Vec<f64>,
    pub intake_cd_table: Vec<f64>,
    // exhaust valve
    pub exhaust_valve_diameter: f64,
    pub exhaust_valve_max_lift: f64,
    pub exhaust_valve_open_angle: f64,
    pub exhaust_valve_close_angle: f64,
    pub exhaust_valve_seat_angle: f64,
    pub exhaust_n_valves: usize,
    pub exhaust_ld_table: Vec<f64>,
    pub exhaust_cd_table: Vec<f64>,
    // topology + drivetrain
    /// Intake-valve lift-profile selector.
    ///   0.0 (default)  → sin² profile (parity with Python reference)
    ///   > 0.0          → flat-top trapezoidal lift with this ramp fraction
    ///                    (typical race cam: ~0.20–0.30)
    pub intake_lift_flat_top_ramp: f64,
    /// Exhaust-valve lift-profile selector (same semantics as intake).
    pub exhaust_lift_flat_top_ramp: f64,
    /// Chen-Flynn FMEP coefficients: fmep[bar] = fmep_a + fmep_b · sp + fmep_c · sp²
    /// where sp = mean piston speed (m/s). Defaults match the legacy
    /// hardcoded values (0.5, 0.1, 0.003) which are on the high side for a
    /// motorcycle engine. Heywood Tab. 13.3 typical: (0.3–0.5, 0.04–0.05, 5e-4–1e-3).
    pub fmep_a: f64,
    pub fmep_b: f64,
    pub fmep_c: f64,
    /// Tumble/swirl turbulent burn-rate enhancement on Wiebe's `a` coefficient.
    /// 0.0 (default) = no enhancement. 0.3-0.7 typical for modern high-tumble heads.
    pub tumble_burn_factor: f64,
    /// Opt-in two-zone combustion model. When true, the cylinder tracks
    /// burned and unburned zones separately during the combustion window,
    /// splitting Woschni heat loss by zone volume fraction and using a
    /// mass-averaged γ across the two zones. Default false → behaviour
    /// (and parity tests) match the legacy single-zone model exactly.
    pub two_zone_enabled: bool,
    pub exhaust_topology: ExhaustTopology,
    pub drivetrain_efficiency: f64,
    // residual-gas
    pub enable_residual_tracking: bool,
    // numerics
    pub cfl: f64,
    pub limiter: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExhaustTopology {
    FourTwoOne,
    FourOne,
}

impl Default for SDM26Config {
    fn default() -> Self {
        Self {
            bore: 0.067, stroke: 0.0425, con_rod: 0.0963, cr: 12.2,
            n_cylinders: 4, firing_order: vec![1, 2, 4, 3],
            firing_interval: 180.0,
            runner_length: 0.245, runner_diameter_in: 0.038,
            runner_diameter_out: None, runner_n_cells: 30, runner_wall_t: 325.0,
            runner_lengths: None, runner_diameters_in: None,
            runner_diameters_out: None, runner_wall_ts: None,
            primary_length: 0.308, primary_diameter_in: 0.032,
            primary_diameter_out: None, primary_n_cells: 30, primary_wall_t: 1000.0,
            primary_lengths: None, primary_diameters_in: None,
            primary_diameters_out: None, primary_wall_ts: None,
            secondary_length: 0.392, secondary_diameter_in: 0.038,
            secondary_diameter_out: None, secondary_n_cells: 20, secondary_wall_t: 800.0,
            secondary_lengths: None, secondary_diameters_in: None,
            secondary_diameters_out: None, secondary_wall_ts: None,
            collector_length: 0.1, collector_diameter_in: 0.05,
            collector_diameter_out: None, collector_n_cells: 20,
            collector_wall_t: 700.0,
            plenum_volume: 0.0015, plenum_length: 0.3, plenum_n_cells: 20,
            plenum_wall_t: 320.0,
            spark_advance_rpm_slope_deg_per_krpm: 0.0,
            spark_advance_rpm_ref: 10000.0,
            duration_rpm_exp: 0.0,
            duration_rpm_ref: 10000.0,
            wiebe_a_rpm_exp: 0.0,
            wiebe_a_rpm_ref: 10000.0,
            exhaust_collector_reflection_coef: 0.0,
            restrictor_loss_from_diffuser_geometry: false,
            restrictor_diverging_half_angle_deg: 6.0,
            restrictor_cd_mach_k: 0.0,
            intake_junction_loss_coef: 0.0,
            intake_junction_borda_carnot: false,
            exhaust_junction_loss_coef: 0.0,
            exhaust_junction_borda_carnot: false,
            restrictor_throat_diameter: 0.020,
            restrictor_cd: 0.967,
            restrictor_loss_coef: 0.0,
            p_ambient: 101325.0, t_ambient: 300.0,
            wiebe_a: 5.0, wiebe_m: 2.0,
            combustion_duration: 50.0, spark_advance: 25.0,
            ignition_delay: 7.0,
            eta_comb: 0.96, q_lhv: 44.0e6, afr_target: 13.1,
            afr_eta_enabled: false,
            t_wall_cylinder: 450.0,
            woschni_c1_gas_exchange: 6.18, woschni_c1_compression: 2.28,
            woschni_c1_combustion: 2.28, woschni_c2_combustion: 3.24e-3,
            intake_valve_diameter: 0.0275, intake_valve_max_lift: 0.00856,
            intake_valve_open_angle: 350.0, intake_valve_close_angle: 585.0,
            intake_valve_seat_angle: 45.0, intake_n_valves: 2,
            intake_ld_table: INTAKE_LD_TABLE.to_vec(),
            intake_cd_table: INTAKE_CD_TABLE.to_vec(),
            exhaust_valve_diameter: 0.023, exhaust_valve_max_lift: 0.00735,
            exhaust_valve_open_angle: 140.0, exhaust_valve_close_angle: 365.0,
            exhaust_valve_seat_angle: 45.0, exhaust_n_valves: 2,
            exhaust_ld_table: EXHAUST_LD_TABLE.to_vec(),
            exhaust_cd_table: EXHAUST_CD_TABLE.to_vec(),
            intake_lift_flat_top_ramp: 0.0,
            exhaust_lift_flat_top_ramp: 0.0,
            fmep_a: 0.5,
            fmep_b: 0.1,
            fmep_c: 0.003,
            tumble_burn_factor: 0.0,
            two_zone_enabled: false,
            exhaust_topology: ExhaustTopology::FourTwoOne,
            drivetrain_efficiency: 0.85,
            enable_residual_tracking: false,
            cfl: 0.85, limiter: LIMITER_MINMOD,
        }
    }
}

impl SDM26Config {
    fn runner_spec(&self, i: usize) -> (f64, f64, f64, usize, f64) {
        let l = self.runner_lengths.as_ref().map(|v| v[i]).unwrap_or(self.runner_length);
        let d_in = self.runner_diameters_in.as_ref().map(|v| v[i]).unwrap_or(self.runner_diameter_in);
        let d_out_override = self.runner_diameters_out.as_ref().and_then(|v| v[i]);
        let d_out = d_out_override.unwrap_or_else(|| self.runner_diameter_out.unwrap_or(d_in));
        let wt = self.runner_wall_ts.as_ref().map(|v| v[i]).unwrap_or(self.runner_wall_t);
        (l, d_in, d_out, self.runner_n_cells, wt)
    }
    fn primary_spec(&self, i: usize) -> (f64, f64, f64, usize, f64) {
        let l = self.primary_lengths.as_ref().map(|v| v[i]).unwrap_or(self.primary_length);
        let d_in = self.primary_diameters_in.as_ref().map(|v| v[i]).unwrap_or(self.primary_diameter_in);
        let d_out_override = self.primary_diameters_out.as_ref().and_then(|v| v[i]);
        let d_out = d_out_override.unwrap_or_else(|| self.primary_diameter_out.unwrap_or(d_in));
        let wt = self.primary_wall_ts.as_ref().map(|v| v[i]).unwrap_or(self.primary_wall_t);
        (l, d_in, d_out, self.primary_n_cells, wt)
    }
    fn secondary_spec(&self, i: usize) -> (f64, f64, f64, usize, f64) {
        let l = self.secondary_lengths.as_ref().map(|v| v[i]).unwrap_or(self.secondary_length);
        let d_in = self.secondary_diameters_in.as_ref().map(|v| v[i]).unwrap_or(self.secondary_diameter_in);
        let d_out_override = self.secondary_diameters_out.as_ref().and_then(|v| v[i]);
        let d_out = d_out_override.unwrap_or_else(|| self.secondary_diameter_out.unwrap_or(d_in));
        let wt = self.secondary_wall_ts.as_ref().map(|v| v[i]).unwrap_or(self.secondary_wall_t);
        (l, d_in, d_out, self.secondary_n_cells, wt)
    }
    fn collector_spec(&self) -> (f64, f64, f64, usize, f64) {
        let d_in = self.collector_diameter_in;
        let d_out = self.collector_diameter_out.unwrap_or(d_in);
        (self.collector_length, d_in, d_out, self.collector_n_cells, self.collector_wall_t)
    }
    fn plenum_spec(&self) -> (f64, f64, usize, f64) {
        let a = self.plenum_volume / self.plenum_length;
        let d = 2.0 * (a / PI).sqrt();
        (self.plenum_length, d, self.plenum_n_cells, self.plenum_wall_t)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JunctionKind {
    Stagnation,
    Characteristic,
}

#[derive(Debug, Clone)]
pub enum Junction {
    Cv(JunctionCV),
    Char(CharacteristicJunction),
}

impl Junction {
    pub fn legs_pipe_indices(&self) -> Vec<usize> {
        match self {
            Junction::Cv(j) => j.legs.iter().map(|l| l.pipe_idx).collect(),
            Junction::Char(j) => j.legs.iter().map(|l| l.pipe_idx).collect(),
        }
    }
    pub fn fill_ghosts(&mut self, pipes: &mut [PipeState], dt: f64) {
        match self {
            Junction::Cv(j) => j.fill_ghosts(pipes, dt),
            Junction::Char(j) => {
                j.fill_ghosts(pipes, dt).expect("characteristic junction failed to converge")
            }
        }
    }
    pub fn absorb_fluxes(&mut self, pipes: &[PipeState], fluxes: &[&[f64]], dt: f64) {
        match self {
            Junction::Cv(j) => j.absorb_fluxes(pipes, fluxes, dt),
            Junction::Char(j) => j.absorb_fluxes(pipes, fluxes, dt),
        }
    }
    pub fn mass(&self) -> f64 {
        match self {
            Junction::Cv(j) => j.m,
            Junction::Char(_) => 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleStats {
    pub cycle: i64,
    pub mass_total: f64,
    pub mass_drift: f64,
    pub mass_in_restrictor: f64,
    pub mass_out_collector: f64,
    pub net_port_flow: f64,
    pub nonconservation: f64,
    pub imep_bar: f64,
    pub bmep_bar: f64,
    pub fmep_bar: f64,
    pub ve_atm: f64,
    pub intake_mass_per_cycle_g: f64,
    pub f_residual: f64,
    #[serde(rename = "indicatedPowerKW")]
    pub indicated_power_k_w: f64,
    #[serde(rename = "indicatedPowerHp")]
    pub indicated_power_hp: f64,
    #[serde(rename = "brakePowerKW")]
    pub brake_power_k_w: f64,
    #[serde(rename = "brakePowerHp")]
    pub brake_power_hp: f64,
    #[serde(rename = "wheelPowerKW")]
    pub wheel_power_k_w: f64,
    #[serde(rename = "wheelPowerHp")]
    pub wheel_power_hp: f64,
    #[serde(rename = "indicatedTorqueNm")]
    pub indicated_torque_nm: f64,
    #[serde(rename = "brakeTorqueNm")]
    pub brake_torque_nm: f64,
    #[serde(rename = "wheelTorqueNm")]
    pub wheel_torque_nm: f64,
    #[serde(rename = "egtMean")]
    pub egt_mean: f64,
}

#[derive(Debug, Clone)]
pub struct RunResult {
    pub rpm: f64,
    pub n_cycles_requested: usize,
    pub n_cycles_run: usize,
    pub step_count: u64,
    pub cycle_stats: Vec<CycleStats>,
    pub converged_cycle: i64,
}

pub struct SDM26Engine {
    pub cfg: SDM26Config,
    pub junction_kind: JunctionKind,
    pub pipes: Vec<PipeState>,
    pub scratches: Vec<ScratchBuffers>,
    pub junctions: Vec<Junction>,
    pub cylinders: Vec<CylinderModel>,
    pub plenum_idx: usize,
    pub runner_idx: Vec<usize>,
    pub primary_idx: Vec<usize>,
    pub secondary_idx: Vec<usize>,
    pub collector_idx: usize,
    pub mass_in_restrictor: f64,
    pub mass_out_collector: f64,
}

impl SDM26Engine {
    pub fn new(cfg: SDM26Config, junction_kind: JunctionKind) -> Self {
        let n_cyl = cfg.n_cylinders;
        let mut pipes = Vec::new();

        // plenum
        let (l_plen, d_plen, n_plen, t_plen) = cfg.plenum_spec();
        let mut plenum = make_pipe_state(
            n_plen, l_plen,
            linear_diameter_area(l_plen, d_plen, d_plen),
            1.4, 287.0, t_plen, 2,
        );
        set_uniform(&mut plenum, cfg.p_ambient / (287.0 * cfg.t_ambient),
                    0.0, cfg.p_ambient, 0.0);
        pipes.push(plenum);
        let plenum_idx = 0usize;

        // runners
        let mut runner_idx = Vec::with_capacity(n_cyl);
        for i in 0..n_cyl {
            let (l, d_in, d_out, n, wt) = cfg.runner_spec(i);
            let mut p = make_pipe_state(
                n, l, linear_diameter_area(l, d_in, d_out),
                1.4, 287.0, wt, 2,
            );
            set_uniform(&mut p, cfg.p_ambient / (287.0 * cfg.t_ambient),
                        0.0, cfg.p_ambient, 0.0);
            runner_idx.push(pipes.len());
            pipes.push(p);
        }

        // primaries
        let mut primary_idx = Vec::with_capacity(n_cyl);
        for i in 0..n_cyl {
            let (l, d_in, d_out, n, wt) = cfg.primary_spec(i);
            let mut p = make_pipe_state(
                n, l, linear_diameter_area(l, d_in, d_out),
                1.4, 287.0, wt, 2,
            );
            set_uniform(&mut p, cfg.p_ambient / (287.0 * cfg.t_ambient),
                        0.0, cfg.p_ambient, 0.0);
            primary_idx.push(pipes.len());
            pipes.push(p);
        }

        // secondaries (4-2-1 only)
        let mut secondary_idx = Vec::new();
        if cfg.exhaust_topology == ExhaustTopology::FourTwoOne {
            for i in 0..2 {
                let (l, d_in, d_out, n, wt) = cfg.secondary_spec(i);
                let mut p = make_pipe_state(
                    n, l, linear_diameter_area(l, d_in, d_out),
                    1.4, 287.0, wt, 2,
                );
                set_uniform(&mut p, cfg.p_ambient / (287.0 * cfg.t_ambient),
                            0.0, cfg.p_ambient, 0.0);
                secondary_idx.push(pipes.len());
                pipes.push(p);
            }
        }

        // collector
        let (l_col, d_col_in, d_col_out, n_col, t_col) = cfg.collector_spec();
        let mut collector = make_pipe_state(
            n_col, l_col,
            linear_diameter_area(l_col, d_col_in, d_col_out),
            1.4, 287.0, t_col, 2,
        );
        set_uniform(&mut collector, cfg.p_ambient / (287.0 * cfg.t_ambient),
                    0.0, cfg.p_ambient, 0.0);
        let collector_idx = pipes.len();
        pipes.push(collector);

        // scratches
        let scratches: Vec<ScratchBuffers> = pipes.iter().map(ScratchBuffers::for_pipe).collect();

        // junctions
        let mut junctions = Vec::new();
        // Resolve per-side loss mode once (cheap; same for every call).
        let intake_loss_mode = if cfg.intake_junction_borda_carnot {
            let m = if cfg.intake_junction_loss_coef == 0.0 { 1.0 } else { cfg.intake_junction_loss_coef };
            CharLossMode::BordaCarnot { multiplier: m }
        } else {
            CharLossMode::Scalar(cfg.intake_junction_loss_coef)
        };
        let exhaust_loss_mode = if cfg.exhaust_junction_borda_carnot {
            let m = if cfg.exhaust_junction_loss_coef == 0.0 { 1.0 } else { cfg.exhaust_junction_loss_coef };
            CharLossMode::BordaCarnot { multiplier: m }
        } else {
            CharLossMode::Scalar(cfg.exhaust_junction_loss_coef)
        };
        let make_junction = |leg_specs: Vec<(usize, PipeEnd)>,
                             pipes: &[PipeState],
                             scalar_loss: f64,
                             loss_mode: CharLossMode| -> Junction {
            match junction_kind {
                JunctionKind::Stagnation => {
                    let legs = leg_specs.into_iter()
                        .map(|(idx, end)| JunctionCVLeg::new(idx, end)).collect();
                    let mut cv = JunctionCV::from_legs(
                        legs, pipes,
                        cfg.p_ambient, cfg.t_ambient, 0.0,
                        1.4, 287.0, 1.0,
                    );
                    // CV junction still uses the scalar coefficient — it does
                    // not yet implement the geometric Borda-Carnot mode. For
                    // physics parity between modes, callers should keep using
                    // Characteristic for tuned acoustic studies.
                    cv.inflow_loss_coef = scalar_loss;
                    Junction::Cv(cv)
                }
                JunctionKind::Characteristic => {
                    let legs = leg_specs.into_iter()
                        .map(|(idx, end)| CharJunctionLeg::new(idx, end)).collect();
                    let mut cj = CharacteristicJunction::new(legs, 1.4, 287.0);
                    // Keep the legacy scalar field populated for diagnostics +
                    // any test that reads it back, and also set the canonical
                    // loss_mode that the in-residual path actually consults.
                    cj.inflow_loss_coef = scalar_loss;
                    cj.loss_mode = loss_mode;
                    Junction::Char(cj)
                }
            }
        };

        // intake junction: plenum + 4 runners
        let mut intake_specs = vec![(plenum_idx, PipeEnd::Right)];
        for &r in &runner_idx { intake_specs.push((r, PipeEnd::Left)); }
        junctions.push(make_junction(
            intake_specs, &pipes, cfg.intake_junction_loss_coef, intake_loss_mode,
        ));

        if cfg.exhaust_topology == ExhaustTopology::FourTwoOne {
            junctions.push(make_junction(vec![
                (primary_idx[0], PipeEnd::Right),
                (primary_idx[3], PipeEnd::Right),
                (secondary_idx[0], PipeEnd::Left),
            ], &pipes, cfg.exhaust_junction_loss_coef, exhaust_loss_mode));
            junctions.push(make_junction(vec![
                (primary_idx[1], PipeEnd::Right),
                (primary_idx[2], PipeEnd::Right),
                (secondary_idx[1], PipeEnd::Left),
            ], &pipes, cfg.exhaust_junction_loss_coef, exhaust_loss_mode));
            junctions.push(make_junction(vec![
                (secondary_idx[0], PipeEnd::Right),
                (secondary_idx[1], PipeEnd::Right),
                (collector_idx, PipeEnd::Left),
            ], &pipes, cfg.exhaust_junction_loss_coef, exhaust_loss_mode));
        } else {
            let mut specs: Vec<(usize, PipeEnd)> = primary_idx.iter()
                .map(|&p| (p, PipeEnd::Right)).collect();
            specs.push((collector_idx, PipeEnd::Left));
            junctions.push(make_junction(specs, &pipes, cfg.exhaust_junction_loss_coef, exhaust_loss_mode));
        }

        // cylinders
        let offsets = cylinder_phase_offsets(
            n_cyl, &cfg.firing_order, cfg.firing_interval,
        );
        let geom = CylinderGeom {
            bore: cfg.bore, stroke: cfg.stroke, con_rod: cfg.con_rod, cr: cfg.cr,
            n_intake_valves: cfg.intake_n_valves, n_exhaust_valves: cfg.exhaust_n_valves,
        };
        let wiebe = WiebeParams {
            a: cfg.wiebe_a, m: cfg.wiebe_m,
            duration_deg: cfg.combustion_duration,
            spark_advance_deg: cfg.spark_advance,
            ignition_delay_deg: cfg.ignition_delay,
            eta_comb: cfg.eta_comb,
            q_lhv: cfg.q_lhv, afr_target: cfg.afr_target,
            afr_eta_enabled: cfg.afr_eta_enabled,
            tumble_burn_factor: cfg.tumble_burn_factor,
            // 0006: RPM-dependent MBT map + Wiebe duration. Defaults
            // (slope=0, exp=0) keep behavior bit-identical to legacy.
            spark_advance_rpm_slope_deg_per_krpm: cfg.spark_advance_rpm_slope_deg_per_krpm,
            spark_advance_rpm_ref: cfg.spark_advance_rpm_ref,
            duration_rpm_exp: cfg.duration_rpm_exp,
            duration_rpm_ref: cfg.duration_rpm_ref,
            wiebe_a_rpm_exp: cfg.wiebe_a_rpm_exp,
            wiebe_a_rpm_ref: cfg.wiebe_a_rpm_ref,
            two_zone_enabled: cfg.two_zone_enabled,
            ..WiebeParams::default()
        };
        let woschni = WoschniParams {
            bore: cfg.bore, stroke: cfg.stroke, t_wall: cfg.t_wall_cylinder,
            c1_gas_exchange: cfg.woschni_c1_gas_exchange,
            c1_compression: cfg.woschni_c1_compression,
            c1_combustion: cfg.woschni_c1_combustion,
            c2_combustion: cfg.woschni_c2_combustion,
        };
        let intake_profile = if cfg.intake_lift_flat_top_ramp > 0.0 {
            LiftProfile::FlatTop { ramp_frac: cfg.intake_lift_flat_top_ramp }
        } else {
            LiftProfile::Sin2
        };
        let exhaust_profile = if cfg.exhaust_lift_flat_top_ramp > 0.0 {
            LiftProfile::FlatTop { ramp_frac: cfg.exhaust_lift_flat_top_ramp }
        } else {
            LiftProfile::Sin2
        };
        let intake_valve = ValveParams {
            diameter: cfg.intake_valve_diameter,
            max_lift: cfg.intake_valve_max_lift,
            open_angle_deg: cfg.intake_valve_open_angle,
            close_angle_deg: cfg.intake_valve_close_angle,
            seat_angle_deg: cfg.intake_valve_seat_angle,
            n_valves: cfg.intake_n_valves,
            ld_table: cfg.intake_ld_table.clone(),
            cd_table: cfg.intake_cd_table.clone(),
            profile: intake_profile,
        };
        let exhaust_valve = ValveParams {
            diameter: cfg.exhaust_valve_diameter,
            max_lift: cfg.exhaust_valve_max_lift,
            open_angle_deg: cfg.exhaust_valve_open_angle,
            close_angle_deg: cfg.exhaust_valve_close_angle,
            seat_angle_deg: cfg.exhaust_valve_seat_angle,
            n_valves: cfg.exhaust_n_valves,
            ld_table: cfg.exhaust_ld_table.clone(),
            cd_table: cfg.exhaust_cd_table.clone(),
            profile: exhaust_profile,
        };
        let mut cylinders = Vec::with_capacity(n_cyl);
        for i in 0..n_cyl {
            let key = (i as i32) + 1;
            let phase_offset = *offsets.get(&key).unwrap_or(&0.0);
            let mut cyl = CylinderModel::new(
                geom, wiebe.clone(), woschni.clone(),
                intake_valve.clone(), exhaust_valve.clone(),
                phase_offset, cfg.enable_residual_tracking,
            );
            cyl.initialize(cfg.p_ambient, cfg.t_ambient, 0.0);
            cylinders.push(cyl);
        }

        Self {
            cfg, junction_kind, pipes, scratches, junctions, cylinders,
            plenum_idx, runner_idx, primary_idx, secondary_idx, collector_idx,
            mass_in_restrictor: 0.0,
            mass_out_collector: 0.0,
        }
    }

    fn system_mass(&self) -> f64 {
        let mut total = 0.0;
        for p in &self.pipes {
            let mut s = 0.0;
            for i in p.real_range() {
                s += p.q[i * N_VARS + I_RHO_A];
            }
            total += p.dx * s;
        }
        for c in &self.cylinders {
            total += c.state.m;
        }
        for j in &self.junctions {
            total += j.mass();
        }
        total
    }

    fn primary_entrance_t(pipe: &PipeState, gamma: f64) -> f64 {
        let idx = pipe.n_ghost;
        let a = pipe.area[idx];
        let rho = pipe.q[idx * N_VARS + I_RHO_A] / a;
        let u = pipe.q[idx * N_VARS + 1] / (rho * a);
        let big_e = pipe.q[idx * N_VARS + 2] / a;
        let p = ((gamma - 1.0) * (big_e - 0.5 * rho * u * u)).max(1.0);
        p / (rho * 287.0)
    }

    pub fn step(&mut self, theta_deg: f64, dt: f64, _rpm: f64) {
        let cfg = &self.cfg;
        let gamma = 1.4_f64;
        let a_t = 0.25 * PI * cfg.restrictor_throat_diameter * cfg.restrictor_throat_diameter;

        // 0006: derive restrictor loss-coef from diffuser geometry when
        // `restrictor_loss_from_diffuser_geometry = true`. Idelchik (3rd
        // ed) Diagram 5-2 for a conical diffuser of half-angle α
        // discharging into a large downstream area gives K relative to
        // throat dynamic head:
        //   φ(α) × (1 − A_throat/A_plenum)^2
        // φ(α) is approximated piecewise-linearly from the diagram.
        // Default `false` keeps the legacy `restrictor_loss_coef` field
        // as the source of truth — preserves bit-identical parity.
        let restrictor_loss_coef = if cfg.restrictor_loss_from_diffuser_geometry {
            // plenum cross-section area = volume / length
            let a_plenum = cfg.plenum_volume / cfg.plenum_length.max(1e-6);
            let area_ratio_sq = if a_plenum > a_t {
                let ratio = a_t / a_plenum;
                (1.0 - ratio).powi(2)
            } else {
                0.0
            };
            let phi = idelchik_diffuser_phi(cfg.restrictor_diverging_half_angle_deg);
            (phi * area_ratio_sq).max(0.0)
        } else {
            cfg.restrictor_loss_coef
        };

        // restrictor at plenum LEFT
        {
            let plenum = &mut self.pipes[self.plenum_idx];
            if cfg.restrictor_cd_mach_k > 0.0 {
                fill_choked_restrictor_left_full(
                    plenum, cfg.p_ambient, cfg.t_ambient, a_t, cfg.restrictor_cd,
                    restrictor_loss_coef, cfg.restrictor_cd_mach_k,
                );
            } else {
                // Use the legacy entry point to preserve bit-identical parity
                // when no Mach-correction is requested.
                fill_choked_restrictor_left(
                    plenum, cfg.p_ambient, cfg.t_ambient, a_t, cfg.restrictor_cd,
                    restrictor_loss_coef,
                );
            }
        }

        // junction ghosts
        for j in self.junctions.iter_mut() {
            j.fill_ghosts(&mut self.pipes, dt);
        }

        // valve ghosts
        for i in 0..cfg.n_cylinders {
            let cyl = &self.cylinders[i];
            let theta_local = cyl.local_theta(theta_deg);
            let p_cyl = cyl.state.p;
            let t_cyl = cyl.state.t;
            let xb = cyl.state.x_b;
            {
                let runner = &mut self.pipes[self.runner_idx[i]];
                fill_valve_ghost_characteristic(
                    runner, PipeEndStr::Right, ValveType::Intake,
                    &cyl.intake_valve, theta_local, p_cyl, t_cyl, xb,
                );
            }
            {
                let primary = &mut self.pipes[self.primary_idx[i]];
                fill_valve_ghost_characteristic(
                    primary, PipeEndStr::Left, ValveType::Exhaust,
                    &cyl.exhaust_valve, theta_local, p_cyl, t_cyl, xb,
                );
            }
        }

        // 0007: collector right BC.
        // Default (`exhaust_collector_reflection_coef = 0.0`) preserves
        // the legacy transmissive behavior bit-exactly for parity. Setting
        // a non-zero reflection coefficient (1.0 ≈ low-ka open end per
        // Munjal/Levine-Schwinger) enables exhaust pulse reflection and
        // the associated scavenging benefit at high RPM. Real CBR600 4-2-1
        // exhausts get 10-20% peak-power boost from this physics; the
        // legacy r=0 BC zeros it out.
        {
            let collector = &mut self.pipes[self.collector_idx];
            if cfg.exhaust_collector_reflection_coef > 0.0 {
                fill_open_end_right(collector, cfg.p_ambient,
                                    cfg.exhaust_collector_reflection_coef);
            } else {
                fill_transmissive_right(collector);
            }
        }

        // MUSCL step on every pipe
        for k in 0..self.pipes.len() {
            let pipe = &mut self.pipes[k];
            let sc = &mut self.scratches[k];
            muscl_hancock_step(
                &mut pipe.q, &pipe.area, &pipe.area_f, pipe.dx, dt,
                gamma, pipe.n_ghost, cfg.limiter,
                &mut sc.w, &mut sc.slopes, &mut sc.w_pred_l, &mut sc.w_pred_r,
                &mut sc.flux,
            );
        }

        // collect intake / exhaust flux at the valve faces
        let n_cyl = cfg.n_cylinders;
        let mut intake_flux = vec![0.0_f64; n_cyl];
        let mut intake_flux_t = vec![0.0_f64; n_cyl];
        let mut exhaust_flux = vec![0.0_f64; n_cyl];
        let mut exhaust_flux_t = vec![0.0_f64; n_cyl];
        for i in 0..n_cyl {
            let r_idx = self.runner_idx[i];
            let runner = &self.pipes[r_idx];
            let j_face = runner.n_ghost + runner.n_cells;
            let f0 = self.scratches[r_idx].flux[j_face * N_VARS];
            let f2 = self.scratches[r_idx].flux[j_face * N_VARS + 2];
            intake_flux[i] = f0;
            if f0.abs() > 1e-20 {
                let h = f2 / f0;
                let t_est = h * (gamma - 1.0) / gamma / 287.0;
                intake_flux_t[i] = t_est.max(100.0);
            } else {
                intake_flux_t[i] = self.cylinders[i].state.t_intake;
            }
            let p_idx = self.primary_idx[i];
            let primary = &self.pipes[p_idx];
            let j_face = primary.n_ghost;
            let f0 = self.scratches[p_idx].flux[j_face * N_VARS];
            let f2 = self.scratches[p_idx].flux[j_face * N_VARS + 2];
            exhaust_flux[i] = f0;
            if f0.abs() > 1e-20 {
                let h_ex = f2 / f0;
                let t_ex = h_ex * (gamma - 1.0) / gamma / 287.0;
                exhaust_flux_t[i] = t_ex.max(100.0);
            } else {
                exhaust_flux_t[i] = self.cylinders[i].state.t_exhaust;
            }
        }

        // junctions absorb fluxes
        let flux_refs: Vec<&[f64]> = self.scratches.iter().map(|s| s.flux.as_slice()).collect();
        for j in self.junctions.iter_mut() {
            j.absorb_fluxes(&self.pipes, &flux_refs, dt);
        }

        // restrictor + collector net flow accumulators
        {
            let plenum = &self.pipes[self.plenum_idx];
            let rest_flux = self.scratches[self.plenum_idx]
                .flux[plenum.n_ghost * N_VARS];
            self.mass_in_restrictor += rest_flux * dt;
        }
        {
            let collector = &self.pipes[self.collector_idx];
            let j = collector.n_ghost + collector.n_cells;
            let col_flux = self.scratches[self.collector_idx].flux[j * N_VARS];
            self.mass_out_collector += col_flux * dt;
        }

        // sources on each pipe
        for k in 0..self.pipes.len() {
            let pipe = &mut self.pipes[k];
            apply_sources(
                &mut pipe.q, &pipe.area, &pipe.hydraulic_d, dt, gamma, 287.0,
                pipe.wall_t, pipe.n_ghost,
                true, true,
            );
        }

        let dtheta = dt * (180.0 / PI) * omega_from_rpm(_rpm);
        for i in 0..n_cyl {
            let cyl = &mut self.cylinders[i];
            cyl.state.mdot_intake = intake_flux[i];
            cyl.state.mdot_exhaust = exhaust_flux[i];
            cyl.state.t_intake = intake_flux_t[i];
            cyl.state.t_exhaust = exhaust_flux_t[i];
            cyl.advance(theta_deg, dtheta, _rpm, dt);
        }
    }

    fn reset_flow_accumulators(&mut self) {
        self.mass_in_restrictor = 0.0;
        self.mass_out_collector = 0.0;
    }

    pub fn run_single_rpm(
        &mut self, rpm: f64, n_cycles: usize, verbose: bool,
        convergence_tol_imep: f64, convergence_min_cycles: usize,
        stop_at_convergence: bool,
    ) -> RunResult {
        // Delegate to the externally-drivable cycle stepper so this path
        // and the runner's cycle-by-cycle path share one body. This keeps
        // engine math identical regardless of who drives.
        let mut state = CycleLoopState::new(self);
        let mut cycle_stats: Vec<CycleStats> = Vec::new();
        let mut converged_cycle: i64 = -1;
        let target_theta = (n_cycles as f64) * 720.0;

        while state.theta < target_theta && !state.step_budget_exhausted() {
            match self.advance_one_cycle(rpm, &mut state, Some(target_theta), None, None) {
                CycleOutcome::Cycle(stats) => {
                    if verbose {
                        println!(
                            "  cycle {:3}: IMEP={:6.2} bar  VE={:6.2}%  EGT={:5.0} K  drift={:+.3e}  nonconserv={:+.2e}",
                            stats.cycle, stats.imep_bar, stats.ve_atm * 100.0,
                            stats.egt_mean, stats.mass_drift, stats.nonconservation,
                        );
                    }
                    cycle_stats.push(stats);
                    if stop_at_convergence
                        && cycle_stats.len() >= convergence_min_cycles + 1
                    {
                        let n = cycle_stats.len();
                        let prev_imep = cycle_stats[n - 2].imep_bar;
                        let this_imep = cycle_stats[n - 1].imep_bar;
                        if prev_imep.abs() > 1e-6 {
                            let rel = (this_imep - prev_imep).abs() / prev_imep.abs();
                            if rel < convergence_tol_imep && converged_cycle < 0 {
                                converged_cycle = stats.cycle;
                            }
                        }
                        if converged_cycle > 0 && stats.cycle >= converged_cycle + 1 {
                            break;
                        }
                    }
                }
                CycleOutcome::TargetReached => break,
                CycleOutcome::Cancelled => break,
            }
        }

        RunResult {
            rpm,
            n_cycles_requested: n_cycles,
            n_cycles_run: cycle_stats.len(),
            step_count: state.step_count,
            cycle_stats,
            converged_cycle,
        }
    }

    /// Externally-drivable cycle stepper. Advances the simulation until
    /// theta crosses the next 720° boundary (or `theta_limit` is reached),
    /// returning the just-completed cycle's stats. Per-cycle accumulators
    /// are reset at end-of-cycle, same as in `run_single_rpm`.
    ///
    /// Used by `run_single_rpm` internally and by `cfd-core`'s runner so
    /// the math is shared across both code paths.
    ///
    /// An optional `observer` is invoked after every internal solver step
    /// for capture purposes (P-V loops, wave-frame writers, etc.). Passing
    /// `None` keeps behavior bit-identical to the older signature — the
    /// branch is a single Option check the optimizer elides.
    pub fn advance_one_cycle(
        &mut self,
        rpm: f64,
        state: &mut CycleLoopState,
        theta_limit: Option<f64>,
        mut observer: Option<&mut dyn CycleObserver>,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> CycleOutcome {
        let cfg = self.cfg.clone();
        let omega = omega_from_rpm(rpm);
        loop {
            if state.step_budget_exhausted() {
                return CycleOutcome::TargetReached;
            }
            if let Some(c) = cancel {
                if c.load(std::sync::atomic::Ordering::Relaxed) {
                    return CycleOutcome::Cancelled;
                }
            }
            if let Some(lim) = theta_limit {
                if state.theta >= lim { return CycleOutcome::TargetReached; }
            }
            // dt: min CFL across all pipes
            let mut dt = cfl_dt(
                &self.pipes[self.plenum_idx].q,
                &self.pipes[self.plenum_idx].area,
                self.pipes[self.plenum_idx].dx, 1.4, cfg.cfl,
                self.pipes[self.plenum_idx].n_ghost,
            );
            for p in &self.pipes {
                let d = cfl_dt(&p.q, &p.area, p.dx, 1.4, cfg.cfl, p.n_ghost);
                if d > 0.0 && d < dt {
                    dt = d;
                }
            }
            if dt <= 0.0 {
                panic!("positivity failure at theta={:.1}°", state.theta);
            }
            if dt > 1e-4 { dt = 1e-4; }
            self.step(state.theta, dt, rpm);
            state.step_count += 1;
            state.theta += dt * (180.0 / PI) * omega;
            if let Some(ref mut obs) = observer {
                obs.on_step(state.theta, dt, self);
            }
            let new_cycle = (state.theta / 720.0) as i64;
            if new_cycle > state.prev_cycle {
                let m_now = self.system_mass();
                let net_port = self.mass_in_restrictor - self.mass_out_collector;
                let actual_drift = m_now - state.last_mass_total;
                let v_d_total = self.cylinders[0].geom.v_d() * (cfg.n_cylinders as f64);
                let total_work: f64 = self.cylinders.iter().map(|c| c.state.work_cycle).sum();
                let total_intake: f64 = self.cylinders.iter().map(|c| c.state.m_intake_total).sum();
                let imep_bar = if v_d_total > 0.0 { (total_work / v_d_total) / 1e5 } else { 0.0 };
                let rho_atm = cfg.p_ambient / (287.0 * cfg.t_ambient);
                let ve_atm = if v_d_total > 0.0 { total_intake / (rho_atm * v_d_total) } else { 0.0 };
                let indicated_power_w = total_work * rpm / 120.0;
                let sp = 2.0 * cfg.stroke * rpm / 60.0;
                let fmep_bar = cfg.fmep_a + cfg.fmep_b * sp + cfg.fmep_c * sp * sp;
                let fmep_pa = fmep_bar * 1e5;
                let friction_power_w = fmep_pa * v_d_total * rpm / 120.0;
                let brake_power_w = (indicated_power_w - friction_power_w).max(0.0);
                let omega_rad = 2.0 * PI * rpm / 60.0;
                let indicated_torque_nm = if omega_rad > 0.0 { indicated_power_w / omega_rad } else { 0.0 };
                let brake_torque_nm = if omega_rad > 0.0 { brake_power_w / omega_rad } else { 0.0 };
                let wheel_power_w = brake_power_w * cfg.drivetrain_efficiency;
                let wheel_torque_nm = brake_torque_nm * cfg.drivetrain_efficiency;
                let bmep_bar = if v_d_total > 0.0 {
                    ((total_work - friction_power_w * 120.0 / rpm) / v_d_total) / 1e5
                } else { 0.0 };
                let f_res_mean = {
                    let v: Vec<f64> = self.cylinders.iter().map(|c| c.state.f_residual_at_ivc).collect();
                    if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / (v.len() as f64) }
                };
                let egt_mean = {
                    let v: Vec<f64> = self.primary_idx.iter().map(|&idx| {
                        Self::primary_entrance_t(&self.pipes[idx], 1.4)
                    }).collect();
                    v.iter().sum::<f64>() / (v.len() as f64)
                };
                let stats = CycleStats {
                    cycle: new_cycle,
                    mass_total: m_now,
                    mass_drift: actual_drift,
                    mass_in_restrictor: self.mass_in_restrictor,
                    mass_out_collector: self.mass_out_collector,
                    net_port_flow: net_port,
                    nonconservation: actual_drift - net_port,
                    imep_bar, bmep_bar, fmep_bar,
                    ve_atm,
                    intake_mass_per_cycle_g: total_intake * 1000.0,
                    f_residual: f_res_mean,
                    indicated_power_k_w: indicated_power_w / 1000.0,
                    indicated_power_hp: indicated_power_w / 745.7,
                    brake_power_k_w: brake_power_w / 1000.0,
                    brake_power_hp: brake_power_w / 745.7,
                    wheel_power_k_w: wheel_power_w / 1000.0,
                    wheel_power_hp: wheel_power_w / 745.7,
                    indicated_torque_nm,
                    brake_torque_nm,
                    wheel_torque_nm,
                    egt_mean,
                };
                state.last_mass_total = m_now;
                for c in self.cylinders.iter_mut() {
                    c.state.m_intake_total = 0.0;
                    c.state.m_exhaust_total = 0.0;
                    c.state.work_cycle = 0.0;
                }
                self.reset_flow_accumulators();
                state.prev_cycle = new_cycle;
                return CycleOutcome::Cycle(stats);
            }
        }
    }
}

/// Observer invoked after every internal step in `advance_one_cycle`.
///
/// Implementations are read-only viewers — they MUST NOT mutate the
/// engine. They're used for capture (P-V loops, pipe profiles, wave-
/// frame writers) without touching the parity-locked math.
///
/// The observer is invoked AFTER the step has been applied and AFTER
/// `state.theta` has been updated, so the values reported via the
/// engine and the supplied `theta_global_deg` are consistent.
pub trait CycleObserver {
    fn on_step(&mut self, theta_global_deg: f64, dt: f64, eng: &SDM26Engine);
}

/// State carried across `advance_one_cycle` invocations to preserve
/// the simulation's cycle accounting (theta, mass-drift baseline, etc.).
#[derive(Debug, Clone)]
pub struct CycleLoopState {
    pub theta: f64,
    pub step_count: u64,
    pub prev_cycle: i64,
    pub last_mass_total: f64,
    pub max_steps: u64,
}

impl CycleLoopState {
    pub fn new(engine: &mut SDM26Engine) -> Self {
        engine.reset_flow_accumulators();
        Self {
            theta: 0.0,
            step_count: 0,
            prev_cycle: 0,
            last_mass_total: engine.system_mass(),
            max_steps: 10_000_000,
        }
    }
    pub fn step_budget_exhausted(&self) -> bool {
        self.step_count >= self.max_steps
    }
}

#[derive(Debug, Clone)]
pub enum CycleOutcome {
    Cycle(CycleStats),
    TargetReached,
    /// Cancel atomic was observed `true` partway through the cycle.
    /// No CycleStats are produced — caller should treat this trial/cycle
    /// as aborted.
    Cancelled,
}
