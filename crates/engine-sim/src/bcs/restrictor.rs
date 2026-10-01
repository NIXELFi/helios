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

// ---------------------------------------------------------------------------
// Finding 0032 fix 2: converging-diverging venturi restrictor.
// ---------------------------------------------------------------------------

/// Static-pressure recovery fraction R of the restrictor diffuser,
/// defined by p_plenum - p_throat = R * (p0 - p_throat).
///
/// With an explicit diffuser efficiency eta_d: R = eta_d * (1 - sigma^2)
/// (eta_d times the ideal Bernoulli recovery to the exit area). Otherwise
/// from the Idelchik conical-diffuser loss K = phi(alpha) * (1 - sigma)^2
/// referenced to throat dynamic head: R = (1 - sigma^2) - phi * (1 - sigma)^2.
/// sigma = A_throat / A_exit. Clamped to [0, 0.99].
pub fn venturi_recovery_fraction(sigma: f64, phi: f64, eta: Option<f64>) -> f64 {
    let s = sigma.clamp(0.0, 1.0);
    let r = match eta {
        Some(e) => e.clamp(0.0, 1.0) * (1.0 - s * s),
        None => (1.0 - s * s) - phi.max(0.0) * (1.0 - s) * (1.0 - s),
    };
    r.clamp(0.0, 0.99)
}

/// Mass flow through a venturi restrictor discharging into a plenum at
/// static pressure `p_plenum`. The throat static pressure follows from the
/// diffuser recovery, p_t = (p_plenum - R p0) / (1 - R); the converging
/// nozzle is isentropic from (p0, T0) to p_t with discharge coefficient
/// `cd`. Choking occurs once p_t/p0 <= (2/(g+1))^(g/(g-1)), i.e. at
/// p_plenum/p0 = pr* + R (1 - pr*) (about 0.94 for a good diffuser), not at
/// the nozzle-into-dump value 0.528. Returns (mdot, p_throat, choked).
#[allow(clippy::too_many_arguments)]
pub fn venturi_restrictor_mdot(
    p_plenum: f64, p0: f64, t0: f64,
    a_t: f64, cd: f64, gamma: f64, r_gas: f64, recovery: f64,
) -> (f64, f64, bool) {
    if p0 <= 0.0 || a_t <= 0.0 || cd <= 0.0 || p_plenum >= p0 {
        return (0.0, p_plenum.min(p0), false);
    }
    let r = recovery.clamp(0.0, 0.99);
    let p_t = ((p_plenum - r * p0) / (1.0 - r)).max(0.0);
    let pr_star = critical_pressure_ratio(gamma);
    let choked = p_t / p0 <= pr_star;
    let mdot = restrictor_mdot_full(p_t, p0, t0, a_t, cd, gamma, r_gas, 0.0);
    // Once choked the physical throat pressure is p* (a shock stands in the
    // diffuser); report that rather than the unphysical recovery inverse.
    let p_t_phys = if choked { pr_star * p0 } else { p_t };
    (mdot, p_t_phys, choked)
}

/// Finding 0039: venturi mass flow with the inertia of its air column.
///
/// The quasi-steady venturi follows the instantaneous plenum pressure, so a
/// pulsating plenum drags its flow up and down the (concave) steady curve and
/// the cycle mean falls 1-7 % below the steady flow at the mean pressure.
/// Transient CFD of the same part (300 Hz, +-5 kPa) shows the real flow
/// swings about 0.4 of that and lags by a quarter cycle: the air column in
/// the diffuser low-pass filters the pulsation.
///
/// Model: unsteady Bernoulli for that column,
///     I dmdot/dt = p_sustain(mdot) - p_plenum,   I = integral dx / A  [1/m]
/// where p_sustain(mdot) is the plenum pressure at which the quasi-steady
/// venturi delivers mdot (the inverse of venturi_restrictor_mdot). Steady
/// state is exactly the quasi-steady curve; mdot is clamped to [0, choked].
/// Explicit Euler: the time constant I / |dp/dmdot| is about 1 ms, the
/// solver step about 1e-6..1e-5 s.
#[allow(clippy::too_many_arguments)]
pub fn venturi_mdot_inertial(
    mdot_prev: f64, p_plenum: f64, p0: f64, t0: f64,
    a_t: f64, cd: f64, gamma: f64, r_gas: f64, recovery: f64,
    inertance: f64, dt: f64,
) -> f64 {
    let r = recovery.clamp(0.0, 0.99);
    let pr_star = critical_pressure_ratio(gamma);
    let p_onset = p0 * (pr_star + r * (1.0 - pr_star));
    let (m_star, _, _) = venturi_restrictor_mdot(0.5 * p_onset, p0, t0, a_t, cd, gamma, r_gas, recovery);
    let m = mdot_prev.clamp(0.0, m_star);
    // pressure the venturi sustains at flow m: bisection on the monotone steady curve
    let p_sustain = if m >= m_star * (1.0 - 1e-9) {
        p_onset
    } else if m <= 0.0 {
        p0
    } else {
        let (mut lo, mut hi) = (p_onset, p0);          // mdot(lo) = m_star >= m >= mdot(hi) = 0
        for _ in 0..40 {
            let mid = 0.5 * (lo + hi);
            let (mm, _, _) = venturi_restrictor_mdot(mid, p0, t0, a_t, cd, gamma, r_gas, recovery);
            if mm > m { lo = mid } else { hi = mid }
        }
        0.5 * (lo + hi)
    };
    (m + dt * (p_sustain - p_plenum) / inertance.max(1e-9)).clamp(0.0, m_star)
}

