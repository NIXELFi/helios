//! MUSCL-Hancock predictor-corrector with slope-limited linear reconstruction.
//! Direct port of `solver/muscl.py`.
//!
//! State layout: q has shape (n_total * 4), flat; channels 0..3 are
//! (ρA, ρuA, EA, ρYA). Reconstruction stores primitives (ρ, u, p, ρY) —
//! channel 3 is ρY (conservative), not Y (primitive). See the Python
//! module docstring for why.

use super::hllc::hllc_flux;
use super::state::N_VARS;

pub const LIMITER_MINMOD: i32 = 0;
pub const LIMITER_VAN_LEER: i32 = 1;
pub const LIMITER_SUPERBEE: i32 = 2;

#[inline]
fn minmod(a: f64, b: f64) -> f64 {
    if a * b <= 0.0 {
        return 0.0;
    }
    if a.abs() < b.abs() { a } else { b }
}

#[inline]
fn van_leer(a: f64, b: f64) -> f64 {
    if a * b <= 0.0 {
        return 0.0;
    }
    2.0 * a * b / (a + b)
}

#[inline]
fn superbee(a: f64, b: f64) -> f64 {
    if a * b <= 0.0 {
        return 0.0;
    }
    let lim1 = if (2.0 * a).abs() < b.abs() { 2.0 * a } else { b };
    let lim2 = if a.abs() < (2.0 * b).abs() { a } else { 2.0 * b };
    if lim1.abs() > lim2.abs() { lim1 } else { lim2 }
}

#[inline]
fn limit(a: f64, b: f64, limiter: i32) -> f64 {
    if limiter == LIMITER_VAN_LEER {
        van_leer(a, b)
    } else if limiter == LIMITER_SUPERBEE {
        superbee(a, b)
    } else {
        minmod(a, b)
    }
}

fn compute_primitives(q: &[f64], area: &[f64], gamma: f64, w_out: &mut [f64]) {
    let n = area.len();
    let gm1 = gamma - 1.0;
    for i in 0..n {
        let a = area[i];
        let rho = q[i * N_VARS] / a;
        let rho_u = q[i * N_VARS + 1] / a;
        let big_e = q[i * N_VARS + 2] / a;
        let rho_y = q[i * N_VARS + 3] / a;
        let u = rho_u / rho;
        let p = gm1 * (big_e - 0.5 * rho_u * rho_u / rho);
        w_out[i * N_VARS]     = rho;
        w_out[i * N_VARS + 1] = u;
        w_out[i * N_VARS + 2] = p;
        w_out[i * N_VARS + 3] = rho_y;
    }
}

fn reconstruct_slopes(w: &[f64], slopes: &mut [f64], limiter: i32) {
    let n = w.len() / N_VARS;
    for i in 1..(n - 1) {
        for k in 0..N_VARS {
            let a = w[i * N_VARS + k] - w[(i - 1) * N_VARS + k];
            let b = w[(i + 1) * N_VARS + k] - w[i * N_VARS + k];
            slopes[i * N_VARS + k] = limit(a, b, limiter);
        }
    }
    for k in 0..N_VARS {
        slopes[k] = 0.0;
        slopes[(n - 1) * N_VARS + k] = 0.0;
    }
}

