//! Flat-array pipe state representation.
//! Direct port of `solver/state.py`.
//!
//! Layout per cell (4 conservative variables):
//!     q[i*N_VARS + 0] = ρA
//!     q[i*N_VARS + 1] = ρuA
//!     q[i*N_VARS + 2] = EA
//!     q[i*N_VARS + 3] = ρYA

use std::f64::consts::PI;

pub const N_VARS: usize = 4;
pub const I_RHO_A: usize = 0;
pub const I_MOM_A: usize = 1;
pub const I_E_A:   usize = 2;
pub const I_Y_A:   usize = 3;

#[derive(Debug, Clone)]
pub struct PipeState {
    pub q: Vec<f64>,                // shape (n_total * N_VARS,)
    pub area: Vec<f64>,             // shape (n_total,)
    pub area_f: Vec<f64>,           // shape (n_total + 1,)
    pub hydraulic_d: Vec<f64>,      // shape (n_total,)
    pub dx: f64,
    pub n_cells: usize,
    pub n_ghost: usize,
    pub gamma: f64,
    pub r_gas: f64,
    pub wall_t: f64,
}

#[derive(Debug, Clone)]
pub struct ScratchBuffers {
    pub w:        Vec<f64>,   // (n_total * N_VARS)
    pub slopes:   Vec<f64>,
    pub w_pred_l: Vec<f64>,
    pub w_pred_r: Vec<f64>,
    pub flux:     Vec<f64>,   // ((n_total + 1) * N_VARS)
}

impl ScratchBuffers {
    pub fn for_pipe(state: &PipeState) -> Self {
        let n = state.n_total();
        Self {
            w:        vec![0.0; n * N_VARS],
            slopes:   vec![0.0; n * N_VARS],
            w_pred_l: vec![0.0; n * N_VARS],
            w_pred_r: vec![0.0; n * N_VARS],
            flux:     vec![0.0; (n + 1) * N_VARS],
        }
    }
}

impl PipeState {
    #[inline]
    pub fn n_total(&self) -> usize {
        self.n_cells + 2 * self.n_ghost
    }

    #[inline]
    pub fn real_range(&self) -> std::ops::Range<usize> {
        self.n_ghost..(self.n_ghost + self.n_cells)
    }

    /// q[i, k]
    #[inline]
    pub fn q_at(&self, i: usize, k: usize) -> f64 {
        self.q[i * N_VARS + k]
    }

    /// q[i, k] = v
    #[inline]
    pub fn q_set(&mut self, i: usize, k: usize, v: f64) {
        self.q[i * N_VARS + k] = v;
    }
}

/// Build a PipeState with cell-centred area from a callback. The callback
/// `area_fn(x)` returns A(x) in m² for any x ∈ [-n_ghost·dx, L + n_ghost·dx].
///
/// Ghost cells are real cells offset by n_ghost; their `area` and
/// `hydraulic_d` are evaluated at their (signed) x_centre, exactly as
/// the Python reference does.
pub fn make_pipe_state<F>(
    n_cells: usize,
    length: f64,
    mut area_fn: F,
    gamma: f64,
    r_gas: f64,
    wall_t: f64,
    n_ghost: usize,
) -> PipeState
where
    F: FnMut(f64) -> f64,
{
    assert!(n_cells >= 4, "MUSCL-Hancock requires n_cells >= 4");
    let dx = length / (n_cells as f64);
    let n_total = n_cells + 2 * n_ghost;
    let mut area = vec![0.0_f64; n_total];
    let mut area_f = vec![0.0_f64; n_total + 1];
    let mut hyd_d = vec![0.0_f64; n_total];

    for i in 0..n_total {
        let i_real = (i as i64) - (n_ghost as i64);
        let x_centre = ((i_real as f64) + 0.5) * dx;
        let a = area_fn(x_centre);
        area[i] = a;
        // Default hydraulic D: D = sqrt(4A/π)
        let arg = 4.0 * a / PI;
        let arg_safe = if arg > 0.0 { arg } else { 0.0 };
        hyd_d[i] = arg_safe.sqrt();
    }
    for i in 0..(n_total + 1) {
        let i_real = (i as i64) - (n_ghost as i64);
        let x_face = (i_real as f64) * dx;
        area_f[i] = area_fn(x_face);
    }

    PipeState {
        q: vec![0.0_f64; n_total * N_VARS],
        area,
        area_f,
        hydraulic_d: hyd_d,
        dx,
        n_cells,
        n_ghost,
        gamma,
        r_gas,
        wall_t,
    }
}

