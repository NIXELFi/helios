//! Entropy-aware valve ghost-cell BC. Direct port of `bcs/valve.py`.
//!
//! Both the legacy `fill_valve_ghost` (now only used by old tests) and
//! the characteristic-correct `fill_valve_ghost_characteristic` (the
//! production BC, used by `SDM26Engine`) are ported.

use crate::bcs::simple::{fill_reflective_left, fill_reflective_right};
use crate::cylinder::gas_properties::{gamma_mixture, r_mixture, R_AIR};
use crate::cylinder::valve::{valve_effective_area_profile, ValveParams};
use crate::solver::state::{
    PipeState, N_VARS, I_RHO_A, I_MOM_A, I_E_A, I_Y_A,
};

/// Compressible-orifice mass flow from upstream stagnation to downstream p.
/// `a_eff` is expected to already bake in n_valves · Cd.
pub fn mass_flow_orifice(
    p_up: f64, t_up: f64, p_down: f64,
    a_eff: f64, gamma: f64, r_gas: f64,
) -> f64 {
    if p_up <= 0.0 || a_eff <= 0.0 {
        return 0.0;
    }
    let mut pr = p_down / p_up;
    if pr >= 1.0 {
        return 0.0;
    }
    if pr < 0.0 { pr = 0.0; }
    let pr_crit = (2.0 / (gamma + 1.0)).powf(gamma / (gamma - 1.0));
    let t_up_safe = t_up.max(100.0);
    if pr <= pr_crit {
        let choke = (2.0 / (gamma + 1.0)).powf((gamma + 1.0) / (2.0 * (gamma - 1.0)));
        return a_eff * p_up * (gamma / (r_gas * t_up_safe)).sqrt() * choke;
    }
    let t1 = pr.powf(2.0 / gamma);
    let t2 = pr.powf((gamma + 1.0) / gamma);
    let flow_fn = (2.0 * gamma / (gamma - 1.0) * (t1 - t2)).max(0.0).sqrt();
    a_eff * p_up / (r_gas * t_up_safe).sqrt() * flow_fn
}

fn fill_reflective_at_end(state: &mut PipeState, pipe_end: PipeEndStr) {
    match pipe_end {
        PipeEndStr::Left => fill_reflective_left(state),
        PipeEndStr::Right => fill_reflective_right(state),
    }
}

/// Boundary end as a string-typed enum mirroring Python's "left"/"right".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeEndStr { Left, Right }