/// One MUSCL-Hancock + HLLC step for quasi-1D Euler.
/// Ghost cells must be filled by the caller before entry.
#[allow(clippy::too_many_arguments)]
pub fn muscl_hancock_step(
    q: &mut [f64],
    area: &[f64],
    area_f: &[f64],
    dx: f64,
    dt: f64,
    gamma: f64,
    n_ghost: usize,
    limiter: i32,
    w: &mut [f64],
    slopes: &mut [f64],
    w_pred_l: &mut [f64],
    w_pred_r: &mut [f64],
    flux: &mut [f64],
) {
    let n = area.len();

    // Step 1: primitives
    compute_primitives(q, area, gamma, w);

    // Step 2: slopes
    reconstruct_slopes(w, slopes, limiter);

    // Step 3: Hancock predictor.
    let half_dt_dx = 0.5 * dt / dx;
    for i in 0..n {
        let rho   = w[i * N_VARS];
        let u     = w[i * N_VARS + 1];
        let p     = w[i * N_VARS + 2];
        let rho_y = w[i * N_VARS + 3];
        let srho   = slopes[i * N_VARS];
        let su     = slopes[i * N_VARS + 1];
        let sp     = slopes[i * N_VARS + 2];
        let srho_y = slopes[i * N_VARS + 3];

        let drho   = -half_dt_dx * (u * srho + rho * su);
        let du     = -half_dt_dx * (u * su + sp / rho);
        let dp     = -half_dt_dx * (u * sp + gamma * p * su);
        let drho_y = -half_dt_dx * (u * srho_y + rho_y * su);

        w_pred_l[i * N_VARS]     = rho   + drho   - 0.5 * srho;
        w_pred_l[i * N_VARS + 1] = u     + du     - 0.5 * su;
        w_pred_l[i * N_VARS + 2] = p     + dp     - 0.5 * sp;
        w_pred_l[i * N_VARS + 3] = rho_y + drho_y - 0.5 * srho_y;
        w_pred_r[i * N_VARS]     = rho   + drho   + 0.5 * srho;
        w_pred_r[i * N_VARS + 1] = u     + du     + 0.5 * su;
        w_pred_r[i * N_VARS + 2] = p     + dp     + 0.5 * sp;
        w_pred_r[i * N_VARS + 3] = rho_y + drho_y + 0.5 * srho_y;
    }

    // Step 4: corrector — HLLC at each face.
    for j in 1..n {
        let mut rho_l   = w_pred_r[(j - 1) * N_VARS];
        let mut u_l     = w_pred_r[(j - 1) * N_VARS + 1];
        let mut p_l     = w_pred_r[(j - 1) * N_VARS + 2];
        let mut rho_y_l = w_pred_r[(j - 1) * N_VARS + 3];
        let mut rho_r   = w_pred_l[j * N_VARS];
        let mut u_r     = w_pred_l[j * N_VARS + 1];
        let mut p_r     = w_pred_l[j * N_VARS + 2];
        let mut rho_y_r = w_pred_l[j * N_VARS + 3];
        if rho_l <= 0.0 || p_l <= 0.0 || rho_r <= 0.0 || p_r <= 0.0 {
            rho_l   = w[(j - 1) * N_VARS];
            u_l     = w[(j - 1) * N_VARS + 1];
            p_l     = w[(j - 1) * N_VARS + 2];
            rho_y_l = w[(j - 1) * N_VARS + 3];
            rho_r   = w[j * N_VARS];
            u_r     = w[j * N_VARS + 1];
            p_r     = w[j * N_VARS + 2];
            rho_y_r = w[j * N_VARS + 3];
        }
        let y_l = rho_y_l / rho_l;
        let y_r = rho_y_r / rho_r;
        let (f0, f1, f2, f3) = hllc_flux(rho_l, u_l, p_l, y_l, rho_r, u_r, p_r, y_r, gamma);
        let af = area_f[j];
        flux[j * N_VARS]     = f0 * af;
        flux[j * N_VARS + 1] = f1 * af;
        flux[j * N_VARS + 2] = f2 * af;
        flux[j * N_VARS + 3] = f3 * af;
    }

    // Step 5: conservative update on real cells.
    let inv_dx = 1.0 / dx;
    for i in n_ghost..(n - n_ghost) {
        q[i * N_VARS]     -= dt * inv_dx * (flux[(i + 1) * N_VARS]     - flux[i * N_VARS]);
        q[i * N_VARS + 1] -= dt * inv_dx * (flux[(i + 1) * N_VARS + 1] - flux[i * N_VARS + 1]);
        let da_dx = (area_f[i + 1] - area_f[i]) * inv_dx;
        q[i * N_VARS + 1] += dt * w[i * N_VARS + 2] * da_dx;
        q[i * N_VARS + 2] -= dt * inv_dx * (flux[(i + 1) * N_VARS + 2] - flux[i * N_VARS + 2]);
        q[i * N_VARS + 3] -= dt * inv_dx * (flux[(i + 1) * N_VARS + 3] - flux[i * N_VARS + 3]);
    }
}

/// CFL-limited time step: dt = cfl · dx / max(|u|+a) over real cells.
/// Returns 0.0 as a signal if positivity is violated in any real cell.
pub fn cfl_dt(
    q: &[f64], area: &[f64], dx: f64, gamma: f64,
    cfl_number: f64, n_ghost: usize,
) -> f64 {
    let n = area.len();
    let gm1 = gamma - 1.0;
    let mut max_speed = 1e-30_f64;
    for i in n_ghost..(n - n_ghost) {
        let a = area[i];
        let rho = q[i * N_VARS] / a;
        let rho_u = q[i * N_VARS + 1] / a;
        let big_e = q[i * N_VARS + 2] / a;
        let u = rho_u / rho;
        let p = gm1 * (big_e - 0.5 * rho_u * rho_u / rho);
        if p <= 0.0 || rho <= 0.0 {
            return 0.0;
        }
        let a_sound = (gamma * p / rho).sqrt();
        let s = u.abs() + a_sound;
        if s > max_speed {
            max_speed = s;
        }
    }
    cfl_number * dx / max_speed
}