/// Static pressure in the first plenum cell (the venturi's back pressure).
pub fn venturi_plenum_face_pressure(state: &PipeState) -> f64 {
    let src = state.n_ghost;
    let gm1 = state.gamma - 1.0;
    let a_src = state.area[src];
    let rho_src = state.q[src * N_VARS + I_RHO_A] / a_src;
    let u_src = state.q[src * N_VARS + I_MOM_A] / (rho_src * a_src);
    let big_e_src = state.q[src * N_VARS + I_E_A] / a_src;
    (gm1 * (big_e_src - 0.5 * rho_src * u_src * u_src)).max(1e-9)
}

/// Plenum-LEFT ghost for a GIVEN venturi mass flow (finding 0039, used with
/// venturi_mdot_inertial). Same ghost construction as
/// fill_venturi_restrictor_left: plenum-face static pressure and a static
/// temperature that conserves stagnation enthalpy.
pub fn fill_venturi_restrictor_left_with_mdot(state: &mut PipeState, t_0: f64, mdot: f64) -> f64 {
    let ng = state.n_ghost;
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let r_gas = state.r_gas;
    let cp = gamma * r_gas / gm1;
    let p_ghost = venturi_plenum_face_pressure(state);
    for i in 0..ng {
        let a_g = state.area[i];
        let g = mdot * r_gas / (p_ghost * a_g);
        let k = g * g / (2.0 * cp);
        let t_ghost = if k > 1e-30 {
            ((-1.0 + (1.0 + 4.0 * k * t_0).sqrt()) / (2.0 * k)).max(1.0)
        } else {
            t_0
        };
        let rho_ghost = p_ghost / (r_gas * t_ghost);
        let u_ghost = mdot / (rho_ghost * a_g);
        let big_e_ghost = p_ghost / gm1 + 0.5 * rho_ghost * u_ghost * u_ghost;
        state.q[i * N_VARS + I_RHO_A] = rho_ghost * a_g;
        state.q[i * N_VARS + I_MOM_A] = rho_ghost * u_ghost * a_g;
        state.q[i * N_VARS + I_E_A]   = big_e_ghost * a_g;
        state.q[i * N_VARS + I_Y_A]   = 0.0;
    }
    mdot
}

/// Plenum-LEFT ghost state for the venturi restrictor. The ghost carries
/// the plenum-face static pressure, the venturi mass flow, and a static
/// temperature that CONSERVES STAGNATION ENTHALPY: T = T0 - u^2/(2 c_p)
/// (the adiabatic restrictor neither adds nor removes energy). Solved in
/// closed form from k T^2 + T - T0 = 0 with k = (mdot R / (p A))^2 / (2 c_p).
pub fn fill_venturi_restrictor_left(
    state: &mut PipeState,
    p_0: f64, t_0: f64,
    a_t: f64, cd: f64, recovery: f64,
) -> f64 {
    let ng = state.n_ghost;
    let gamma = state.gamma;
    let gm1 = gamma - 1.0;
    let r_gas = state.r_gas;
    let cp = gamma * r_gas / gm1;

    let src = ng;
    let a_src = state.area[src];
    let rho_src = state.q[src * N_VARS + I_RHO_A] / a_src;
    let u_src = state.q[src * N_VARS + I_MOM_A] / (rho_src * a_src);
    let big_e_src = state.q[src * N_VARS + I_E_A] / a_src;
    let p_src = (gm1 * (big_e_src - 0.5 * rho_src * u_src * u_src)).max(1e-3 * p_0);

    let (mdot, _p_t, _choked) =
        venturi_restrictor_mdot(p_src, p_0, t_0, a_t, cd, gamma, r_gas, recovery);

    let p_ghost = p_src;
    for i in 0..ng {
        let a_g = state.area[i];
        let g = mdot * r_gas / (p_ghost * a_g);
        let k = g * g / (2.0 * cp);
        let t_ghost = if k > 1e-30 {
            ((-1.0 + (1.0 + 4.0 * k * t_0).sqrt()) / (2.0 * k)).max(1.0)
        } else {
            t_0
        };
        let rho_ghost = p_ghost / (r_gas * t_ghost);
        let u_ghost = mdot / (rho_ghost * a_g);
        let big_e_ghost = p_ghost / gm1 + 0.5 * rho_ghost * u_ghost * u_ghost;
        state.q[i * N_VARS + I_RHO_A] = rho_ghost * a_g;
        state.q[i * N_VARS + I_MOM_A] = rho_ghost * u_ghost * a_g;
        state.q[i * N_VARS + I_E_A]   = big_e_ghost * a_g;
        state.q[i * N_VARS + I_Y_A]   = 0.0;
    }
    mdot
}

