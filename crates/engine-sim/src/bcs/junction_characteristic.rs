//! Characteristic-coupled constant-static-pressure junction BC.
//! Direct port of `bcs/junction_characteristic.py`.
//!
//! Lifecycle mirrors `JunctionCV` so callers can swap them:
//!   * `fill_ghosts(pipes, dt)` — secant Newton on p_j, write ghosts.
//!   * `absorb_fluxes(_pipes, _flux_arrays, _dt)` — no-op.

use crate::bcs::junction_cv::PipeEnd;
use crate::solver::hllc::hllc_flux;
use crate::solver::state::{
    PipeState, N_VARS, I_RHO_A, I_MOM_A, I_E_A, I_Y_A,
};

#[derive(Debug, Clone)]
pub struct JunctionConvergenceError {
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct JunctionAllChokedError {
    pub message: String,
}

#[derive(Debug, Clone, Copy)]
pub struct CharJunctionLeg {
    pub pipe_idx: usize,
    pub end: PipeEnd,
    pub sign_into: i32,
}

impl CharJunctionLeg {
    pub fn new(pipe_idx: usize, end: PipeEnd) -> Self {
        let sign_into = match end {
            PipeEnd::Right => 1,
            PipeEnd::Left => -1,
        };
        Self { pipe_idx, end, sign_into }
    }

    #[inline]
    pub fn s_end(&self) -> f64 {
        match self.end { PipeEnd::Right => 1.0, PipeEnd::Left => -1.0 }
    }

