//! WENO5 reconstruction + SSP-RK2 time integration for quasi-1D Euler.
//!
//! Drop-in alternative to `muscl_hancock_step` for pipes where higher-order
//! spatial accuracy is needed (in particular, exhaust pipes — finding 0007
//! documented that MUSCL-Hancock damps sharp blowdown pulses, costing
//! 3-10 kW at high RPM on the team dyno).
//!
//! Reconstruction: 5th-order WENO of Jiang & Shu (1996, J. Comp. Phys. 126)
//! applied to primitive variables (ρ, u, p, ρY). At cells too close to the
//! pipe boundary for the 5-point stencil to fit, falls back to MUSCL
//! minmod-limited linear reconstruction.
//!
//! Time integration: 2nd-order strong-stability-preserving Runge-Kutta
//! (SSP-RK2 / Heun), matching the 2nd-order time accuracy of the existing
//! MUSCL-Hancock predictor-corrector. Costs ≈ 2× MUSCL-Hancock per step.
//!
//! When this function is used (via the `use_weno5_in_pipes` SDM26Config
//! flag), the parity tests remain green at the flag's default (false) —
//! all existing simulations go through `muscl_hancock_step` unchanged.

use super::hllc::hllc_flux;
use super::muscl::{LIMITER_MINMOD, cfl_dt};
use super::state::N_VARS;

const EPSILON_WENO: f64 = 1e-6;
// Linear (optimal) weights for 5th-order WENO at right-edge of cell j.
const GAMMA_R: [f64; 3] = [0.1, 0.6, 0.3];
// Mirror weights for left-edge reconstruction.
const GAMMA_L: [f64; 3] = [0.3, 0.6, 0.1];

/// WENO5 right-edge (u_{j+1/2}^-) reconstruction.
///   Stencil: {j-2, j-1, j, j+1, j+2}
/// Returns the reconstructed primitive variable value at the right face
/// of cell j.
#[inline]
fn weno5_right_edge(u_m2: f64, u_m1: f64, u_0: f64, u_p1: f64, u_p2: f64) -> f64 {
    // Sub-stencil polynomial values, evaluated at right edge
    let p0 = ( 2.0 * u_m2 - 7.0 * u_m1 + 11.0 * u_0)  / 6.0;
    let p1 = (-1.0 * u_m1 + 5.0 * u_0  +  2.0 * u_p1) / 6.0;
    let p2 = ( 2.0 * u_0  + 5.0 * u_p1 -  1.0 * u_p2) / 6.0;
    // Smoothness indicators (Jiang-Shu)
    let b0 = (13.0/12.0) * (u_m2 - 2.0*u_m1 + u_0).powi(2)
           + 0.25 * (u_m2 - 4.0*u_m1 + 3.0*u_0).powi(2);
    let b1 = (13.0/12.0) * (u_m1 - 2.0*u_0  + u_p1).powi(2)
           + 0.25 * (u_m1 - u_p1).powi(2);
    let b2 = (13.0/12.0) * (u_0  - 2.0*u_p1 + u_p2).powi(2)
           + 0.25 * (3.0*u_0 - 4.0*u_p1 + u_p2).powi(2);
    let a0 = GAMMA_R[0] / (b0 + EPSILON_WENO).powi(2);
    let a1 = GAMMA_R[1] / (b1 + EPSILON_WENO).powi(2);
    let a2 = GAMMA_R[2] / (b2 + EPSILON_WENO).powi(2);
    let sum = a0 + a1 + a2;
    (a0 * p0 + a1 * p1 + a2 * p2) / sum
}

