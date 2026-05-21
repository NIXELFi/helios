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
    pub fn fill_ghosts(&mut self, pipes: &mut [PipeState], _dt: f64) {
        let rho = self.rho();
        let p = self.p();
        let y = self.y();
        let gm1 = self.gamma - 1.0;
        let e_density = p / gm1;

        self.last_p = p;
        self.last_t = self.t();

        for leg in &self.legs {
            let pipe = &mut pipes[leg.pipe_idx];
            let ng = pipe.n_ghost;
            let nc = pipe.n_cells;
            let n_total = pipe.n_total();
            let indices: Box<dyn Iterator<Item = usize>> = match leg.end {
                PipeEnd::Left => Box::new(0..ng),
                PipeEnd::Right => Box::new((ng + nc)..n_total),
            };
            for i in indices {
                let a = pipe.area[i];
                pipe.q[i * N_VARS + I_RHO_A] = rho * a;
                pipe.q[i * N_VARS + I_MOM_A] = 0.0;
                pipe.q[i * N_VARS + I_E_A]   = e_density * a;
                pipe.q[i * N_VARS + I_Y_A]   = rho * y * a;
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