    #[inline]
    pub fn face_cell_index(&self, pipe: &PipeState) -> usize {
        match self.end {
            PipeEnd::Left  => pipe.n_ghost,
            PipeEnd::Right => pipe.n_ghost + pipe.n_cells - 1,
        }
    }
}

#[inline]
fn minmod(a: f64, b: f64) -> f64 {
    if a * b <= 0.0 {
        return 0.0;
    }
    if a.abs() < b.abs() { a } else { b }
}

#[derive(Debug, Clone, Copy)]
struct Interior {
    rho_i: f64, u_i: f64, p_i: f64, y_i: f64,
    c_i: f64, a_i: f64, gamma: f64,
    rho_in: f64, u_in: f64, p_in: f64, rho_y_in: f64,
    dx: f64,
}

fn primitives_at(pipe: &PipeState, cell_i: usize) -> (f64, f64, f64, f64) {
    let gm1 = pipe.gamma - 1.0;
    let a = pipe.area[cell_i];
    let rho = pipe.q[cell_i * N_VARS + I_RHO_A] / a;
    let u = pipe.q[cell_i * N_VARS + I_MOM_A] / (rho * a);
    let big_e = pipe.q[cell_i * N_VARS + I_E_A] / a;
    let p = (gm1 * (big_e - 0.5 * rho * u * u)).max(1.0);
    let rho_y = pipe.q[cell_i * N_VARS + I_Y_A] / a;
    (rho, u, p, rho_y)
}

fn interior_primitives(leg: &CharJunctionLeg, pipes: &[PipeState]) -> Interior {
    let pipe = &pipes[leg.pipe_idx];
    let gamma = pipe.gamma;
    let i = leg.face_cell_index(pipe);
    let a = pipe.area[i];
    let (rho_i, u_i, p_i, rho_y_i) = primitives_at(pipe, i);
    let y_i = rho_y_i / rho_i.max(1e-20);
    let c_i = (gamma * p_i / rho_i.max(1e-9)).sqrt();
    let i_in = match leg.end { PipeEnd::Right => i - 1, PipeEnd::Left => i + 1 };
    let (rho_in, u_in, p_in, rho_y_in) = primitives_at(pipe, i_in);
    Interior {
        rho_i, u_i, p_i, y_i, c_i, a_i: a, gamma,
        rho_in, u_in, p_in, rho_y_in,
        dx: pipe.dx,
    }
}

/// Mirror MUSCL-Hancock's face reconstruction on the interior side.
#[allow(clippy::too_many_arguments)]
fn muscl_face_reconstruction(
    rho_i: f64, u_i: f64, p_i: f64, rho_y_i: f64,
    rho_in: f64, u_in: f64, p_in: f64, rho_y_in: f64,
    rho_g: f64, u_g: f64, p_g: f64, rho_y_g: f64,
    gamma: f64, dx: f64, dt: f64,
    end: PipeEnd,
) -> (f64, f64, f64, f64) {
    let (a_rho, a_u, a_p, a_rho_y, b_rho, b_u, b_p, b_rho_y, sign_half) = match end {
        PipeEnd::Right => (
            rho_i - rho_in,
            u_i - u_in,
            p_i - p_in,
            rho_y_i - rho_y_in,
            rho_g - rho_i,
            u_g - u_i,
            p_g - p_i,
            rho_y_g - rho_y_i,
            0.5_f64,
        ),
        PipeEnd::Left => (
            rho_i - rho_g,
            u_i - u_g,
            p_i - p_g,
            rho_y_i - rho_y_g,
            rho_in - rho_i,
            u_in - u_i,
            p_in - p_i,
            rho_y_in - rho_y_i,
            -0.5_f64,
        ),
    };
    let srho = minmod(a_rho, b_rho);
    let su = minmod(a_u, b_u);
    let sp = minmod(a_p, b_p);
    let srho_y = minmod(a_rho_y, b_rho_y);
    let half_dt_dx = 0.5 * dt / dx;
    let drho   = -half_dt_dx * (u_i * srho + rho_i * su);
    let du     = -half_dt_dx * (u_i * su + sp / rho_i);
    let dp     = -half_dt_dx * (u_i * sp + gamma * p_i * su);
    let drho_y = -half_dt_dx * (u_i * srho_y + rho_y_i * su);
    let mut rho_f = rho_i + drho + sign_half * srho;
    let mut u_f = u_i + du + sign_half * su;
    let mut p_f = p_i + dp + sign_half * sp;
    let mut rho_y_f = rho_y_i + drho_y + sign_half * srho_y;
    if rho_f <= 0.0 || p_f <= 0.0 {
        rho_f = rho_i;
        u_f = u_i;
        p_f = p_i;
        rho_y_f = rho_y_i;
    }
    let y_f = rho_y_f / rho_f.max(1e-20);
    (rho_f, u_f, p_f, y_f)
}

/// Isentropic expansion from a reference interior state to p_j.
fn face_from_pj(
    rho_ref: f64, u_ref: f64, p_ref: f64, c_ref: f64,
    p_j: f64, gamma: f64, s_end: f64,
) -> (f64, f64, f64) {
    let gm1 = gamma - 1.0;
    let r = (p_j / p_ref).max(1e-9);
    let c_f = c_ref * r.powf(gm1 / (2.0 * gamma));
    let rho_f = rho_ref * r.powf(1.0 / gamma);
    let u_f = u_ref + (2.0 / gm1) * (c_ref - c_f) * s_end;
    (rho_f, u_f, c_f)
}

#[derive(Debug, Clone, Copy)]
struct LegRef { rho: f64, u: f64, p: f64, c: f64 }

#[derive(Debug, Clone, Copy)]
struct FaceState { rho_f: f64, u_f: f64, p_f: f64, f_mass: f64 }

/// Borda-Carnot sudden-expansion loss K_leg from junction geometry.
///
/// For an inflow leg (mass entering the pipe from the junction), the flow
/// expands from an effective upstream area `A_max` (the largest pipe in the
/// junction — the plenum, for an intake T-junction) into the leg area
/// `A_leg`. The classical Borda-Carnot dump loss is
///     K_leg = (1 − A_leg / A_max)^2
/// with K = 0 when the leg equals the max (no expansion), approaching
/// (1 − ε)² as A_leg → 0.
///
/// This makes the loss coefficient *geometry-derived* rather than tuned,
/// so any new engine config (e.g. SDM27) inherits the right K without a
/// per-engine fit. The scalar `multiplier` is the user-facing knob, which
/// scales the geometric K (default 1.0 = pure Borda-Carnot, 0.0 = lossless).
#[inline]
fn borda_carnot_k(a_leg: f64, a_max: f64) -> f64 {
    if a_max <= 0.0 || a_leg >= a_max {
        return 0.0;
    }
    let ratio = a_leg / a_max;
    (1.0 - ratio).powi(2)
}

/// Loss-mode encoding for `hllc_mass_residual`.
///
/// - `Off`: no loss; the residual sees lossless face states (legacy).
/// - `Scalar(K)`: every inflow leg gets the same K (legacy scalar knob,
///   used by existing tests and configs that set `intake_junction_loss_coef`).
/// - `BordaCarnot { multiplier }`: per-leg K derived from area-ratio
///   geometry, scaled by `multiplier` (the user-facing dial). The
///   *physical* setting is multiplier = 1.0; smaller values are diagnostic
///   under-dissipation; larger values cap above 1.0 are warned in the
///   junction config layer.
#[derive(Debug, Clone, Copy)]
pub enum LossMode {
    Off,
    Scalar(f64),
    BordaCarnot { multiplier: f64 },
}

impl LossMode {
    /// Resolve the active K for a given leg.
    #[inline]
    fn k_for(self, a_leg: f64, a_max: f64) -> f64 {
        match self {
            LossMode::Off => 0.0,
            LossMode::Scalar(k) => k,
            LossMode::BordaCarnot { multiplier } => multiplier * borda_carnot_k(a_leg, a_max),
        }
    }

