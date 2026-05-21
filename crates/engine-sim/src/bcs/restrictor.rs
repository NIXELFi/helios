//! Choked / subsonic restrictor BC. Direct port of `bcs/restrictor.py`.

use crate::solver::state::{
    PipeState, N_VARS, I_RHO_A, I_MOM_A, I_E_A, I_Y_A,
};

#[inline]
fn critical_pressure_ratio(gamma: f64) -> f64 {
    (2.0 / (gamma + 1.0)).powf(gamma / (gamma - 1.0))
}

#[inline]
fn choke_factor(gamma: f64) -> f64 {
    (2.0 / (gamma + 1.0)).powf((gamma + 1.0) / (2.0 * (gamma - 1.0)))
}

pub fn restrictor_mdot(
    p_down: f64, p_0: f64, t_0: f64,
    a_t: f64, cd: f64, gamma: f64, r_gas: f64,
) -> f64 {
    if p_0 <= 0.0 || a_t <= 0.0 || cd <= 0.0 {
        return 0.0;
    }
    let mut pr = p_down / p_0;
    if pr < 0.0 { pr = 0.0; }
    let gm1 = gamma - 1.0;
    let gp1 = gamma + 1.0;
    if pr >= 1.0 {
        return 0.0;
    }
    if pr <= critical_pressure_ratio(gamma) {
        return cd * a_t * p_0 * (gamma / (r_gas * t_0)).sqrt() * choke_factor(gamma);
    }
    let t1 = pr.powf(2.0 / gamma);
    let t2 = pr.powf(gp1 / gamma);
    let inner = 2.0 * gamma / gm1 * (t1 - t2);
    let flow_fn = inner.max(0.0).sqrt();
    cd * a_t * p_0 / (r_gas * t_0).sqrt() * flow_fn
}

pub fn fill_choked_restrictor_left(
    state: &mut PipeState,
    p_0: f64, t_0: f64,
    a_t: f64, cd: f64,
    loss_coef: f64,
) -> f64 {
    let ng = state.n_ghost;
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let r_gas = state.r_gas;

    let src = ng;
    let a_src = state.area[src];
    let rho_src = state.q[src * N_VARS + I_RHO_A] / a_src;
    let u_src = state.q[src * N_VARS + I_MOM_A] / (rho_src * a_src);
    let big_e_src = state.q[src * N_VARS + I_E_A] / a_src;
    let mut p_src = gm1 * (big_e_src - 0.5 * rho_src * u_src * u_src);
    p_src = p_src.max(1e-3 * p_0);

    let mut mdot = restrictor_mdot(p_src, p_0, t_0, a_t, cd, gamma, r_gas);

    if loss_coef > 0.0 && mdot > 0.0 {
        let pr_crit = (2.0 / (gamma + 1.0)).powf(gamma / (gamma - 1.0));
        if p_src / p_0 > pr_crit {
            let rho_0 = p_0 / (r_gas * t_0);
            let u_throat = mdot / (rho_0 * cd * a_t);
            let dp_loss = loss_coef * 0.5 * rho_0 * u_throat * u_throat;
            let p_0_eff = (p_0 - dp_loss).max(p_src + 1.0);
            mdot = restrictor_mdot(p_src, p_0_eff, t_0, a_t, cd, gamma, r_gas);
        }
    }

    let p_ghost = p_src;
    let t_ghost = (t_0 * (p_ghost / p_0).powf(gm1 / gamma)).max(1.0);
    let rho_ghost = p_ghost / (r_gas * t_ghost);

    for i in 0..ng {
        let a_g = state.area[i];
        let u_ghost = mdot / (rho_ghost * a_g);
        let big_e_ghost = p_ghost / gm1 + 0.5 * rho_ghost * u_ghost * u_ghost;
        state.q[i * N_VARS + I_RHO_A] = rho_ghost * a_g;
        state.q[i * N_VARS + I_MOM_A] = rho_ghost * u_ghost * a_g;
        state.q[i * N_VARS + I_E_A]   = big_e_ghost * a_g;
        state.q[i * N_VARS + I_Y_A]   = 0.0;
    }
    mdot
}