#[cfg(test)]
mod venturi_tests {
    use super::*;
    use crate::solver::state::{make_pipe_state, set_uniform};

    const G: f64 = 1.4;
    const R: f64 = 287.0;

    fn a_t() -> f64 { 0.25 * std::f64::consts::PI * 0.02 * 0.02 }

    /// 0039: at a constant plenum pressure the inertial venturi relaxes onto
    /// the quasi-steady curve, and under a fast pressure oscillation its flow
    /// swings less than the quasi-steady flow does.
    #[test]
    fn venturi_inertia_relaxes_to_steady_and_filters_pulsation() {
        let (p0, t0, cd, rec, inert) = (97_300.0, 305.0, 0.95, 0.572, 270.0);
        let p = 0.92 * p0;
        let (m_qs, _, _) = venturi_restrictor_mdot(p, p0, t0, a_t(), cd, G, R, rec);
        let mut m = 0.5 * m_qs;
        for _ in 0..20_000 { m = venturi_mdot_inertial(m, p, p0, t0, a_t(), cd, G, R, rec, inert, 1e-6); }
        assert!((m / m_qs - 1.0).abs() < 1e-6, "{m} vs {m_qs}");
        // 300 Hz, +-5 kPa: quasi-steady swing vs inertial swing over the last cycle
        let (mut lo, mut hi, mut qlo, mut qhi) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        let dt = 1e-6; let n = (4.0 / 300.0 / dt) as usize;
        for k in 0..n {
            let pk = p + 5_000.0 * (2.0 * std::f64::consts::PI * 300.0 * k as f64 * dt).sin();
            m = venturi_mdot_inertial(m, pk, p0, t0, a_t(), cd, G, R, rec, inert, dt);
            if k > n * 3 / 4 {
                let q = venturi_restrictor_mdot(pk, p0, t0, a_t(), cd, G, R, rec).0;
                lo = lo.min(m); hi = hi.max(m); qlo = qlo.min(q); qhi = qhi.max(q);
            }
        }
        assert!((hi - lo) < 0.6 * (qhi - qlo), "inertial swing {} vs quasi-steady {}", hi - lo, qhi - qlo);
    }

    /// FSAE 20 mm, Cd = 1, 293 K, 1 atm: isentropic choked ceiling
    /// mdot* = A p0 sqrt(g/(R T0)) (2/(g+1))^((g+1)/(2(g-1))) = 0.0752 kg/s.
    /// The venturi model must hit exactly this ceiling once choked.
    #[test]
    fn venturi_choked_ceiling_matches_isentropic_theory() {
        let rec = venturi_recovery_fraction(0.0628, 0.134, None);
        let (m, pt, choked) = venturi_restrictor_mdot(60_000.0, 101_325.0, 293.0, a_t(), 1.0, G, R, rec);
        assert!(choked);
        let theory = a_t() * 101_325.0 * (G / (R * 293.0)).sqrt()
            * (2.0 / (G + 1.0)).powf((G + 1.0) / (2.0 * (G - 1.0)));
        assert!((m - theory).abs() < 1e-12, "{m} vs {theory}");
        assert!((m - 0.0752).abs() < 5e-5, "ceiling {m}");
        assert!((pt / 101_325.0 - critical_pressure_ratio(G)).abs() < 1e-12);
    }