    /// True if any non-zero loss is requested. Used to skip the
    /// loss-application branch entirely when the answer must be the
    /// lossless baseline (preserves parity-golden bit-equality).
    #[inline]
    fn is_active(self) -> bool {
        match self {
            LossMode::Off => false,
            LossMode::Scalar(k) => k > 0.0,
            LossMode::BordaCarnot { multiplier } => multiplier > 0.0,
        }
    }
}

fn hllc_mass_residual(
    legs: &[CharJunctionLeg], interiors: &[Interior], p_j: f64,
    references: &[LegRef], dt: f64, loss: LossMode, a_max: f64,
) -> (f64, Vec<FaceState>) {
    let mut r = 0.0_f64;
    let mut face_states = Vec::with_capacity(legs.len());
    let loss_active = loss.is_active();
    for ((leg, it), reff) in legs.iter().zip(interiors.iter()).zip(references.iter()) {
        let gamma_leg = it.gamma;
        let (mut rho_g, u_g, c_g) = face_from_pj(
            reff.rho, reff.u, reff.p, reff.c, p_j, gamma_leg, leg.s_end(),
        );
        let mut p_g = rho_g * c_g * c_g / gamma_leg;
        let y_g = it.y_i;

        // In-residual Borda-Carnot dump loss (0005 fix).
        //
        // The legacy code applied this loss in `write_ghosts` AFTER the
        // Newton residual converged — which breaks the residual's mass
        // closure because the next MUSCL step sees lossy ghosts while
        // the Newton "thinks" it emitted lossless flux. Finding 0004 §6
        // measured that mismatch at >100× the C9 char band.
        //
        // Applying the loss BEFORE HLLC inside the residual makes the
        // Newton's converged p_j account for the dump-loss directly:
        // the residual goes to ~machine-eps even at large K, restoring
        // C9 mass conservation while still capturing the physical
        // dissipation.
        //
        // Direction test: `(leg.sign_into) * u_g < 0` means the junction
        // is sending mass into the pipe (pipe inflow), matching the
        // legacy write_ghosts condition `signed_into_hllc < 0`. We use
        // the ghost u_g (face_from_pj output) as a proxy since `f_mass`
        // is not yet known at this point.
        if loss_active && (leg.sign_into as f64) * u_g < 0.0 {
            let k_leg = loss.k_for(it.a_i, a_max);
            if k_leg > 0.0 {
                let dp_loss = k_leg * 0.5 * rho_g * u_g * u_g;
                let p_g_new = (p_g - dp_loss).max(0.5 * p_g);
                let rho_g_new = rho_g * (p_g_new / p_g.max(1.0)).powf(1.0 / gamma_leg);
                p_g = p_g_new;
                rho_g = rho_g_new;
            }
        }
        let rho_y_g = rho_g * y_g;

        let rho_y_i = it.rho_i * it.y_i;
        let (rho_f_i, u_f_i, p_f_i, y_f_i) = muscl_face_reconstruction(
            it.rho_i, it.u_i, it.p_i, rho_y_i,
            it.rho_in, it.u_in, it.p_in, it.rho_y_in,
            rho_g, u_g, p_g, rho_y_g,
            gamma_leg, it.dx, dt, leg.end,
        );
        let (rho_f_g, u_f_g, p_f_g, y_f_g) = (rho_g, u_g, p_g, y_g);

        let f = match leg.end {
            PipeEnd::Right => hllc_flux(
                rho_f_i, u_f_i, p_f_i, y_f_i,
                rho_f_g, u_f_g, p_f_g, y_f_g,
                gamma_leg,
            ),
            PipeEnd::Left => hllc_flux(
                rho_f_g, u_f_g, p_f_g, y_f_g,
                rho_f_i, u_f_i, p_f_i, y_f_i,
                gamma_leg,
            ),
        };
        let f_mass = f.0;
        r += (leg.sign_into as f64) * f_mass * it.a_i;
        face_states.push(FaceState { rho_f: rho_g, u_f: u_g, p_f: p_g, f_mass });
    }
    (r, face_states)
}

#[derive(Debug, Clone)]
pub struct CharacteristicJunction {
    pub legs: Vec<CharJunctionLeg>,
    pub gamma: f64,
    pub r_gas: f64,
    pub newton_tol: f64,
    pub newton_max_iter: usize,
    pub choke_margin: f64,
    pub inflow_entropy_picard: bool,
    pub inflow_loss_coef: f64,
    /// Loss-application mode. `Scalar` keeps legacy single-coefficient
    /// behavior; `BordaCarnot { multiplier }` derives the per-leg K from
    /// area-ratio geometry so a new engine config inherits the right K
    /// without per-engine tuning. Default `Scalar(0.0)` = parity preserved.
    pub loss_mode: LossMode,
    pub last_p_junction: f64,
    pub last_mass_residual: f64,
    pub last_energy_residual: f64,
    pub last_niter: usize,
    pub last_regime: String,
    pub last_y_mixed: f64,
}

impl CharacteristicJunction {
    pub fn new(legs: Vec<CharJunctionLeg>, gamma: f64, r_gas: f64) -> Self {
        Self {
            legs, gamma, r_gas,
            newton_tol: 1e-13,
            newton_max_iter: 30,
            choke_margin: 0.02,
            inflow_entropy_picard: true,
            inflow_loss_coef: 0.0,
            loss_mode: LossMode::Scalar(0.0),
            last_p_junction: 101325.0,
            last_mass_residual: 0.0,
            last_energy_residual: 0.0,
            last_niter: 0,
            last_regime: String::from("subsonic"),
            last_y_mixed: 0.0,
        }
    }

