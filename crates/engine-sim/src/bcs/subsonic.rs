//! Subsonic inflow + back-pressure outflow BCs. Direct port of `bcs/subsonic.py`.

use crate::solver::state::{
    PipeState, N_VARS, I_RHO_A, I_MOM_A, I_E_A, I_Y_A,
};

/// 4-primitive imposition (legacy, acoustically absorbing — kept for
/// existing driven-flow tests).
pub fn fill_subsonic_inflow_left(
    state: &mut PipeState, rho: f64, u: f64, p: f64, y: f64,
) {
    let ng = state.n_ghost;
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let big_e = p / gm1 + 0.5 * rho * u * u;
    for i in 0..ng {
        let a = state.area[i];
        state.q[i * N_VARS + I_RHO_A] = rho * a;
        state.q[i * N_VARS + I_MOM_A] = rho * u * a;
        state.q[i * N_VARS + I_E_A]   = big_e * a;
        state.q[i * N_VARS + I_Y_A]   = rho * y * a;
    }
}

/// Characteristic-based subsonic inflow at the LEFT boundary
/// (Phase C2 fix). `u` argument is ignored (stagnation reservoir).
pub fn fill_subsonic_inflow_left_characteristic(
    state: &mut PipeState, rho: f64, _u: f64, p: f64, y: f64,
) {
    let ng = state.n_ghost;
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let r_gas = state.r_gas;

    let rho_res = rho.max(1e-20);
    let p_res = p.max(1.0);
    let t_res = p_res / (rho_res * r_gas);

    let a_pipe = state.area[ng];
    let rho_int = state.q[ng * N_VARS + I_RHO_A] / a_pipe;
    let u_int = state.q[ng * N_VARS + I_MOM_A] / (rho_int * a_pipe);
    let big_e_int = state.q[ng * N_VARS + I_E_A] / a_pipe;
    let p_int = (gm1 * (big_e_int - 0.5 * rho_int * u_int * u_int)).max(1.0);
    let c_int = (gamma * p_int / rho_int.max(1e-20)).max(1.0).sqrt();

    let j_minus = u_int - 2.0 * c_int / gm1;

    let c_0_sq = gamma * r_gas * t_res.max(100.0);
    let a_q = gamma + 1.0;
    let b_q = 2.0 * j_minus * gm1;
    let d_q = 0.5 * gm1 * gm1 * j_minus * j_minus - gm1 * c_0_sq;
    let disc = b_q * b_q - 4.0 * a_q * d_q;

    let mut use_fallback = false;
    let mut rho_face = 0.0;
    let mut u_face = 0.0;
    let mut p_face = 0.0;
    if disc >= 0.0 {
        let sqrt_disc = disc.sqrt();
        let mut c_face = (-b_q + sqrt_disc) / (2.0 * a_q);
        if c_face <= 0.0 {
            c_face = (-b_q - sqrt_disc) / (2.0 * a_q);
        }
        if c_face > 0.0 && c_face.is_finite() {
            let u_f = j_minus + 2.0 * c_face / gm1;
            if u_f > 0.0 {
                let k_entropy = p_res / rho_res.powf(gamma);
                let rho_f = (c_face * c_face / (gamma * k_entropy)).powf(1.0 / gm1);
                let p_f = k_entropy * rho_f.powf(gamma);
                if rho_f.is_finite() && p_f.is_finite() && rho_f > 0.0 && p_f > 0.0 {
                    rho_face = rho_f;
                    u_face = u_f;
                    p_face = p_f;
                } else {
                    use_fallback = true;
                }
            } else {
                use_fallback = true;
            }
        } else {
            use_fallback = true;
        }
    } else {
        use_fallback = true;
    }

    if use_fallback {
        rho_face = rho_res;
        u_face = 0.0;
        p_face = p_res;
    }

    let y_face = y;
    let big_e_face = p_face / gm1 + 0.5 * rho_face * u_face * u_face;
    for i in 0..ng {
        let a = state.area[i];
        state.q[i * N_VARS + I_RHO_A] = rho_face * a;
        state.q[i * N_VARS + I_MOM_A] = rho_face * u_face * a;
        state.q[i * N_VARS + I_E_A]   = big_e_face * a;
        state.q[i * N_VARS + I_Y_A]   = rho_face * y_face * a;
    }
}

/// Subsonic outflow: impose p in ghost cells, extrapolate ρ, u, Y.
pub fn fill_subsonic_outflow_right(state: &mut PipeState, p_back: f64) {
    let ng = state.n_ghost;
    let nc = state.n_cells;
    let n_total = state.n_total();
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let src = ng + nc - 1;
    let a_src = state.area[src];
    let rho = state.q[src * N_VARS + I_RHO_A] / a_src;
    let u = state.q[src * N_VARS + I_MOM_A] / (rho * a_src);
    let y = state.q[src * N_VARS + I_Y_A] / (rho * a_src);
    let p = p_back;
    let big_e = p / gm1 + 0.5 * rho * u * u;
    for i in (ng + nc)..n_total {
        let a = state.area[i];
        state.q[i * N_VARS + I_RHO_A] = rho * a;
        state.q[i * N_VARS + I_MOM_A] = rho * u * a;
        state.q[i * N_VARS + I_E_A]   = big_e * a;
        state.q[i * N_VARS + I_Y_A]   = rho * y * a;
    }
}