/// WENO5 left-edge (u_{j-1/2}^+) reconstruction.
///   Stencil: {j-2, j-1, j, j+1, j+2}
/// Mirror of right-edge: just swap the input ordering and use mirror weights.
#[inline]
fn weno5_left_edge(u_m2: f64, u_m1: f64, u_0: f64, u_p1: f64, u_p2: f64) -> f64 {
    // Sub-stencil polynomial values, evaluated at LEFT edge (mirror of right-edge)
    let p0 = (11.0 * u_0  - 7.0 * u_p1 +  2.0 * u_p2) / 6.0;
    let p1 = ( 2.0 * u_m1 + 5.0 * u_0  -  1.0 * u_p1) / 6.0;
    let p2 = (-1.0 * u_m2 + 5.0 * u_m1 +  2.0 * u_0)  / 6.0;
    // Smoothness indicators (same form as right-edge, mirrored)
    let b0 = (13.0/12.0) * (u_0  - 2.0*u_p1 + u_p2).powi(2)
           + 0.25 * (3.0*u_0 - 4.0*u_p1 + u_p2).powi(2);
    let b1 = (13.0/12.0) * (u_m1 - 2.0*u_0  + u_p1).powi(2)
           + 0.25 * (u_m1 - u_p1).powi(2);
    let b2 = (13.0/12.0) * (u_m2 - 2.0*u_m1 + u_0).powi(2)
           + 0.25 * (u_m2 - 4.0*u_m1 + 3.0*u_0).powi(2);
    let a0 = GAMMA_L[0] / (b0 + EPSILON_WENO).powi(2);
    let a1 = GAMMA_L[1] / (b1 + EPSILON_WENO).powi(2);
    let a2 = GAMMA_L[2] / (b2 + EPSILON_WENO).powi(2);
    let sum = a0 + a1 + a2;
    (a0 * p0 + a1 * p1 + a2 * p2) / sum
}

#[inline]
fn minmod(a: f64, b: f64) -> f64 {
    if a * b <= 0.0 { 0.0 } else if a.abs() < b.abs() { a } else { b }
}

fn compute_primitives(q: &[f64], area: &[f64], gamma: f64, w_out: &mut [f64]) {
    let n = area.len();
    let gm1 = gamma - 1.0;
    for i in 0..n {
        let a = area[i];
        let rho   = q[i * N_VARS    ] / a;
        let rho_u = q[i * N_VARS + 1] / a;
        let big_e = q[i * N_VARS + 2] / a;
        let rho_y = q[i * N_VARS + 3] / a;
        let u = rho_u / rho;
        let p = gm1 * (big_e - 0.5 * rho_u * rho_u / rho);
        w_out[i * N_VARS    ] = rho;
        w_out[i * N_VARS + 1] = u;
        w_out[i * N_VARS + 2] = p;
        w_out[i * N_VARS + 3] = rho_y;
    }
}

/// Reconstruct primitive values at the LEFT and RIGHT edge of every cell.
/// `w_left[j]`  = primitive at left edge of cell j (= u^+ at face j-1/2)
/// `w_right[j]` = primitive at right edge of cell j (= u^- at face j+1/2)
///
/// Cells [2..n-2] use full WENO5 with the 5-point stencil. Cells at the
/// boundary (0, 1, n-2, n-1) fall back to MUSCL minmod reconstruction
/// (sufficient because they are ghost cells whose values come from BCs).
fn weno5_face_values(
    w: &[f64],
    w_left: &mut [f64],
    w_right: &mut [f64],
) {
    let n = w.len() / N_VARS;
    // Initialise to cell-average (zero-slope) so any cells we don't touch
    // are still safe.
    for i in 0..n {
        for k in 0..N_VARS {
            let u = w[i * N_VARS + k];
            w_left[i * N_VARS + k]  = u;
            w_right[i * N_VARS + k] = u;
        }
    }
    // Interior cells with full 5-point stencil
    for j in 2..(n - 2) {
        for k in 0..N_VARS {
            let u_m2 = w[(j - 2) * N_VARS + k];
            let u_m1 = w[(j - 1) * N_VARS + k];
            let u_0  = w[ j      * N_VARS + k];
            let u_p1 = w[(j + 1) * N_VARS + k];
            let u_p2 = w[(j + 2) * N_VARS + k];
            w_right[j * N_VARS + k] = weno5_right_edge(u_m2, u_m1, u_0, u_p1, u_p2);
            w_left [j * N_VARS + k] = weno5_left_edge (u_m2, u_m1, u_0, u_p1, u_p2);
        }
    }
    // Boundary fallback: cells {1, n-2} get MUSCL minmod
    for &j in &[1_usize, n - 2] {
        for k in 0..N_VARS {
            let u_m1 = w[(j - 1) * N_VARS + k];
            let u_0  = w[ j      * N_VARS + k];
            let u_p1 = w[(j + 1) * N_VARS + k];
            let slope = minmod(u_0 - u_m1, u_p1 - u_0);
            w_left [j * N_VARS + k] = u_0 - 0.5 * slope;
            w_right[j * N_VARS + k] = u_0 + 0.5 * slope;
        }
    }
    // Cells {0, n-1} keep cell-average (first-order) — they are ghost cells.
}