    /// Resolve the effective loss mode for this junction.
    ///
    /// If `loss_mode` is the default `Scalar(0.0)` but the legacy
    /// `inflow_loss_coef` field has been set to a positive value (the way
    /// existing configs and tests poke the knob), promote it to
    /// `Scalar(inflow_loss_coef)`. Otherwise use `loss_mode` as authoritative.
    /// New callers should set `loss_mode = BordaCarnot { multiplier: 1.0 }`
    /// directly for geometry-derived per-leg K with no per-engine tuning.
    #[inline]
    fn effective_loss(&self) -> LossMode {
        match self.loss_mode {
            LossMode::Scalar(0.0) if self.inflow_loss_coef > 0.0 => {
                LossMode::Scalar(self.inflow_loss_coef)
            }
            other => other,
        }
    }

    /// Largest leg cross-section area at this junction; the reference
    /// "upstream" area for Borda-Carnot per-leg K computations.
    #[inline]
    fn max_leg_area(interiors: &[Interior]) -> f64 {
        interiors.iter().map(|it| it.a_i).fold(0.0_f64, f64::max)
    }

    /// Secant iteration on the HLLC-consistent mass residual.
    /// Returns (p_j, niter, face_states, converged).
    fn secant_mass_balance(
        &mut self, interiors: &[Interior], references: &[LegRef],
        p_j_init: f64, dt: f64, loss: LossMode, a_max: f64,
    ) -> (f64, usize, Vec<FaceState>, bool) {
        let p_floor = 1000.0_f64;
        let dp_fd = 1.0_f64;

        let (r0, fs0) = hllc_mass_residual(&self.legs, interiors, p_j_init, references, dt, loss, a_max);
        self.last_mass_residual = r0;
        if r0.abs() < self.newton_tol {
            return (p_j_init, 1, fs0, true);
        }
        let mut p_prev = p_j_init;
        let mut r_prev = r0;
        let mut p_curr = p_j_init + dp_fd;
        let (mut r_curr, mut fs_curr) = hllc_mass_residual(
            &self.legs, interiors, p_curr, references, dt, loss, a_max,
        );
        for it in 0..self.newton_max_iter {
            self.last_mass_residual = r_curr;
            if r_curr.abs() < self.newton_tol {
                return (p_curr, it + 2, fs_curr, true);
            }
            let denom = r_curr - r_prev;
            if denom.abs() < 1e-30 {
                return (p_curr, it + 2, fs_curr, false);
            }
            let slope = denom / (p_curr - p_prev);
            let mut dp = -r_curr / slope;
            let cap = 0.2 * p_curr;
            if dp > cap { dp = cap; }
            else if dp < -cap { dp = -cap; }
            let p_next = (p_curr + dp).max(p_floor);
            let (r_next, fs_next) = hllc_mass_residual(
                &self.legs, interiors, p_next, references, dt, loss, a_max,
            );
            p_prev = p_curr;
            r_prev = r_curr;
            p_curr = p_next;
            r_curr = r_next;
            fs_curr = fs_next;
        }
        self.last_mass_residual = r_curr;
        (p_curr, self.newton_max_iter + 1, fs_curr, false)
    }

