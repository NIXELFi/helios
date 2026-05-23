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
    restrictor_mdot_full(p_down, p_0, t_0, a_t, cd, gamma, r_gas, 0.0)
}

/// As `restrictor_mdot`, but with an optional Mach-dependent Cd correction.
///
/// Effective Cd: `Cd_eff = Cd · (1 − k · M_t^2)` where M_t is the throat Mach
/// computed from the un-corrected mdot and `k = cd_mach_k`. Default `k = 0`
/// keeps bit-identical parity with the legacy formula. NASA TM X-1570 /
/// Cruz-Maya et al. (2006) give `k ≈ 0.30-0.40` for subsonic venturi flow:
/// real Cd drops a few percent as throat Mach approaches 1.0. One fixed-point
/// iteration is enough; the correction is monotone and converges in 2-3
/// passes for any physical M_t.
pub fn restrictor_mdot_full(
    p_down: f64, p_0: f64, t_0: f64,
    a_t: f64, cd: f64, gamma: f64, r_gas: f64,
    cd_mach_k: f64,
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
    // Inner closure: compute mdot at a given effective Cd.
    let mdot_at = |cd_eff: f64| -> f64 {
        if pr <= critical_pressure_ratio(gamma) {
            cd_eff * a_t * p_0 * (gamma / (r_gas * t_0)).sqrt() * choke_factor(gamma)
        } else {
            let t1 = pr.powf(2.0 / gamma);
            let t2 = pr.powf(gp1 / gamma);
            let inner = 2.0 * gamma / gm1 * (t1 - t2);
            let flow_fn = inner.max(0.0).sqrt();
            cd_eff * a_t * p_0 / (r_gas * t_0).sqrt() * flow_fn
        }
    };
    if cd_mach_k <= 0.0 {
        return mdot_at(cd);
    }
    // Mach-correction fixed-point: 2 iterations is plenty.
    let mut cd_eff = cd;
    for _ in 0..3 {
        let mdot = mdot_at(cd_eff);
        if mdot <= 0.0 { break; }
        // Throat Mach from mdot: ρ_t * u_t * A_t = mdot, with ρ_t and c_t
        // following the isentropic expansion from stagnation.
        // Use the throat static-to-stagnation relations at the actual pr
        // (subsonic) or at the critical pr (choked).
        let pr_eff = pr.max(critical_pressure_ratio(gamma));
        let t_t = t_0 * pr_eff.powf(gm1 / gamma);
        let rho_t = p_0 * pr_eff / (r_gas * t_t.max(1.0));
        let c_t = (gamma * r_gas * t_t.max(1.0)).sqrt();
        let u_t = mdot / (rho_t * cd_eff * a_t).max(1e-9);
        let m_t = (u_t / c_t).min(1.0).max(0.0);
        let new_cd_eff = (cd * (1.0 - cd_mach_k * m_t * m_t)).max(0.5 * cd);
        if (new_cd_eff - cd_eff).abs() < 1e-6 {
            cd_eff = new_cd_eff;
            break;
        }
        cd_eff = new_cd_eff;
    }
    mdot_at(cd_eff)
}

pub fn fill_choked_restrictor_left(
    state: &mut PipeState,
    p_0: f64, t_0: f64,
    a_t: f64, cd: f64,
    loss_coef: f64,
) -> f64 {
    fill_choked_restrictor_left_full(state, p_0, t_0, a_t, cd, loss_coef, 0.0)
}

/// As `fill_choked_restrictor_left`, but with optional Mach-Cd correction.
/// `cd_mach_k = 0.0` (default) preserves legacy parity. NASA TM X-1570
/// recommends `k ≈ 0.30` for subsonic venturi at M_t ≤ 0.9.
pub fn fill_choked_restrictor_left_full(
    state: &mut PipeState,
    p_0: f64, t_0: f64,
    a_t: f64, cd: f64,
    loss_coef: f64,
    cd_mach_k: f64,
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

    let mut mdot = restrictor_mdot_full(p_src, p_0, t_0, a_t, cd, gamma, r_gas, cd_mach_k);

    if loss_coef > 0.0 && mdot > 0.0 {
        let pr_crit = (2.0 / (gamma + 1.0)).powf(gamma / (gamma - 1.0));
        if p_src / p_0 > pr_crit {
            let rho_0 = p_0 / (r_gas * t_0);
            let u_throat = mdot / (rho_0 * cd * a_t);
            let dp_loss = loss_coef * 0.5 * rho_0 * u_throat * u_throat;
            let p_0_eff = (p_0 - dp_loss).max(p_src + 1.0);
            mdot = restrictor_mdot_full(p_src, p_0_eff, t_0, a_t, cd, gamma, r_gas, cd_mach_k);
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
