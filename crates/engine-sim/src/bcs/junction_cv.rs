//! 0D junction control volume — strict mass/energy/species conservation.
//! Direct port of `bcs/junction_cv.py`.

use crate::solver::state::{
    PipeState, N_VARS, I_RHO_A, I_MOM_A, I_E_A, I_Y_A,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeEnd { Left, Right }

#[derive(Debug, Clone, Copy)]
pub struct JunctionCVLeg {
    pub pipe_idx: usize,
    pub end: PipeEnd,
}

impl JunctionCVLeg {
    pub fn new(pipe_idx: usize, end: PipeEnd) -> Self {
        Self { pipe_idx, end }
    }
}

#[derive(Debug, Clone)]
pub struct JunctionCV {
    pub volume: f64,
    pub m: f64,
    pub e: f64,
    pub m_y: f64,
    pub gamma: f64,
    pub r_gas: f64,
    pub legs: Vec<JunctionCVLeg>,
    pub last_p: f64,
    pub last_t: f64,
    /// Dynamic-pressure loss coefficient applied when flow enters the CV
    /// from a pipe leg. Matches the convention used by
    /// `CharacteristicJunction::inflow_loss_coef`. Defaults to 0 — when 0
    /// the junction is pure stagnation and Python-reference parity is
    /// preserved bit-for-bit.
    pub inflow_loss_coef: f64,
}

impl JunctionCV {
    pub fn from_legs(
        legs: Vec<JunctionCVLeg>, pipes: &[PipeState],
        p_init: f64, t_init: f64, y_init: f64,
        gamma: f64, r_gas: f64, volume_factor: f64,
    ) -> Self {
        let mut v_j = 0.0_f64;
        for leg in &legs {
            let pipe = &pipes[leg.pipe_idx];
            let face_idx = match leg.end {
                PipeEnd::Left => pipe.n_ghost,
                PipeEnd::Right => pipe.n_ghost + pipe.n_cells,
            };
            let a_end = pipe.area[face_idx];
            let candidate = a_end * pipe.dx;
            if candidate > v_j {
                v_j = candidate;
            }
        }
        v_j *= volume_factor;
        let rho = p_init / (r_gas * t_init);
        let m = rho * v_j;
        let e = (p_init / (gamma - 1.0)) * v_j;
        let m_y = rho * y_init * v_j;
        Self {
            volume: v_j, m, e, m_y,
            gamma, r_gas, legs,
            last_p: p_init, last_t: t_init,
            inflow_loss_coef: 0.0,
        }
    }

    #[inline]
    pub fn rho(&self) -> f64 { self.m / self.volume }

    #[inline]
    pub fn p(&self) -> f64 {
        (self.gamma - 1.0) * (self.e / self.volume)
    }

    #[inline]
    pub fn t(&self) -> f64 {
        self.p() / (self.r_gas * self.rho())
    }

    #[inline]
    pub fn y(&self) -> f64 {
        if self.m > 1e-20 { self.m_y / self.m } else { 0.0 }
    }

    /// Fill each leg's pipe-end ghost cells with the CV's stagnation state.
    /// `_dt` is accepted for interface symmetry with CharacteristicJunction.
    ///
    /// When `inflow_loss_coef > 0` and flow is INTO the CV from a pipe leg,
    /// the ghost-cell pressure is reduced by `K · ½ρu²` (mirrors the
    /// CharacteristicJunction inflow-loss model). When loss_coef = 0 the
    /// behavior is unchanged from the pure-stagnation original — preserves
    /// Python-reference parity at default config.
    pub fn fill_ghosts(&mut self, pipes: &mut [PipeState], _dt: f64) {
        let rho_cv = self.rho();
        let p_cv = self.p();
        let y = self.y();
        let gm1 = self.gamma - 1.0;
        let e_density_stagnation = p_cv / gm1;

        self.last_p = p_cv;
        self.last_t = self.t();

        for leg in &self.legs {
            let pipe = &mut pipes[leg.pipe_idx];
            let ng = pipe.n_ghost;
            let nc = pipe.n_cells;
            let n_total = pipe.n_total();

            // Decide whether the pipe is drawing FROM the CV (i.e. flow
            // OUT of CV into pipe = pipe inflow). This is the case where
            // an entrance loss applies — gas accelerating from a stagnant
            // reservoir into a pipe at the pipe-end face. Matches the
            // CharacteristicJunction `signed_into_hllc < 0.0` branch.
            //   - Left end of pipe: pipe inflow means u_interior > 0
            //     (flow accelerates away from CV down the pipe).
            //   - Right end of pipe: pipe inflow means u_interior < 0.
            let (rho_g, e_g) = if self.inflow_loss_coef > 0.0 {
                let int_idx = match leg.end {
                    PipeEnd::Left => ng,
                    PipeEnd::Right => ng + nc - 1,
                };
                let rho_a_i = pipe.q[int_idx * N_VARS + I_RHO_A];
                let mom_a_i = pipe.q[int_idx * N_VARS + I_MOM_A];
                let a_i = pipe.area[int_idx].max(1e-20);
                let rho_i = (rho_a_i / a_i).max(1e-12);
                let u_i = mom_a_i / (rho_i * a_i);
                let pipe_inflow = match leg.end {
                    PipeEnd::Left => u_i > 0.0,
                    PipeEnd::Right => u_i < 0.0,
                };
                if pipe_inflow {
                    let dp_loss = self.inflow_loss_coef * 0.5 * rho_i * u_i * u_i;
                    let p_new = (p_cv - dp_loss).max(0.5 * p_cv);
                    // Isentropic density update consistent with characteristic-junction model
                    let rho_new = rho_cv * (p_new / p_cv.max(1.0)).powf(1.0 / self.gamma);
                    (rho_new, p_new / gm1)
                } else {
                    (rho_cv, e_density_stagnation)
                }
            } else {
                (rho_cv, e_density_stagnation)
            };

            let indices: Box<dyn Iterator<Item = usize>> = match leg.end {
                PipeEnd::Left => Box::new(0..ng),
                PipeEnd::Right => Box::new((ng + nc)..n_total),
            };
            for i in indices {
                let a = pipe.area[i];
                pipe.q[i * N_VARS + I_RHO_A] = rho_g * a;
                pipe.q[i * N_VARS + I_MOM_A] = 0.0;
                pipe.q[i * N_VARS + I_E_A]   = e_g * a;
                pipe.q[i * N_VARS + I_Y_A]   = rho_g * y * a;
            }
        }
    }

    /// Sum each leg's signed face flux into the CV state. `flux_arrays`
    /// must align with `pipes`: flux_arrays[i] is the per-face flux of
    /// the MUSCL step for pipe i (length = (n_total+1) * N_VARS).
    pub fn absorb_fluxes(&mut self, pipes: &[PipeState], flux_arrays: &[&[f64]], dt: f64) {
        for leg in &self.legs {
            let pipe = &pipes[leg.pipe_idx];
            let (sign, j) = match leg.end {
                PipeEnd::Right => (1.0_f64, pipe.n_ghost + pipe.n_cells),
                PipeEnd::Left  => (-1.0_f64, pipe.n_ghost),
            };
            let f = &flux_arrays[leg.pipe_idx];
            let f_mass   = f[j * N_VARS];
            let f_energy = f[j * N_VARS + 2];
            let f_comp   = f[j * N_VARS + 3];
            self.m   += dt * sign * f_mass;
            self.e   += dt * sign * f_energy;
            self.m_y += dt * sign * f_comp;
        }
        if self.m < 1e-20 { self.m = 1e-20; }
        if self.m_y < 0.0 { self.m_y = 0.0; }
        if self.m_y > self.m { self.m_y = self.m; }
        if self.e < 1e-20 { self.e = 1e-20; }
    }
}