    fn detect_choked_legs(
        &self, face_states_ruc: &[(f64, f64, f64)],
    ) -> Vec<usize> {
        let mut choked = Vec::new();
        for (i, leg) in self.legs.iter().enumerate() {
            let (_rho_f, u_f, c_f) = face_states_ruc[i];
            let m_into = (leg.sign_into as f64) * u_f / c_f.max(1.0);
            if m_into > 1.0 - self.choke_margin {
                choked.push(i);
            }
        }
        choked
    }

    fn solve_with_choked(
        &mut self, interiors: &[Interior], references: &[LegRef],
        choked_indices: &[usize], dt: f64, loss: LossMode, a_max: f64,
    ) -> Result<(f64, usize, Vec<FaceState>), JunctionConvergenceError> {
        let total = self.legs.len();
        if choked_indices.len() == total {
            return Err(JunctionConvergenceError {
                message: format!(
                    "All {total} legs simultaneously choked at the junction face — \
                     no subsonic leg remains to balance mass."
                ),
            });
        }
        let choked_set: std::collections::HashSet<usize> =
            choked_indices.iter().copied().collect();

        // Sonic throat mass flux per choked leg.
        let mut fixed_mdot_sum = 0.0_f64;
        for &idx in choked_indices {
            let it = &interiors[idx];
            let gp1 = it.gamma + 1.0;
            let gm1 = it.gamma - 1.0;
            let choke_exp = -0.5 * gp1 / gm1;
            let m_i = it.u_i / it.c_i.max(1.0);
            let t0_factor = 1.0 + 0.5 * gm1 * m_i * m_i;
            let rho0 = it.rho_i * t0_factor.powf(1.0 / gm1);
            let c0 = it.c_i * t0_factor.sqrt();
            let mdot_star = rho0 * c0 * it.a_i * (gp1 / 2.0).powf(choke_exp);
            let sigma = self.legs[idx].sign_into as f64;
            fixed_mdot_sum += sigma * mdot_star;
        }

        // Initial guess: area-weighted mean over non-choked legs.
        let mut sum_pa = 0.0_f64;
        let mut sum_a = 0.0_f64;
        for (i, it) in interiors.iter().enumerate() {
            if choked_set.contains(&i) { continue; }
            sum_pa += it.p_i * it.a_i;
            sum_a += it.a_i;
        }
        let p_j_init = sum_pa / sum_a.max(1e-9);

        let p_floor = 1000.0_f64;
        let dp_fd = 1.0_f64;

        // residual closure
        let residual = |p_j: f64,
                        s_legs: &[CharJunctionLeg],
                        s_interiors: &[Interior],
                        s_refs: &[LegRef]|
            -> (f64, Vec<FaceState>)
        {
            let (r, fs) = hllc_mass_residual(s_legs, s_interiors, p_j, s_refs, dt, loss, a_max);
            (fixed_mdot_sum + r, fs)
        };

        // Slices of non-choked legs/interiors/refs
        let sub_indices: Vec<usize> = (0..total).filter(|i| !choked_set.contains(i)).collect();
        let sub_legs: Vec<CharJunctionLeg> = sub_indices.iter().map(|&i| self.legs[i]).collect();
        let sub_interiors: Vec<Interior> = sub_indices.iter().map(|&i| interiors[i]).collect();
        let sub_refs: Vec<LegRef> = sub_indices.iter().map(|&i| references[i]).collect();

        let assemble_full = |fs_sub: Vec<FaceState>| -> Vec<FaceState> {
            let mut full: Vec<FaceState> = vec![FaceState {
                rho_f: 0.0, u_f: 0.0, p_f: 0.0, f_mass: 0.0,
            }; total];
            for (k, &full_idx) in sub_indices.iter().enumerate() {
                full[full_idx] = fs_sub[k];
            }
            // Fill choked legs with sonic-throat face states.
            for &idx in choked_indices {
                let it = &interiors[idx];
                let gm1 = it.gamma - 1.0;
                let m_i = it.u_i / it.c_i.max(1.0);
                let t0_factor = 1.0 + 0.5 * gm1 * m_i * m_i;
                let rho0 = it.rho_i * t0_factor.powf(1.0 / gm1);
                let c0 = it.c_i * t0_factor.sqrt();
                let t_star_over_t0 = 2.0 / (it.gamma + 1.0);
                let rho_star = rho0 * t_star_over_t0.powf(1.0 / gm1);
                let c_star = c0 * t_star_over_t0.sqrt();
                let sigma = self.legs[idx].sign_into as f64;
                let u_star = sigma * c_star;
                let p_star = rho_star * c_star * c_star / it.gamma;
                let f_mass_star = sigma * rho_star * c_star.abs() * it.a_i;
                full[idx] = FaceState {
                    rho_f: rho_star, u_f: u_star, p_f: p_star, f_mass: f_mass_star,
                };
            }
            full
        };

        let (mut r_prev, fs_prev) = residual(p_j_init, &sub_legs, &sub_interiors, &sub_refs);
        if r_prev.abs() < self.newton_tol {
            self.last_mass_residual = r_prev;
            return Ok((p_j_init, 1, assemble_full(fs_prev)));
        }
        let mut p_prev = p_j_init;
        let mut p_curr = p_j_init + dp_fd;
        let (mut r_curr, mut fs_curr) =
            residual(p_curr, &sub_legs, &sub_interiors, &sub_refs);
        for it_idx in 0..self.newton_max_iter {
            if r_curr.abs() < self.newton_tol {
                self.last_mass_residual = r_curr;
                return Ok((p_curr, it_idx + 2, assemble_full(fs_curr)));
            }
            let denom = r_curr - r_prev;
            if denom.abs() < 1e-30 {
                break;
            }
            let slope = denom / (p_curr - p_prev);
            let mut dp = -r_curr / slope;
            let cap = 0.2 * p_curr;
            if dp > cap { dp = cap; }
            else if dp < -cap { dp = -cap; }
            let p_next = (p_curr + dp).max(p_floor);
            let (r_next, fs_next) =
                residual(p_next, &sub_legs, &sub_interiors, &sub_refs);
            p_prev = p_curr;
            r_prev = r_curr;
            p_curr = p_next;
            r_curr = r_next;
            fs_curr = fs_next;
        }
        Err(JunctionConvergenceError {
            message: format!(
                "CharacteristicJunction choked branch did not converge \
                 ({} choked, {} subsonic). last p_j={p_curr:.1} Pa, |R|={:.3e}",
                choked_indices.len(), total - choked_indices.len(), r_curr.abs(),
            ),
        })
    }

