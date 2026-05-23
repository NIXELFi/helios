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

/// 0007: Open-end pipe BC with NSCBC-style characteristic decomposition
/// and continuous reflection coefficient.
///
/// The legacy `fill_transmissive_right` copies the interior state into
/// ghost cells, which gives reflection coefficient r=0 — fully
/// non-reflecting / "anechoic". That is the WRONG limit for a low-
/// Helmholtz-number open end like an exhaust collector outlet, where
/// linear acoustics demand r ≈ −1 (pressure inversion): an incident
/// compression pulse reflects as an expansion wave that aids scavenging
/// during the next overlap event (Annand & Roe 1974; Blair 1999).
///
/// **The naive linear formulation `p_ghost = 2·p_atm − p_interior` reflects
/// BOTH the AC (pulse) and the DC (steady outflow back-pressure)
/// components**. Reflecting the DC component traps mass in the pipe and
/// destroys the mean outflow — verified empirically in the 0007
/// reflection sweep at multiplier ≥ 0.3.
///
/// The fix is to decompose into acoustic characteristics around the
/// atmospheric far-field state (ρ_atm, u_atm=0, p_atm):
///   p'_out = p_interior − p_atm        (outgoing pressure perturbation)
///   u'_out = u_interior                (outgoing velocity perturbation)
///   forward acoustic wave: p_f = ½·(p'_out + ρ·c·u'_out)
/// Then the open-end inversion reflects the forward wave with sign −1
/// times `reflection_coef`:
///   p_b = −reflection_coef · p_f       (backward wave)
/// Reconstruct ghost perturbation:
///   p'_ghost = p_f + p_b               (pressure perturbation)
///   u'_ghost = (p_f − p_b) / (ρ·c)     (velocity perturbation)
///
/// At `reflection_coef = 0`: p_b = 0 → ghost perturbation = forward only
/// → no reflection (matches transmissive limit). At `reflection_coef = 1`:
/// p'_ghost = p_f − p_f = 0 → ghost pressure exactly p_atm (full
/// pressure-release) BUT velocity perturbation doubles → momentum flux
/// flips → outgoing wave fully inverted. Critically: when the perturbation
/// p_f is zero (steady DC outflow with p_interior ≈ p_atm), nothing is
/// reflected, so mean flow is preserved.
///
/// `ρ_ghost` and `Y_ghost` are extrapolated from interior (entropy and
/// composition cross the BC unchanged in this isentropic-acoustic limit).
///
/// Geometric / non-tuned default: at SDM26 collector geometry (50 mm)
/// and CBR600 exhaust-pulse frequencies (~400-600 Hz), `ka ≪ 1` →
/// `reflection_coef ≈ 1.0` per Munjal §2.7 radiation impedance.
pub fn fill_open_end_right(state: &mut PipeState, p_atm: f64, reflection_coef: f64) {
    let ng = state.n_ghost;
    let nc = state.n_cells;
    let n_total = state.n_total();
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let r = reflection_coef.clamp(0.0, 1.0);

    let src = ng + nc - 1;
    let a_src = state.area[src];
    let rho = (state.q[src * N_VARS + I_RHO_A] / a_src).max(1e-6);
    let u = state.q[src * N_VARS + I_MOM_A] / (rho * a_src);
    let big_e = state.q[src * N_VARS + I_E_A] / a_src;
    let p_interior = (gm1 * (big_e - 0.5 * rho * u * u)).max(1.0);
    let y = state.q[src * N_VARS + I_Y_A] / (rho * a_src);
    let c = (gamma * p_interior / rho).sqrt().max(1e-6);

    // Acoustic characteristic decomposition around p_atm reference.
    let p_prime = p_interior - p_atm;          // outgoing pressure perturbation
    let u_prime = u;                            // outgoing velocity perturbation (u_atm = 0)
    // Forward (outgoing) and backward (reflected, incoming) acoustic waves.
    let p_f = 0.5 * (p_prime + rho * c * u_prime);
    let p_b = -r * p_f;                          // open-end inversion × magnitude
    // Reconstruct ghost perturbation: p' = p_f + p_b, u' = (p_f − p_b) / (ρ·c).
    let p_ghost = (p_atm + (p_f + p_b)).max(0.1 * p_atm);
    let u_ghost = (p_f - p_b) / (rho * c);
    // Density: extrapolated (isentropic-acoustic approximation conserves
    // entropy across the BC for the outgoing characteristic).
    let rho_ghost = rho;

    for i in (ng + nc)..n_total {
        let a_g = state.area[i];
        state.q[i * N_VARS + I_RHO_A] = rho_ghost * a_g;
        state.q[i * N_VARS + I_MOM_A] = rho_ghost * u_ghost * a_g;
        state.q[i * N_VARS + I_E_A]   = (p_ghost / gm1 + 0.5 * rho_ghost * u_ghost * u_ghost) * a_g;
        state.q[i * N_VARS + I_Y_A]   = rho_ghost * y * a_g;
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