/// Evaluate the spatial operator L(q) = -∂/∂x(F(q)) + sources
/// (without area gradient — Hancock-style; area source added in caller).
/// Writes the rate `dq/dt` into `dqdt`.
#[allow(clippy::too_many_arguments)]
fn weno5_rhs(
    q: &[f64],
    area: &[f64],
    area_f: &[f64],
    dx: f64,
    gamma: f64,
    n_ghost: usize,
    w: &mut [f64],
    w_left: &mut [f64],
    w_right: &mut [f64],
    flux: &mut [f64],
    dqdt: &mut [f64],
) {
    let n = area.len();
    let inv_dx = 1.0 / dx;
    // 1. Primitives
    compute_primitives(q, area, gamma, w);
    // 2. WENO5 face values (per-cell, left/right of each cell)
    weno5_face_values(w, w_left, w_right);
    // 3. HLLC flux at each face j (between cell j-1 and j)
    for j in 1..n {
        let mut rho_l   = w_right[(j - 1) * N_VARS    ];
        let mut u_l     = w_right[(j - 1) * N_VARS + 1];
        let mut p_l     = w_right[(j - 1) * N_VARS + 2];
        let mut rho_y_l = w_right[(j - 1) * N_VARS + 3];
        let mut rho_r   = w_left[j * N_VARS    ];
        let mut u_r     = w_left[j * N_VARS + 1];
        let mut p_r     = w_left[j * N_VARS + 2];
        let mut rho_y_r = w_left[j * N_VARS + 3];
        // Positivity safety: fall back to cell-average if WENO overshoots
        if rho_l <= 0.0 || p_l <= 0.0 || rho_r <= 0.0 || p_r <= 0.0 {
            rho_l   = w[(j - 1) * N_VARS    ];
            u_l     = w[(j - 1) * N_VARS + 1];
            p_l     = w[(j - 1) * N_VARS + 2];
            rho_y_l = w[(j - 1) * N_VARS + 3];
            rho_r   = w[j * N_VARS    ];
            u_r     = w[j * N_VARS + 1];
            p_r     = w[j * N_VARS + 2];
            rho_y_r = w[j * N_VARS + 3];
        }
        let y_l = rho_y_l / rho_l;
        let y_r = rho_y_r / rho_r;
        let (f0, f1, f2, f3) = hllc_flux(rho_l, u_l, p_l, y_l, rho_r, u_r, p_r, y_r, gamma);
        let af = area_f[j];
        flux[j * N_VARS    ] = f0 * af;
        flux[j * N_VARS + 1] = f1 * af;
        flux[j * N_VARS + 2] = f2 * af;
        flux[j * N_VARS + 3] = f3 * af;
    }
    // 4. Conservative-update rate on real cells, plus quasi-1D area source
    for i in 0..n {
        for k in 0..N_VARS {
            dqdt[i * N_VARS + k] = 0.0;
        }
    }
    for i in n_ghost..(n - n_ghost) {
        // Flux divergence
        dqdt[i * N_VARS    ] -= inv_dx * (flux[(i + 1) * N_VARS    ] - flux[i * N_VARS    ]);
        dqdt[i * N_VARS + 1] -= inv_dx * (flux[(i + 1) * N_VARS + 1] - flux[i * N_VARS + 1]);
        dqdt[i * N_VARS + 2] -= inv_dx * (flux[(i + 1) * N_VARS + 2] - flux[i * N_VARS + 2]);
        dqdt[i * N_VARS + 3] -= inv_dx * (flux[(i + 1) * N_VARS + 3] - flux[i * N_VARS + 3]);
        // Quasi-1D area source (p · dA/dx) on momentum
        let da_dx = (area_f[i + 1] - area_f[i]) * inv_dx;
        dqdt[i * N_VARS + 1] += w[i * N_VARS + 2] * da_dx;
    }
}