    fn inflow_entropy_pass(
        &mut self,
        interiors: &[Interior], face_states: &[FaceState],
        references: &[LegRef], p_j_current: f64, dt: f64,
        loss: LossMode, a_max: f64,
    ) -> Option<(f64, Vec<FaceState>, Vec<LegRef>)> {
        let mut inflow_legs = Vec::new();
        let mut outflow_legs = Vec::new();
        for (i, (leg, fs)) in self.legs.iter().zip(face_states.iter()).enumerate() {
            if (leg.sign_into as f64) * fs.f_mass < 0.0 {
                inflow_legs.push(i);
            } else {
                outflow_legs.push(i);
            }
        }
        if inflow_legs.is_empty() || outflow_legs.is_empty() {
            return None;
        }
        // Reservoir state: mass-weighted ρ, p across outflow legs.
        let mut mdot_out_total = 0.0_f64;
        let mut rho_mix = 0.0_f64;
        let mut p_mix = 0.0_f64;
        for &i in &outflow_legs {
            let leg = &self.legs[i];
            let fs = face_states[i];
            let a_i = interiors[i].a_i;
            let mdot = (leg.sign_into as f64) * fs.f_mass * a_i;
            mdot_out_total += mdot;
            rho_mix += mdot * fs.rho_f;
            p_mix += mdot * interiors[i].p_i;
        }
        if mdot_out_total <= 0.0 {
            return None;
        }
        rho_mix /= mdot_out_total;
        p_mix /= mdot_out_total;

        let mut new_refs = references.to_vec();
        for &i in &inflow_legs {
            let u_i = interiors[i].u_i;
            let gamma_leg = interiors[i].gamma;
            let c_mix = (gamma_leg * p_mix / rho_mix.max(1e-9)).sqrt();
            new_refs[i] = LegRef { rho: rho_mix, u: u_i, p: p_mix, c: c_mix };
        }
        let (p_j, _niter, fs_new, converged) =
            self.secant_mass_balance(interiors, &new_refs, p_j_current, dt, loss, a_max);
        if converged {
            Some((p_j, fs_new, new_refs))
        } else {
            None
        }
    }

