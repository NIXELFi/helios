"""Simple ghost-cell BCs for validation tests: transmissive and reflective.

- transmissive (a.k.a. zero-gradient, outflow): copy the adjacent real cell
  into the ghost cells. Works for shock tube outflow.
- reflective (a.k.a. wall, closed end): mirror the state with velocity sign
  flip. This is what a solid wall does: u → -u across the wall, other
  primitives unchanged.

Both functions mutate q in place for ghost cells only.

For quasi-1D, ghost-cell `area` is already set by the pipe geometry; we
only update the conservative values.
"""

from __future__ import annotations

import numpy as np

from solver.state import PipeState, I_RHO_A, I_MOM_A, I_E_A, I_Y_A


def fill_transmissive_left(state: PipeState) -> None:
    """Zero-gradient left BC: copy first real cell primitive state to ghosts,
    then reconvert to conservative using the ghost-cell area.
    """
    ng = state.n_ghost
    gamma = state.gamma
    gm1 = gamma - 1.0
    # Source: first real cell
    src = ng
    A_src = state.area[src]
    rho = state.q[src, I_RHO_A] / A_src
    u = state.q[src, I_MOM_A] / (rho * A_src)
    E = state.q[src, I_E_A] / A_src
    p = gm1 * (E - 0.5 * rho * u * u)
    Y = state.q[src, I_Y_A] / (rho * A_src)
    for i in range(ng):
        A_g = state.area[i]
        state.q[i, I_RHO_A] = rho * A_g
        state.q[i, I_MOM_A] = rho * u * A_g
        state.q[i, I_E_A]   = (p / gm1 + 0.5 * rho * u * u) * A_g
        state.q[i, I_Y_A]   = rho * Y * A_g


def fill_transmissive_right(state: PipeState) -> None:
    ng = state.n_ghost
    gamma = state.gamma
    gm1 = gamma - 1.0
    src = ng + state.n_cells - 1
    A_src = state.area[src]
    rho = state.q[src, I_RHO_A] / A_src
    u = state.q[src, I_MOM_A] / (rho * A_src)
    E = state.q[src, I_E_A] / A_src
    p = gm1 * (E - 0.5 * rho * u * u)
    Y = state.q[src, I_Y_A] / (rho * A_src)
    for i in range(ng + state.n_cells, state.n_total):
        A_g = state.area[i]
        state.q[i, I_RHO_A] = rho * A_g
        state.q[i, I_MOM_A] = rho * u * A_g
        state.q[i, I_E_A]   = (p / gm1 + 0.5 * rho * u * u) * A_g
        state.q[i, I_Y_A]   = rho * Y * A_g


def fill_reflective_left(state: PipeState) -> None:
    """Wall / closed-end mirror: ghost k reflects interior k.

    Mapping for n_ghost = 2: ghost[1] mirrors real[0], ghost[0] mirrors real[1].
    ρ, p, Y copy; u flips sign.
    """
    ng = state.n_ghost
    gamma = state.gamma
    gm1 = gamma - 1.0
    for k in range(ng):
        i_g = ng - 1 - k   # ghost index counting from inside out
        i_r = ng + k       # real index counting from inside out
        A_r = state.area[i_r]
        rho = state.q[i_r, I_RHO_A] / A_r
        u = state.q[i_r, I_MOM_A] / (rho * A_r)
        E = state.q[i_r, I_E_A] / A_r
        p = gm1 * (E - 0.5 * rho * u * u)
        Y = state.q[i_r, I_Y_A] / (rho * A_r)
        A_g = state.area[i_g]
        state.q[i_g, I_RHO_A] = rho * A_g
        state.q[i_g, I_MOM_A] = -rho * u * A_g
        state.q[i_g, I_E_A]   = (p / gm1 + 0.5 * rho * u * u) * A_g
        state.q[i_g, I_Y_A]   = rho * Y * A_g


def fill_reflective_right(state: PipeState) -> None:
    ng = state.n_ghost
    gamma = state.gamma
    gm1 = gamma - 1.0
    nc = state.n_cells
    for k in range(ng):
        i_g = ng + nc + k       # ghost counting outward
        i_r = ng + nc - 1 - k   # real counting inward
        A_r = state.area[i_r]
        rho = state.q[i_r, I_RHO_A] / A_r
        u = state.q[i_r, I_MOM_A] / (rho * A_r)
        E = state.q[i_r, I_E_A] / A_r
        p = gm1 * (E - 0.5 * rho * u * u)
        Y = state.q[i_r, I_Y_A] / (rho * A_r)
        A_g = state.area[i_g]
        state.q[i_g, I_RHO_A] = rho * A_g
        state.q[i_g, I_MOM_A] = -rho * u * A_g
        state.q[i_g, I_E_A]   = (p / gm1 + 0.5 * rho * u * u) * A_g
        state.q[i_g, I_Y_A]   = rho * Y * A_g