    /// Choke onset: with recovery R the throat reaches p* while the plenum
    /// is still at p0 (pr* + R (1 - pr*)). For sigma = 0.063 and a 6 deg
    /// diffuser (phi = 0.134) that is about 95.5 kPa, a realistic FSAE
    /// plenum pressure, vs 53.5 kPa for the legacy nozzle-into-dump model.
    #[test]
    fn venturi_chokes_at_realistic_plenum_pressure() {
        let p0 = 101_325.0;
        let rec = venturi_recovery_fraction(0.0628, 0.134, None);
        let pr_star = critical_pressure_ratio(G);
        let p_choke = p0 * (pr_star + rec * (1.0 - pr_star));
        assert!(p_choke > 93_000.0 && p_choke < 97_000.0, "choke onset {p_choke}");
        let (_, _, c_hi) = venturi_restrictor_mdot(p_choke + 50.0, p0, 293.0, a_t(), 1.0, G, R, rec);
        let (_, _, c_lo) = venturi_restrictor_mdot(p_choke - 50.0, p0, 293.0, a_t(), 1.0, G, R, rec);
        assert!(!c_hi && c_lo);
        // The legacy model at the same plenum pressure is far from choked
        // and passes much less air (no diffuser recovery).
        let legacy = restrictor_mdot(p_choke, p0, 293.0, a_t(), 1.0, G, R);
        let (venturi, _, _) = venturi_restrictor_mdot(p_choke, p0, 293.0, a_t(), 1.0, G, R, rec);
        assert!(venturi > 1.5 * legacy, "venturi {venturi} vs legacy {legacy}");
    }

    /// Diffuser recovery: steady subsonic flow recovers
    /// p_plenum - p_t = R (p0 - p_t) exactly, and R sits below the ideal
    /// Bernoulli recovery (1 - sigma^2) by the Idelchik loss phi (1 - sigma)^2.
    #[test]
    fn venturi_diffuser_recovers_pressure_with_idelchik_loss() {
        let sigma: f64 = 0.0628;
        let phi = 0.134;
        let rec = venturi_recovery_fraction(sigma, phi, None);
        assert!((rec - ((1.0 - sigma * sigma) - phi * (1.0 - sigma).powi(2))).abs() < 1e-15);
        assert!(rec > 0.85 && rec < 0.9, "R = {rec}");
        let p0 = 101_325.0;
        let p_pl = 99_000.0;
        let (m, p_t, choked) = venturi_restrictor_mdot(p_pl, p0, 300.0, a_t(), 0.95, G, R, rec);
        assert!(!choked && m > 0.0);
        assert!(p_t < p_pl, "throat {p_t} must sit below plenum {p_pl}");
        assert!(((p_pl - p_t) - rec * (p0 - p_t)).abs() < 1e-6);
        // No reverse flow through the restrictor.
        assert_eq!(venturi_restrictor_mdot(p0 + 10.0, p0, 300.0, a_t(), 0.95, G, R, rec).0, 0.0);
        // Explicit efficiency form.
        let rec_eta = venturi_recovery_fraction(sigma, phi, Some(0.85));
        assert!((rec_eta - 0.85 * (1.0 - sigma * sigma)).abs() < 1e-15);
    }

    /// The inlet ghost must carry the reservoir stagnation temperature:
    /// c_p T + u^2/2 = c_p T0 (the legacy BC set T isentropically from
    /// p/p0 and dropped the plenum T0 by several K at part load).
    #[test]
    fn venturi_ghost_conserves_stagnation_temperature() {
        let d = 0.02;
        let mut pipe = make_pipe_state(
            20, 0.3, |_x| 0.25 * std::f64::consts::PI * d * d * 1.2, G, R, 300.0, 2,
        );
        set_uniform(&mut pipe, 95_000.0 / (R * 295.0), 30.0, 95_000.0, 0.0);
        let t0 = 300.0;
        let rec = venturi_recovery_fraction(0.8, 0.134, None);
        let m = fill_venturi_restrictor_left(&mut pipe, 101_325.0, t0, a_t(), 0.95, rec);
        assert!(m > 0.0);
        let cp = G * R / (G - 1.0);
        for i in 0..pipe.n_ghost {
            let a = pipe.area[i];
            let rho = pipe.q[i * N_VARS + I_RHO_A] / a;
            let u = pipe.q[i * N_VARS + I_MOM_A] / (rho * a);
            let e = pipe.q[i * N_VARS + I_E_A] / a;
            let p = (G - 1.0) * (e - 0.5 * rho * u * u);
            let t = p / (rho * R);
            let t0_ghost = t + u * u / (2.0 * cp);
            assert!((t0_ghost - t0).abs() < 1e-9, "T0 ghost {t0_ghost}");
            assert!((rho * u * a - m).abs() < 1e-12);
            assert!(u > 10.0, "narrow test pipe must carry real velocity, u = {u}");
        }
    }
}