    fn compute_mixed_y(&self, interiors: &[Interior], face_states: &[FaceState]) -> f64 {
        let mut mdot_in_total = 0.0_f64;
        let mut y_sum_in = 0.0_f64;
        for ((leg, fs), it) in self.legs.iter().zip(face_states.iter()).zip(interiors.iter()) {
            let signed_into = (leg.sign_into as f64) * fs.f_mass * it.a_i;
            if signed_into > 0.0 {
                mdot_in_total += signed_into;
                y_sum_in += signed_into * it.y_i;
            }
        }
        if mdot_in_total > 1e-30 { y_sum_in / mdot_in_total } else { 0.0 }
    }

    fn energy_residual(&self, interiors: &[Interior], face_states: &[FaceState]) -> f64 {
        let mut e_flux = 0.0_f64;
        for ((leg, fs), it) in self.legs.iter().zip(face_states.iter()).zip(interiors.iter()) {
            let gm1 = it.gamma - 1.0;
            let c_f_sq = it.gamma * fs.p_f / fs.rho_f.max(1e-9);
            let h = c_f_sq / gm1;
            let h0 = h + 0.5 * fs.u_f * fs.u_f;
            e_flux += (leg.sign_into as f64) * fs.rho_f * fs.u_f * it.a_i * h0;
        }
        e_flux
    }

    fn write_ghosts(
        &self,
        pipes: &mut [PipeState],
        interiors: &[Interior], face_states: &[FaceState],
        y_mixed: f64, _p_j: f64,
    ) {
        for ((leg, it), fs) in self.legs.iter().zip(interiors.iter()).zip(face_states.iter()) {
            let gamma_leg = it.gamma;
            let gm1 = gamma_leg - 1.0;
            let rho_f = fs.rho_f;
            let u_f = fs.u_f;
            let p_f = fs.p_f;
            let signed_into_hllc = (leg.sign_into as f64) * fs.f_mass;
            let y_ghost = if signed_into_hllc >= 0.0 { it.y_i } else { y_mixed };

            // NOTE (0005): the Borda-Carnot dump loss is now applied INSIDE
            // `hllc_mass_residual` before HLLC is called, so `fs.rho_f` and
            // `fs.p_f` here already carry the lossy state. The legacy
            // post-correction block that lived here was double-counting the
            // loss AND breaking mass conservation (finding 0004 §6). Do not
            // re-apply it.
            let e_ghost = p_f / gm1 + 0.5 * rho_f * u_f * u_f;
            let pipe = &mut pipes[leg.pipe_idx];
            let ng = pipe.n_ghost;
            let nc = pipe.n_cells;
            let n_total = pipe.n_total();
            let indices: Box<dyn Iterator<Item = usize>> = match leg.end {
                PipeEnd::Left => Box::new(0..ng),
                PipeEnd::Right => Box::new((ng + nc)..n_total),
            };
            for i in indices {
                let a_g = pipe.area[i];
                pipe.q[i * N_VARS + I_RHO_A] = rho_f * a_g;
                pipe.q[i * N_VARS + I_MOM_A] = rho_f * u_f * a_g;
                pipe.q[i * N_VARS + I_E_A]   = e_ghost * a_g;
                pipe.q[i * N_VARS + I_Y_A]   = rho_f * y_ghost * a_g;
            }
        }
    }