/// Initialise all cells (real + ghost) to a uniform primitive state.
pub fn set_uniform(state: &mut PipeState, rho: f64, u: f64, p: f64, y: f64) {
    let gm1 = state.gamma - 1.0;
    let e_int = p / (gm1 * rho);
    let big_e = rho * (e_int + 0.5 * u * u);
    let n_total = state.n_total();
    for i in 0..n_total {
        let a = state.area[i];
        state.q[i * N_VARS + I_RHO_A] = rho * a;
        state.q[i * N_VARS + I_MOM_A] = rho * u * a;
        state.q[i * N_VARS + I_E_A]   = big_e * a;
        state.q[i * N_VARS + I_Y_A]   = rho * y * a;
    }
}

#[allow(clippy::too_many_arguments)]
pub fn set_left_right(
    state: &mut PipeState, x0: f64,
    rho_l: f64, u_l: f64, p_l: f64, y_l: f64,
    rho_r: f64, u_r: f64, p_r: f64, y_r: f64,
) {
    let gm1 = state.gamma - 1.0;
    let dx = state.dx;
    let n_ghost = state.n_ghost;
    let n_total = state.n_total();
    for i in 0..n_total {
        let i_real = (i as i64) - (n_ghost as i64);
        let x_centre = ((i_real as f64) + 0.5) * dx;
        let (rho, u, p, y) = if x_centre < x0 {
            (rho_l, u_l, p_l, y_l)
        } else {
            (rho_r, u_r, p_r, y_r)
        };
        let e_int = p / (gm1 * rho);
        let big_e = rho * (e_int + 0.5 * u * u);
        let a = state.area[i];
        state.q[i * N_VARS + I_RHO_A] = rho * a;
        state.q[i * N_VARS + I_MOM_A] = rho * u * a;
        state.q[i * N_VARS + I_E_A]   = big_e * a;
        state.q[i * N_VARS + I_Y_A]   = rho * y * a;
    }
}

/// (ρ, u, p, Y) for a single cell.
#[inline]
pub fn primitives_from_cell(state: &PipeState, i: usize) -> (f64, f64, f64, f64) {
    let a = state.area[i];
    let rho = state.q[i * N_VARS + I_RHO_A] / a;
    let u = state.q[i * N_VARS + I_MOM_A] / (rho * a);
    let big_e = state.q[i * N_VARS + I_E_A] / a;
    let kinetic = 0.5 * rho * u * u;
    let p = (state.gamma - 1.0) * (big_e - kinetic);
    let y = state.q[i * N_VARS + I_Y_A] / (rho * a);
    (rho, u, p, y)
}

/// (N, 4) array of primitives (ρ, u, p, Y).
pub fn primitives_array(state: &PipeState) -> Vec<f64> {
    let n = state.n_total();
    let mut w = vec![0.0_f64; n * N_VARS];
    for i in 0..n {
        let (rho, u, p, y) = primitives_from_cell(state, i);
        w[i * N_VARS]     = rho;
        w[i * N_VARS + 1] = u;
        w[i * N_VARS + 2] = p;
        w[i * N_VARS + 3] = y;
    }
    w
}

/// Integrate ρA dx over real cells only.
pub fn total_mass(state: &PipeState) -> f64 {
    let mut s = 0.0_f64;
    for i in state.real_range() {
        s += state.q[i * N_VARS + I_RHO_A];
    }
    state.dx * s
}

pub fn total_energy(state: &PipeState) -> f64 {
    let mut s = 0.0_f64;
    for i in state.real_range() {
        s += state.q[i * N_VARS + I_E_A];
    }
    state.dx * s
}
