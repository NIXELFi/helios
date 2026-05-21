//! Simple ghost-cell BCs: transmissive (zero-gradient) and reflective (wall).
//! Direct port of `bcs/simple.py`.

use crate::solver::state::{
    PipeState, N_VARS, I_RHO_A, I_MOM_A, I_E_A, I_Y_A,
};

pub fn fill_transmissive_left(state: &mut PipeState) {
    let ng = state.n_ghost;
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let src = ng;
    let a_src = state.area[src];
    let rho = state.q[src * N_VARS + I_RHO_A] / a_src;
    let u = state.q[src * N_VARS + I_MOM_A] / (rho * a_src);
    let big_e = state.q[src * N_VARS + I_E_A] / a_src;
    let p = gm1 * (big_e - 0.5 * rho * u * u);
    let y = state.q[src * N_VARS + I_Y_A] / (rho * a_src);
    for i in 0..ng {
        let a_g = state.area[i];
        state.q[i * N_VARS + I_RHO_A] = rho * a_g;
        state.q[i * N_VARS + I_MOM_A] = rho * u * a_g;
        state.q[i * N_VARS + I_E_A]   = (p / gm1 + 0.5 * rho * u * u) * a_g;
        state.q[i * N_VARS + I_Y_A]   = rho * y * a_g;
    }
}

pub fn fill_transmissive_right(state: &mut PipeState) {
    let ng = state.n_ghost;
    let nc = state.n_cells;
    let n_total = state.n_total();
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let src = ng + nc - 1;
    let a_src = state.area[src];
    let rho = state.q[src * N_VARS + I_RHO_A] / a_src;
    let u = state.q[src * N_VARS + I_MOM_A] / (rho * a_src);
    let big_e = state.q[src * N_VARS + I_E_A] / a_src;
    let p = gm1 * (big_e - 0.5 * rho * u * u);
    let y = state.q[src * N_VARS + I_Y_A] / (rho * a_src);
    for i in (ng + nc)..n_total {
        let a_g = state.area[i];
        state.q[i * N_VARS + I_RHO_A] = rho * a_g;
        state.q[i * N_VARS + I_MOM_A] = rho * u * a_g;
        state.q[i * N_VARS + I_E_A]   = (p / gm1 + 0.5 * rho * u * u) * a_g;
        state.q[i * N_VARS + I_Y_A]   = rho * y * a_g;
    }
}

pub fn fill_reflective_left(state: &mut PipeState) {
    let ng = state.n_ghost;
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    for k in 0..ng {
        let i_g = ng - 1 - k;
        let i_r = ng + k;
        let a_r = state.area[i_r];
        let rho = state.q[i_r * N_VARS + I_RHO_A] / a_r;
        let u = state.q[i_r * N_VARS + I_MOM_A] / (rho * a_r);
        let big_e = state.q[i_r * N_VARS + I_E_A] / a_r;
        let p = gm1 * (big_e - 0.5 * rho * u * u);
        let y = state.q[i_r * N_VARS + I_Y_A] / (rho * a_r);
        let a_g = state.area[i_g];
        state.q[i_g * N_VARS + I_RHO_A] = rho * a_g;
        state.q[i_g * N_VARS + I_MOM_A] = -rho * u * a_g;
        state.q[i_g * N_VARS + I_E_A]   = (p / gm1 + 0.5 * rho * u * u) * a_g;
        state.q[i_g * N_VARS + I_Y_A]   = rho * y * a_g;
    }
}

pub fn fill_reflective_right(state: &mut PipeState) {
    let ng = state.n_ghost;
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let nc = state.n_cells;
    for k in 0..ng {
        let i_g = ng + nc + k;
        let i_r = ng + nc - 1 - k;
        let a_r = state.area[i_r];
        let rho = state.q[i_r * N_VARS + I_RHO_A] / a_r;
        let u = state.q[i_r * N_VARS + I_MOM_A] / (rho * a_r);
        let big_e = state.q[i_r * N_VARS + I_E_A] / a_r;
        let p = gm1 * (big_e - 0.5 * rho * u * u);
        let y = state.q[i_r * N_VARS + I_Y_A] / (rho * a_r);
        let a_g = state.area[i_g];
        state.q[i_g * N_VARS + I_RHO_A] = rho * a_g;
        state.q[i_g * N_VARS + I_MOM_A] = -rho * u * a_g;
        state.q[i_g * N_VARS + I_E_A]   = (p / gm1 + 0.5 * rho * u * u) * a_g;
        state.q[i_g * N_VARS + I_Y_A]   = rho * y * a_g;
    }
}