    pub fn fill_ghosts(
        &mut self, pipes: &mut [PipeState], dt: f64,
    ) -> Result<(), JunctionConvergenceError> {
        if self.legs.len() < 2 {
            return Ok(());
        }
        let interiors: Vec<Interior> = self.legs.iter()
            .map(|leg| interior_primitives(leg, pipes))
            .collect();
        let mut sum_pa = 0.0_f64;
        let mut sum_a = 0.0_f64;
        for it in &interiors {
            sum_pa += it.p_i * it.a_i;
            sum_a += it.a_i;
        }
        let p_j_init = sum_pa / sum_a;
        let mut references: Vec<LegRef> = interiors.iter().map(|it| LegRef {
            rho: it.rho_i, u: it.u_i, p: it.p_i, c: it.c_i,
        }).collect();

        // Resolve loss config once per fill_ghosts; the Newton residual and
        // every Picard pass downstream see the same setting, so the converged
        // face state is mass-conservation-consistent (0005 fix).
        let loss = self.effective_loss();
        let a_max = Self::max_leg_area(&interiors);

        let (mut p_j, mut niter, mut face_states, converged) =
            self.secant_mass_balance(&interiors, &references, p_j_init, dt, loss, a_max);
        if !converged {
            return Err(JunctionConvergenceError {
                message: format!(
                    "CharacteristicJunction did not converge in {} secant steps. \
                     last p_j={p_j:.1} Pa, last |R|={:.3e} kg/s",
                    self.newton_max_iter, self.last_mass_residual.abs(),
                ),
            });
        }

        let face_states_ruc: Vec<(f64, f64, f64)> = face_states.iter()
            .zip(interiors.iter())
            .map(|(fs, it)| {
                let c_f = (it.gamma * fs.p_f / fs.rho_f.max(1e-9)).sqrt();
                (fs.rho_f, fs.u_f, c_f)
            }).collect();
        let choked_legs = self.detect_choked_legs(&face_states_ruc);

        if !choked_legs.is_empty() {
            let (p_j_c, niter_c, fs_c) = self.solve_with_choked(
                &interiors, &references, &choked_legs, dt, loss, a_max,
            )?;
            p_j = p_j_c;
            niter += niter_c;
            face_states = fs_c;
            self.last_regime = format!("choked_{}", choked_legs.len());
        } else {
            self.last_regime = String::from("subsonic");
        }

        if self.inflow_entropy_picard && choked_legs.is_empty() {
            if let Some((p_j_corr, fs_corr, refs_corr)) =
                self.inflow_entropy_pass(&interiors, &face_states, &references, p_j, dt, loss, a_max)
            {
                p_j = p_j_corr;
                face_states = fs_corr;
                references = refs_corr;
            }
        }
        // suppress unused-variable warning if references isn't read later
        let _ = references;

        let y_mixed = self.compute_mixed_y(&interiors, &face_states);
        self.last_y_mixed = y_mixed;
        self.last_energy_residual = self.energy_residual(&interiors, &face_states);

        self.write_ghosts(pipes, &interiors, &face_states, y_mixed, p_j);
        self.last_p_junction = p_j;
        self.last_niter = niter;
        Ok(())
    }

    /// No-op: the characteristic junction has no CV state.
    pub fn absorb_fluxes(&mut self, _pipes: &[PipeState], _flux: &[&[f64]], _dt: f64) {}
}
