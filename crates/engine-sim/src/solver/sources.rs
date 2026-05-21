//! Source terms for friction and wall heat transfer in quasi-1D pipes.
//! Direct port of `solver/sources.py`.

use std::f64::consts::PI;

use super::muscl::muscl_hancock_step;
use super::state::N_VARS;

pub const R_AIR_DEFAULT: f64 = 287.0;

#[inline]
fn friction_factor_blasius(re: f64) -> f64 {
    if re < 1.0 {
        return 0.0;
    }
    if re < 2300.0 {
        return 64.0 / re;
    }
    0.3164 * re.powf(-0.25)
}

#[inline]
fn dynamic_viscosity_air(t: f64) -> f64 {
    1.8e-5 * (t / 293.0).powf(0.7)
}

#[inline]
fn thermal_conductivity_air(t: f64) -> f64 {
    0.026 * (t / 300.0).powf(0.7)
}

#[inline]
fn nusselt_dittus_boelter(re: f64) -> f64 {
    if re < 1.0 {
        return 0.0;
    }
    0.023 * re.powf(0.8) * 0.71_f64.powf(0.4)
}

/// Explicit ODE integration of friction + wall heat sources over Δt.
#[allow(clippy::too_many_arguments)]
pub fn apply_sources(
    q: &mut [f64],
    area: &[f64],
    hyd_d: &[f64],
    dt: f64,
    gamma: f64,
    r_gas: f64,
    t_wall: f64,
    n_ghost: usize,
    apply_friction: bool,
    apply_heat: bool,
) {
    let n = area.len();
    let gm1 = gamma - 1.0;
    for i in n_ghost..(n - n_ghost) {
        let a = area[i];
        let d = hyd_d[i];
        if d <= 0.0 || a <= 0.0 {
            continue;
        }
        let rho = q[i * N_VARS] / a;
        if rho <= 0.0 {
            continue;
        }
        let u = q[i * N_VARS + 1] / (rho * a);
        let big_e = q[i * N_VARS + 2] / a;
        let p = gm1 * (big_e - 0.5 * rho * u * u);
        if p <= 0.0 {
            continue;
        }
        let t = p / (rho * r_gas);

        if apply_friction {
            let mu = dynamic_viscosity_air(t);
            let mu_safe = if mu > 1e-20 { mu } else { 1e-20 };
            let re = rho * u.abs() * d / mu_safe;
            let f = friction_factor_blasius(re);
            let dmom_a_dt = -a * f * rho * u.abs() * u / (2.0 * d);
            q[i * N_VARS + 1] += dt * dmom_a_dt;
        }

        if apply_heat {
            let mu = dynamic_viscosity_air(t);
            let mu_safe = if mu > 1e-20 { mu } else { 1e-20 };
            let re = rho * u.abs() * d / mu_safe;
            let nu = nusselt_dittus_boelter(re);
            let k = thermal_conductivity_air(t);
            let h_forced = nu * k / d;
            let h_floor = k / d;
            let h = if h_forced > h_floor { h_forced } else { h_floor };
            let p_w = PI * d;
            let d_e_a_dt = -h * p_w * (t - t_wall);
            q[i * N_VARS + 2] += dt * d_e_a_dt;
        }
    }
}

/// Strang-split step: source(dt/2) · hyperbolic(dt) · source(dt/2).
#[allow(clippy::too_many_arguments)]
pub fn strang_split_step(
    q: &mut [f64],
    area: &[f64],
    area_f: &[f64],
    hyd_d: &[f64],
    dx: f64,
    dt: f64,
    gamma: f64,
    r_gas: f64,
    t_wall: f64,
    n_ghost: usize,
    limiter: i32,
    apply_friction: bool,
    apply_heat: bool,
    w: &mut [f64],
    slopes: &mut [f64],
    w_pred_l: &mut [f64],
    w_pred_r: &mut [f64],
    flux: &mut [f64],
) {
    apply_sources(q, area, hyd_d, 0.5 * dt, gamma, r_gas, t_wall, n_ghost,
                  apply_friction, apply_heat);
    muscl_hancock_step(q, area, area_f, dx, dt, gamma, n_ghost, limiter,
                       w, slopes, w_pred_l, w_pred_r, flux);
    apply_sources(q, area, hyd_d, 0.5 * dt, gamma, r_gas, t_wall, n_ghost,
                  apply_friction, apply_heat);
}