/// One WENO5 + SSP-RK2 step.
///
/// SSP-RK2 (Shu-Osher):
///   q^(1)   = q^n + dt · L(q^n)
///   q^{n+1} = (1/2) · q^n + (1/2) · q^(1) + (1/2) · dt · L(q^(1))
///         = q^n - dt · ( (1/2)·div(F₁) + (1/2)·div(F₂) )
///
/// On return, the `flux` buffer holds the AVERAGE flux (F₁+F₂)/2 that
/// actually drives the conservative update. Downstream consumers
/// (junctions, valve mass-flow integrators, accumulators) read this
/// buffer as if it were the single representative flux for the step —
/// matching the MUSCL-Hancock convention.
///
/// `q_temp`, `dqdt`, `flux_avg`, `w`, `w_left`, `w_right`, `flux` are
/// scratch buffers (caller-owned).
#[allow(clippy::too_many_arguments)]
pub fn weno5_ssprk2_step(
    q: &mut [f64],
    area: &[f64],
    area_f: &[f64],
    dx: f64,
    dt: f64,
    gamma: f64,
    n_ghost: usize,
    q_temp: &mut [f64],
    dqdt: &mut [f64],
    flux_accum: &mut [f64],
    w: &mut [f64],
    w_left: &mut [f64],
    w_right: &mut [f64],
    flux: &mut [f64],
) {
    let n = q.len();
    // Stage 1: q^(1) = q^n + dt · L(q^n)
    weno5_rhs(q, area, area_f, dx, gamma, n_ghost, w, w_left, w_right, flux, dqdt);
    for i in 0..flux.len() { flux_accum[i] = 0.5 * flux[i]; }
    for i in 0..n { q_temp[i] = q[i] + dt * dqdt[i]; }
    // Stage 2: q^{n+1} = (1/2) q^n + (1/2) q^(1) + (1/2) dt L(q^(1))
    weno5_rhs(q_temp, area, area_f, dx, gamma, n_ghost, w, w_left, w_right, flux, dqdt);
    for i in 0..flux.len() { flux_accum[i] += 0.5 * flux[i]; }
    for i in 0..n {
        q[i] = 0.5 * q[i] + 0.5 * q_temp[i] + 0.5 * dt * dqdt[i];
    }
    // Leave the average flux in `flux` for downstream consumers.
    for i in 0..flux.len() { flux[i] = flux_accum[i]; }
    let _ = LIMITER_MINMOD;
    let _ = cfl_dt;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weno5_constant_input_returns_constant() {
        // u(x) = c → both face reconstructions return c
        for c in [1.0_f64, -3.5, 100.0] {
            assert!((weno5_right_edge(c, c, c, c, c) - c).abs() < 1e-12);
            assert!((weno5_left_edge (c, c, c, c, c) - c).abs() < 1e-12);
        }
    }

    #[test]
    fn weno5_linear_input_is_exact() {
        // u(x) = a*x + b: cell-averages on uniform grid with dx=1, centred at
        // x_i = i: u_i = a*i + b. Reconstruction at right edge of cell j (x=j+0.5)
        // should give a*(j+0.5) + b.
        let a = 0.7;
        let b = -2.0;
        let cell = |i: i32| a * (i as f64) + b;
        let j = 0_i32;
        let recon_r = weno5_right_edge(cell(j - 2), cell(j - 1), cell(j),
                                       cell(j + 1), cell(j + 2));
        let exact_r = a * (j as f64 + 0.5) + b;
        assert!((recon_r - exact_r).abs() < 1e-10,
                "WENO5 right-edge on linear input: got {}, expected {}", recon_r, exact_r);
        let recon_l = weno5_left_edge(cell(j - 2), cell(j - 1), cell(j),
                                      cell(j + 1), cell(j + 2));
        let exact_l = a * (j as f64 - 0.5) + b;
        assert!((recon_l - exact_l).abs() < 1e-10,
                "WENO5 left-edge on linear input: got {}, expected {}", recon_l, exact_l);
    }

    #[test]
    fn weno5_quadratic_input_is_close() {
        // u(x) = x²: cell-average over cell [i-1/2, i+1/2] is
        //   u_bar_i = ∫ x² dx / dx = i² + 1/12
        // WENO5 reconstruction from cell-averages should recover the
        // point value u(x_{j+1/2}) = (j+0.5)² to machine precision
        // (WENO5 is exact for polynomials up to degree 4 in smooth flow).
        let cell_avg = |i: i32| (i as f64).powi(2) + 1.0 / 12.0;
        let j = 5_i32;
        let recon_r = weno5_right_edge(cell_avg(j - 2), cell_avg(j - 1), cell_avg(j),
                                       cell_avg(j + 1), cell_avg(j + 2));
        let exact_r = (j as f64 + 0.5).powi(2);
        assert!((recon_r - exact_r).abs() < 1e-10,
                "WENO5 quadratic right-edge: got {}, expected {}", recon_r, exact_r);
        let recon_l = weno5_left_edge(cell_avg(j - 2), cell_avg(j - 1), cell_avg(j),
                                      cell_avg(j + 1), cell_avg(j + 2));
        let exact_l = (j as f64 - 0.5).powi(2);
        assert!((recon_l - exact_l).abs() < 1e-10,
                "WENO5 quadratic left-edge: got {}, expected {}", recon_l, exact_l);
    }
}