impl PipeEndStr {
    pub fn parse(s: &str) -> Self {
        match s {
            "left" => Self::Left,
            "right" => Self::Right,
            _ => panic!("pipe_end must be 'left' or 'right', got {s:?}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValveType { Intake, Exhaust }

impl ValveType {
    pub fn parse(s: &str) -> Self {
        match s {
            "intake" => Self::Intake,
            "exhaust" => Self::Exhaust,
            _ => panic!("valve_type must be 'intake' or 'exhaust', got {s:?}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ValveBC {
    pub pipe_end: PipeEndStr,
    pub valve_type: ValveType,
    pub valve: ValveParams,
}

// --- Legacy (over-determined, acoustically absorbing) ---------------------

#[allow(clippy::too_many_arguments)]
pub fn fill_valve_ghost(
    state: &mut PipeState,
    pipe_end: PipeEndStr,
    valve_type: ValveType,
    vp: &ValveParams,
    theta_local_deg: f64,
    p_cyl: f64, t_cyl: f64, xb_cyl: f64,
) -> f64 {
    let ng = state.n_ghost;
    let n_total = state.n_total();
    let gamma_pipe = state.gamma;
    let seat_rad = vp.seat_angle_deg.to_radians();
    let a_eff = valve_effective_area_profile(
        theta_local_deg, vp.open_angle_deg, vp.close_angle_deg, vp.max_lift,
        vp.diameter, seat_rad, vp.n_valves,
        &vp.ld_table, &vp.cd_table, vp.profile,
    );
    if a_eff < 1e-12 {
        fill_reflective_at_end(state, pipe_end);
        return 0.0;
    }

    let i_real = match pipe_end {
        PipeEndStr::Left => ng,
        PipeEndStr::Right => ng + state.n_cells - 1,
    };
    let a_pipe = state.area[i_real];
    let gm1 = gamma_pipe - 1.0;
    let rho_pipe = state.q[i_real * N_VARS + I_RHO_A] / a_pipe;
    let u_pipe = state.q[i_real * N_VARS + I_MOM_A] / (rho_pipe * a_pipe);
    let big_e_pipe = state.q[i_real * N_VARS + I_E_A] / a_pipe;
    let p_pipe = (gm1 * (big_e_pipe - 0.5 * rho_pipe * u_pipe * u_pipe)).max(1.0);
    let y_pipe = state.q[i_real * N_VARS + I_Y_A] / (rho_pipe * a_pipe);

    let forward = match valve_type {
        ValveType::Exhaust => p_cyl >= p_pipe,
        ValveType::Intake  => p_pipe >= p_cyl,
    };

    let (p_up, t_up, gamma_up, r_up, y_up, p_down) = if forward && valve_type == ValveType::Exhaust {
        (p_cyl, t_cyl, gamma_mixture(t_cyl, xb_cyl), r_mixture(xb_cyl), xb_cyl, p_pipe)
    } else if !forward && valve_type == ValveType::Exhaust {
        let t = (p_pipe / (rho_pipe.max(1e-6) * R_AIR)).max(100.0);
        (p_pipe, t, gamma_pipe, R_AIR, y_pipe, p_cyl)
    } else if forward && valve_type == ValveType::Intake {
        let t = (p_pipe / (rho_pipe.max(1e-6) * R_AIR)).max(100.0);
        (p_pipe, t, gamma_pipe, R_AIR, y_pipe, p_cyl)
    } else {
        (p_cyl, t_cyl, gamma_mixture(t_cyl, xb_cyl), r_mixture(xb_cyl), xb_cyl, p_pipe)
    };

    let mdot = mass_flow_orifice(p_up, t_up, p_down, a_eff, gamma_up, r_up);

    let p_ghost = p_pipe;
    let ratio = (p_ghost / p_up.max(1.0)).max(1e-6);
    let t_ghost = (t_up * ratio.powf(gm1 / gamma_up)).max(100.0);
    let rho_ghost = p_ghost / (r_up * t_ghost);

    let u_mag = if forward {
        mdot / (rho_ghost * a_pipe).max(1e-20)
    } else {
        -mdot / (rho_ghost * a_pipe).max(1e-20)
    };

    let gm1_pipe = gamma_pipe - 1.0;
    let indices: Box<dyn Iterator<Item = usize>> = match pipe_end {
        PipeEndStr::Left => Box::new(0..ng),
        PipeEndStr::Right => Box::new((ng + state.n_cells)..n_total),
    };
    for i in indices {
        let a_g = state.area[i];
        let big_e_ghost = p_ghost / gm1_pipe + 0.5 * rho_ghost * u_mag * u_mag;
        state.q[i * N_VARS + I_RHO_A] = rho_ghost * a_g;
        state.q[i * N_VARS + I_MOM_A] = rho_ghost * u_mag * a_g;
        state.q[i * N_VARS + I_E_A]   = big_e_ghost * a_g;
        state.q[i * N_VARS + I_Y_A]   = rho_ghost * y_up * a_g;
    }
    if forward { mdot } else { -mdot }
}

// --- Characteristic + orifice (Phase C1) ---------------------------------

const A_EFF_CLOSED_M2: f64 = 1.0e-8;
const BISECT_MAX_ITER: usize = 60;
const BISECT_TOL_RESIDUAL_KG_S: f64 = 1.0e-9;
const STARTUP_U_INT_M_S: f64 = 1.0;
const STARTUP_REL_DP: f64 = 1.0e-4;

fn solve_outflow_face(
    rho_int: f64, _u_int: f64, p_int: f64, c_int: f64,
    p_cyl: f64, _t_cyl: f64, a_eff: f64, a_pipe: f64,
    gamma: f64, r_gas: f64, pipe_end: PipeEndStr,
    u_int_signed: f64,
) -> Option<(f64, f64, f64, f64)> {
    let gm1 = gamma - 1.0;
    let sign = match pipe_end { PipeEndStr::Left => 1.0, PipeEndStr::Right => -1.0 };
    let j_int = match pipe_end {
        PipeEndStr::Left  => u_int_signed - 2.0 * c_int / gm1,
        PipeEndStr::Right => u_int_signed + 2.0 * c_int / gm1,
    };

    let char_state = |p_f: f64| -> (f64, f64, f64, f64) {
        let rho_f = rho_int * (p_f / p_int).powf(1.0 / gamma);
        let c_f = (gamma * p_f / rho_f.max(1e-20)).max(1.0).sqrt();
        let u_f = j_int + sign * 2.0 * c_f / gm1;
        let t_f = p_f / (rho_f * r_gas).max(1e-20);
        (rho_f, u_f, c_f, t_f)
    };

    let residual = |p_f: f64| -> f64 {
        let (rho_f, u_f, _, t_f) = char_state(p_f);
        let char_mdot = (rho_f * u_f * a_pipe).abs();
        let orif_mdot = mass_flow_orifice(p_f, t_f, p_cyl, a_eff, gamma, r_gas);
        orif_mdot - char_mdot
    };

    let mut p_lo = p_cyl.max(1.0);
    let mut p_hi = p_int.max(p_lo + 1.0);
    let mut f_lo = residual(p_lo);
    let mut f_hi = residual(p_hi);
    if f_lo * f_hi > 0.0 {
        return None;
    }
    for _ in 0..BISECT_MAX_ITER {
        let p_mid = 0.5 * (p_lo + p_hi);
        let f_mid = residual(p_mid);
        if f_mid.abs() < BISECT_TOL_RESIDUAL_KG_S {
            p_lo = p_mid;
            break;
        }
        if f_lo * f_mid <= 0.0 {
            p_hi = p_mid; f_hi = f_mid;
        } else {
            p_lo = p_mid; f_lo = f_mid;
        }
    }
    let _ = f_hi;
    let p_face = 0.5 * (p_lo + p_hi);
    let (rho_face, u_face, _, t_face) = char_state(p_face);
    Some((rho_face, u_face, p_face, t_face))
}

fn energy_j_inflow(
    u_int: f64, c_int: f64, t_res: f64,
    gamma: f64, r_gas: f64, pipe_end: PipeEndStr,
) -> Option<(f64, f64)> {
    let gm1 = gamma - 1.0;
    let sign = match pipe_end { PipeEndStr::Left => 1.0, PipeEndStr::Right => -1.0 };
    let j_int = match pipe_end {
        PipeEndStr::Left  => u_int - 2.0 * c_int / gm1,
        PipeEndStr::Right => u_int + 2.0 * c_int / gm1,
    };
    let c_0_sq = gamma * r_gas * t_res.max(100.0);
    if c_0_sq <= 0.0 { return None; }
    let a_q = gamma + 1.0;
    let b_q = 2.0 * sign * j_int * gm1;
    let d_q = 0.5 * gm1 * gm1 * j_int * j_int - gm1 * c_0_sq;
    let disc = b_q * b_q - 4.0 * a_q * d_q;
    if disc < 0.0 { return None; }
    let sqrt_disc = disc.sqrt();
    let mut c_face = (-b_q + sqrt_disc) / (2.0 * a_q);
    if c_face <= 0.0 {
        c_face = (-b_q - sqrt_disc) / (2.0 * a_q);
    }
    if c_face <= 0.0 || !c_face.is_finite() {
        return None;
    }
    let u_face = j_int + sign * 2.0 * c_face / gm1;
    if matches!(pipe_end, PipeEndStr::Left)  && u_face <= 0.0 { return None; }
    if matches!(pipe_end, PipeEndStr::Right) && u_face >= 0.0 { return None; }
    Some((c_face, u_face))
}

fn branch_startup(
    p_int: f64, t_cyl: f64,
    rho_int: f64, y_int: f64, xb_cyl: f64,
    r_gas: f64, pipe_side_inflow: bool,
) -> (f64, f64, f64, f64) {
    let (rho_face, y_face) = if pipe_side_inflow {
        (p_int / (r_gas * t_cyl.max(100.0)), xb_cyl)
    } else {
        (rho_int, y_int)
    };
    (rho_face, 0.0, p_int, y_face)
}

fn branch_choked_inflow(
    p_int: f64,
    p_cyl: f64, t_cyl: f64,
    a_eff: f64, a_pipe: f64,
    gamma: f64, r_gas: f64, pipe_end: PipeEndStr,
) -> Option<(f64, f64, f64, f64)> {
    let choke_factor = (2.0 / (gamma + 1.0)).powf((gamma + 1.0) / (2.0 * (gamma - 1.0)));
    let mdot_orifice = a_eff * p_cyl
        * (gamma / (r_gas * t_cyl.max(100.0))).sqrt()
        * choke_factor;
    let pr = (p_int / p_cyl.max(1.0)).max(1e-6);
    let t_face = (t_cyl * pr.powf((gamma - 1.0) / gamma)).max(100.0);
    let rho_face = (p_int / (r_gas * t_face)).max(1e-6);
    let sign = match pipe_end { PipeEndStr::Left => 1.0, PipeEndStr::Right => -1.0 };
    let u_face = sign * mdot_orifice / (rho_face * a_pipe).max(1e-20);
    let p_face = p_int;
    let mdot_face = (rho_face * u_face * a_pipe).abs();
    if mdot_orifice > 0.0 {
        let rel_err = (mdot_face - mdot_orifice).abs() / mdot_orifice;
        if rel_err > 1e-3 {
            return None;
        }
    }
    if !rho_face.is_finite() || !p_face.is_finite() || rho_face <= 0.0 || p_face <= 0.0 {
        return None;
    }
    Some((rho_face, u_face, p_face, mdot_orifice))
}

fn branch_subsonic_inflow(
    u_int: f64, c_int: f64, p_int: f64,
    p_cyl: f64, t_cyl: f64,
    a_eff: f64, a_pipe: f64,
    gamma: f64, r_gas: f64, pipe_end: PipeEndStr,
) -> Option<(f64, f64, f64)> {
    let ej = energy_j_inflow(u_int, c_int, t_cyl, gamma, r_gas, pipe_end)?;
    let (c_face, u_face) = ej;
    let char_u_mag = u_face.abs();
    if char_u_mag < 1e-6 {
        return None;
    }
    let residual = |p_f: f64| -> f64 {
        let rho_f = gamma * p_f / (c_face * c_face);
        let char_mdot = rho_f * char_u_mag * a_pipe;
        let orif_mdot = mass_flow_orifice(p_cyl, t_cyl, p_f, a_eff, gamma, r_gas);
        orif_mdot - char_mdot
    };
    let mut p_lo = p_int.max(1.0);
    let mut p_hi = (p_cyl - 1.0).max(p_lo + 1.0);
    let mut f_lo = residual(p_lo);
    let mut f_hi = residual(p_hi);
    if f_lo * f_hi > 0.0 {
        return None;
    }
    for _ in 0..BISECT_MAX_ITER {
        let p_mid = 0.5 * (p_lo + p_hi);
        let f_mid = residual(p_mid);
        if f_mid.abs() < BISECT_TOL_RESIDUAL_KG_S {
            p_lo = p_mid;
            break;
        }
        if f_lo * f_mid <= 0.0 {
            p_hi = p_mid; f_hi = f_mid;
        } else {
            p_lo = p_mid; f_lo = f_mid;
        }
    }
    let _ = f_hi;
    let p_face = 0.5 * (p_lo + p_hi);
    let rho_face = gamma * p_face / (c_face * c_face);
    Some((rho_face, u_face, p_face))
}

#[allow(clippy::too_many_arguments)]
pub fn fill_valve_ghost_characteristic(
    state: &mut PipeState,
    pipe_end: PipeEndStr,
    _valve_type: ValveType,
    vp: &ValveParams,
    theta_local_deg: f64,
    p_cyl: f64, t_cyl: f64, xb_cyl: f64,
) -> f64 {
    let ng = state.n_ghost;
    let n_total = state.n_total();
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;

    let seat_rad = vp.seat_angle_deg.to_radians();
    let a_eff = valve_effective_area_profile(
        theta_local_deg, vp.open_angle_deg, vp.close_angle_deg, vp.max_lift,
        vp.diameter, seat_rad, vp.n_valves,
        &vp.ld_table, &vp.cd_table, vp.profile,
    );
    if a_eff < A_EFF_CLOSED_M2 {
        fill_reflective_at_end(state, pipe_end);
        return 0.0;
    }

    let i_real = match pipe_end {
        PipeEndStr::Left => ng,
        PipeEndStr::Right => ng + state.n_cells - 1,
    };
    let a_pipe = state.area[i_real];
    let rho_int = state.q[i_real * N_VARS + I_RHO_A] / a_pipe;
    let u_int = state.q[i_real * N_VARS + I_MOM_A] / (rho_int * a_pipe);
    let big_e_int = state.q[i_real * N_VARS + I_E_A] / a_pipe;
    let p_int = (gm1 * (big_e_int - 0.5 * rho_int * u_int * u_int)).max(1.0);
    let y_int = state.q[i_real * N_VARS + I_Y_A] / (rho_int * a_pipe);
    let c_int = (gamma * p_int / rho_int.max(1e-20)).max(1.0).sqrt();

    let p_max = p_cyl.max(p_int).max(1.0);
    let rel_dp = (p_cyl - p_int).abs() / p_max;
    let is_startup = (u_int.abs() < STARTUP_U_INT_M_S) && (rel_dp < STARTUP_REL_DP);
    let pipe_side_inflow = p_cyl > p_int;
    let pr_crit = (2.0 / (gamma + 1.0)).powf(gamma / (gamma - 1.0));
    let pr_orifice = if pipe_side_inflow {
        p_int / p_cyl.max(1.0)
    } else {
        p_cyl / p_int.max(1.0)
    };
    let is_choked = pr_orifice < pr_crit;

    let mut sol: Option<(f64, f64, f64)> = None;
    let mut y_face: f64;

    if is_startup {
        let (rf, uf, pf, yf) = branch_startup(
            p_int, t_cyl, rho_int, y_int, xb_cyl, R_AIR, pipe_side_inflow,
        );
        sol = Some((rf, uf, pf));
        y_face = yf;
    } else if pipe_side_inflow && is_choked {
        if let Some((rf, uf, pf, _mdot)) =
            branch_choked_inflow(p_int, p_cyl, t_cyl, a_eff, a_pipe, gamma, R_AIR, pipe_end)
        {
            sol = Some((rf, uf, pf));
        }
        y_face = xb_cyl;
    } else if pipe_side_inflow && !is_choked {
        if let Some(triple) = branch_subsonic_inflow(
            u_int, c_int, p_int, p_cyl, t_cyl, a_eff, a_pipe, gamma, R_AIR, pipe_end,
        ) {
            sol = Some(triple);
        }
        y_face = xb_cyl;
    } else if !pipe_side_inflow && is_choked {
        if let Some((rf, uf, pf, _t_face)) = solve_outflow_face(
            rho_int, u_int, p_int, c_int, p_cyl, t_cyl,
            a_eff, a_pipe, gamma, R_AIR, pipe_end, u_int,
        ) {
            sol = Some((rf, uf, pf));
        }
        y_face = y_int;
    } else {
        if let Some((rf, uf, pf, _t_face)) = solve_outflow_face(
            rho_int, u_int, p_int, c_int, p_cyl, t_cyl,
            a_eff, a_pipe, gamma, R_AIR, pipe_end, u_int,
        ) {
            sol = Some((rf, uf, pf));
        }
        y_face = y_int;
    }

    if sol.is_none() && pipe_side_inflow {
        if let Some((rf, uf, pf, _mdot)) =
            branch_choked_inflow(p_int, p_cyl, t_cyl, a_eff, a_pipe, gamma, R_AIR, pipe_end)
        {
            sol = Some((rf, uf, pf));
        }
        y_face = xb_cyl;
    }
    if sol.is_none() {
        let (rf, uf, pf, yf) = branch_startup(
            p_int, t_cyl, rho_int, y_int, xb_cyl, R_AIR, pipe_side_inflow,
        );
        sol = Some((rf, uf, pf));
        y_face = yf;
    }
    let (rho_face, u_face, p_face) = sol.unwrap();
    if !rho_face.is_finite() || !p_face.is_finite() || rho_face <= 0.0 || p_face <= 0.0 {
        fill_reflective_at_end(state, pipe_end);
        return 0.0;
    }
    let mdot_signed = rho_face * u_face * a_pipe;
    let indices: Box<dyn Iterator<Item = usize>> = match pipe_end {
        PipeEndStr::Left => Box::new(0..ng),
        PipeEndStr::Right => Box::new((ng + state.n_cells)..n_total),
    };
    let e_face = p_face / gm1 + 0.5 * rho_face * u_face * u_face;
    for i in indices {
        let a_g = state.area[i];
        state.q[i * N_VARS + I_RHO_A] = rho_face * a_g;
        state.q[i * N_VARS + I_MOM_A] = rho_face * u_face * a_g;
        state.q[i * N_VARS + I_E_A]   = e_face * a_g;
        state.q[i * N_VARS + I_Y_A]   = rho_face * y_face * a_g;
    }
    mdot_signed
}
