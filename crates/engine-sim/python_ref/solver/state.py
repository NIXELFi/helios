"""Flat-array state representation for a single pipe.

Layout:
    q       : (n_cells + 2*n_ghost, 4) float64, conservative vars (ρA, ρuA, EA, ρYA)
    area    : (n_cells + 2*n_ghost,)  float64, cell-centred area [m^2]
    area_f  : (n_cells + 2*n_ghost + 1,) float64, face areas at interior+boundary faces
    dx      : float, uniform cell width [m]
    n_cells : int, number of real cells
    n_ghost : int, typically 2 for MUSCL-Hancock

Only real cells are evolved. Ghost cells are filled by BCs before each step.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

N_VARS = 4
I_RHO_A, I_MOM_A, I_E_A, I_Y_A = 0, 1, 2, 3  # indices into q axis 1


@dataclass
class PipeState:
    """Holds the flat arrays for one pipe domain.

    All arrays are float64 and owned by this object; numba kernels receive
    them by reference.

    Indexing:
        q[0]..q[n_ghost-1]               : left ghost cells
        q[n_ghost]..q[n_ghost+n_cells-1] : real cells
        q[n_ghost+n_cells]..             : right ghost cells
    """

    q: np.ndarray             # shape (N, 4)
    area: np.ndarray          # shape (N,)   cell-centred cross-section
    area_f: np.ndarray        # shape (N+1,) face cross-section
    dx: float
    n_cells: int
    n_ghost: int = 2
    gamma: float = 1.4         # frozen γ for the pipe. Mixture γ is handled
                               # via the cylinder/valve-BC side; for FSAE pipe
                               # flow this constant γ is adequate. Can be made
                               # variable later.
    R_gas: float = 287.0       # J/(kg·K), unburned air default
    wall_T: float = 320.0      # K
    hydraulic_D: np.ndarray = None  # shape (N,), hydraulic diameter [m]

    @property
    def n_total(self) -> int:
        return self.q.shape[0]

    def real_slice(self) -> slice:
        return slice(self.n_ghost, self.n_ghost + self.n_cells)


def make_pipe_state(
    n_cells: int,
    length: float,
    area_fn,              # callable A(x) [m^2] at cell centres and faces
    gamma: float = 1.4,
    R_gas: float = 287.0,
    wall_T: float = 320.0,
    n_ghost: int = 2,
    hydraulic_D_fn=None,  # callable D(x) [m]; default from area
) -> PipeState:
    """Build a PipeState for a pipe of given length and area profile.

    Cell centres at x_i = (i + 0.5) · dx, i = 0..n_cells-1.
    Face i+1/2 at x_{i+1/2} = i · dx, for i = 0..n_cells.
    """
    assert n_cells >= 4, "MUSCL-Hancock requires n_cells >= 4"
    dx = length / n_cells

    n_total = n_cells + 2 * n_ghost
    q = np.zeros((n_total, N_VARS), dtype=np.float64)
    area = np.zeros(n_total, dtype=np.float64)
    area_f = np.zeros(n_total + 1, dtype=np.float64)
    hyd_D = np.zeros(n_total, dtype=np.float64)

    # Real-cell centres + two ghost cells per side.
    for i in range(n_total):
        # Ghost cells to the left have i < n_ghost, to the right i >= n_ghost+n_cells
        i_real = i - n_ghost
        x_centre = (i_real + 0.5) * dx
        area[i] = float(area_fn(x_centre))
        if hydraulic_D_fn is None:
            # For a circular pipe, D = sqrt(4A/pi).
            hyd_D[i] = float(np.sqrt(max(4.0 * area[i] / np.pi, 0.0)))
        else:
            hyd_D[i] = float(hydraulic_D_fn(x_centre))

    for i in range(n_total + 1):
        i_real = i - n_ghost
        x_face = i_real * dx
        area_f[i] = float(area_fn(x_face))

    return PipeState(
        q=q, area=area, area_f=area_f, dx=dx,
        n_cells=n_cells, n_ghost=n_ghost,
        gamma=gamma, R_gas=R_gas, wall_T=wall_T,
        hydraulic_D=hyd_D,
    )


def set_uniform(state: PipeState, rho: float, u: float, p: float, Y: float = 0.0) -> None:
    """Initialise all cells (real + ghost) to a uniform primitive state."""
    gm1 = state.gamma - 1.0
    e_int = p / (gm1 * rho)   # specific internal energy
    E = rho * (e_int + 0.5 * u * u)  # total energy per unit volume
    A = state.area
    state.q[:, I_RHO_A] = rho * A
    state.q[:, I_MOM_A] = rho * u * A
    state.q[:, I_E_A]   = E * A
    state.q[:, I_Y_A]   = rho * Y * A


def set_left_right(
    state: PipeState, x0: float,
    rhoL: float, uL: float, pL: float, YL: float,
    rhoR: float, uR: float, pR: float, YR: float,
) -> None:
    """Initialise a left state for x < x0 and right state otherwise.

    Includes ghost cells; the caller's BC code will overwrite ghost states
    as needed.
    """
    gm1 = state.gamma - 1.0
    dx = state.dx
    n_ghost = state.n_ghost
    for i in range(state.n_total):
        i_real = i - n_ghost
        x_centre = (i_real + 0.5) * dx
        rho, u, p, Y = (rhoL, uL, pL, YL) if x_centre < x0 else (rhoR, uR, pR, YR)
        e_int = p / (gm1 * rho)
        E = rho * (e_int + 0.5 * u * u)
        A = state.area[i]
        state.q[i, I_RHO_A] = rho * A
        state.q[i, I_MOM_A] = rho * u * A
        state.q[i, I_E_A]   = E * A
        state.q[i, I_Y_A]   = rho * Y * A


def primitives_from_q_row(q_row: np.ndarray, A: float, gamma: float):
    """Convenience: get (ρ, u, p, Y) for a single cell from q and A."""
    rho = q_row[I_RHO_A] / A
    u = q_row[I_MOM_A] / (rho * A)
    E = q_row[I_E_A] / A
    kinetic = 0.5 * rho * u * u
    p = (gamma - 1.0) * (E - kinetic)
    Y = q_row[I_Y_A] / (rho * A)
    return rho, u, p, Y


def primitives_array(state: PipeState) -> np.ndarray:
    """Return (N,4) array of primitives (ρ, u, p, Y) for every cell."""
    n = state.n_total
    w = np.zeros((n, 4), dtype=np.float64)
    for i in range(n):
        rho, u, p, Y = primitives_from_q_row(state.q[i], state.area[i], state.gamma)
        w[i, 0] = rho
        w[i, 1] = u
        w[i, 2] = p
        w[i, 3] = Y
    return w


def total_mass(state: PipeState) -> float:
    """Integrate ρA dx over real cells only."""
    s = state.real_slice()
    return float(state.dx * state.q[s, I_RHO_A].sum())


def total_energy(state: PipeState) -> float:
    """Integrate EA dx over real cells only."""
    s = state.real_slice()
    return float(state.dx * state.q[s, I_E_A].sum())
