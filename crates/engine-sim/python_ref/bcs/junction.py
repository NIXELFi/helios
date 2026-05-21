"""N-pipe junction BC — constant-pressure ghost-cell filler.

Models a lossless merge of N pipes meeting at a common point (the standard
1D approximation of a 4-2-1 exhaust manifold). All pipes see a common
junction static pressure p_j; mass flows between pipes are determined by
each pipe's interior characteristic and p_j.

Per the Phase 2 plan:
  "constant static pressure assumption with mass-weighted enthalpy mixing,
   solved iteratively. Area-weighted momentum conservation."

The V2 ghost-cell approach:

  For each pipe (at its junction end):
    - C-characteristic arriving from the pipe interior is the known
      Riemann invariant.
    - The ghost cell sits on the "junction side" of that end.
    - Set ghost p = p_j; derive ghost u from the incoming characteristic
      along an isentropic expansion from the pipe interior state to p_j:
          a_face  = a_pipe · (p_j / p_pipe)^((γ−1)/(2γ))
          u_face  = u_pipe + (2/(γ−1)) · (a_pipe − a_face) · s
      where s = +1 at the pipe's RIGHT end and −1 at the LEFT end.
    - ρ_ghost from isentropic: ρ_face = ρ_pipe · (p_j / p_pipe)^(1/γ).
    - Y_ghost = Y_pipe for now (composition carried by contact wave from
      whichever side is upstream).

  The unknown p_j is solved by Newton iteration on the mass-balance
  residual  Σ sign_i · ρ_face_i · u_face_i · A_pipe_i = 0, with sign_i
  defined so that flow INTO the junction is positive.

  For subsonic inflow legs, composition Y mixes mass-weighted in the
  junction volume and that mixed Y is written into the ghost cells of
  the outflow legs. For the simple FSAE 4-2-1 case where primaries
  always feed into secondaries/collector (one-way flow most of the time),
  this gives the right behaviour without further refinement.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np

from solver.state import PipeState, I_RHO_A, I_MOM_A, I_E_A, I_Y_A


# Pipe end string constants for clarity
LEFT = "left"
RIGHT = "right"


@dataclass
class JunctionLeg:
    state: PipeState
    end: str             # "left" or "right"
    sign: int = 0        # +1 if u>0 at the pipe's junction face means flow INTO the junction

    def __post_init__(self):
        if self.sign == 0:
            # Default: RIGHT end → +1 (flow out of pipe goes into junction)
            #          LEFT end  → −1
            self.sign = +1 if self.end == RIGHT else -1


def _interior_primitive(state: PipeState, end: str):
    """Return (ρ, u, p, Y, a, A_pipe) from the first real cell at the given end."""
    ng = state.n_ghost
    gm1 = state.gamma - 1.0
    i = ng if end == LEFT else ng + state.n_cells - 1
    A = state.area[i]
    rho = state.q[i, I_RHO_A] / A
    u = state.q[i, I_MOM_A] / (rho * A)
    E = state.q[i, I_E_A] / A
    p = max(gm1 * (E - 0.5 * rho * u * u), 1.0)
    Y = state.q[i, I_Y_A] / (rho * A)
    a = np.sqrt(state.gamma * p / max(rho, 1e-9))
    return rho, u, p, Y, a, A


def _face_state_from_p_j(rho_i, u_i, p_i, a_i, p_j, gamma, end):
    """Isentropic expansion from pipe interior to junction pressure p_j.

    Returns (ρ_face, u_face)."""
    gm1 = gamma - 1.0
    ratio = max(p_j / p_i, 1e-6)
    a_face = a_i * ratio ** (gm1 / (2.0 * gamma))
    rho_face = rho_i * ratio ** (1.0 / gamma)
    # At RIGHT end: C+ characteristic incoming; s = +1.
    # At LEFT end:  C- incoming; s = -1.
    s = +1.0 if end == RIGHT else -1.0
    u_face = u_i + (2.0 / gm1) * (a_i - a_face) * s
    return rho_face, u_face


def apply_junction(legs: List[JunctionLeg], max_iter: int = 30, tol: float = 1e-6) -> float:
    """Solve for p_j and write ghost cells. Returns p_j (Pa).

    All legs must share the same γ (enforced: we read the first leg's γ).
    """
    if len(legs) < 2:
        return 0.0
    gamma = legs[0].state.gamma

    # Collect interior states
    interiors = [_interior_primitive(L.state, L.end) for L in legs]

    # Initial guess: mean of interior pressures
    p_j = float(np.mean([it[2] for it in interiors]))

    for _ in range(max_iter):
        mass_resid = 0.0
        dmass_dp = 0.0
        for L, it in zip(legs, interiors):
            rho_i, u_i, p_i, Y_i, a_i, A_pipe = it
            rho_f, u_f = _face_state_from_p_j(rho_i, u_i, p_i, a_i, p_j, gamma, L.end)
            mass_resid += L.sign * rho_f * u_f * A_pipe

            # Finite-difference derivative
            eps = max(1e-5 * p_j, 1.0)
            rho_fp, u_fp = _face_state_from_p_j(rho_i, u_i, p_i, a_i, p_j + eps, gamma, L.end)
            dmass_dp += L.sign * (rho_fp * u_fp - rho_f * u_f) * A_pipe / eps

        if abs(dmass_dp) < 1e-30:
            break
        dp = -mass_resid / dmass_dp
        # Damp large steps
        dp = max(-0.2 * p_j, min(0.2 * p_j, dp))
        p_j += dp
        p_j = max(p_j, 1e3)
        if abs(mass_resid) < tol:
            break

    # Composition mixing: mass-weighted over legs with flow INTO junction
    mdot_in_total = 0.0
    YsumIn = 0.0
    leg_mdots_signed = []
    for L, it in zip(legs, interiors):
        rho_i, u_i, p_i, Y_i, a_i, A_pipe = it
        rho_f, u_f = _face_state_from_p_j(rho_i, u_i, p_i, a_i, p_j, gamma, L.end)
        signed_into_junction = L.sign * rho_f * u_f * A_pipe
        leg_mdots_signed.append((L, it, rho_f, u_f, signed_into_junction))
        if signed_into_junction > 0:
            mdot_in_total += signed_into_junction
            YsumIn += signed_into_junction * Y_i
    Y_mixed = YsumIn / mdot_in_total if mdot_in_total > 1e-30 else 0.0

    # Fill each leg's ghost cells
    gm1 = gamma - 1.0
    for L, it, rho_f, u_f, signed in leg_mdots_signed:
        rho_i, u_i, p_i, Y_i, a_i, A_pipe = it
        # Composition in ghost: Y_i if this leg is delivering flow to junction
        # (the upstream side keeps its own composition, HLLC will upwind it);
        # Y_mixed if this leg is receiving from the junction (the junction's
        # outlet side supplies the mixed composition to the ghost).
        if signed >= 0:
            Y_ghost = Y_i
        else:
            Y_ghost = Y_mixed

        # Ghost velocity sign: at the PIPE's junction face, u_face was
        # already computed; we need to put this in the ghost cells OUTSIDE
        # the pipe. The ghost is on the "junction side" of the face, so
        # its primitive u is the same sign as the face u (same value).
        ng = L.state.n_ghost
        nc = L.state.n_cells
        if L.end == LEFT:
            ghost_range = range(0, ng)
        else:
            ghost_range = range(ng + nc, L.state.n_total)
        E_ghost = p_j / gm1 + 0.5 * rho_f * u_f * u_f
        for i in ghost_range:
            A_g = L.state.area[i]
            L.state.q[i, I_RHO_A] = rho_f * A_g
            L.state.q[i, I_MOM_A] = rho_f * u_f * A_g
            L.state.q[i, I_E_A]   = E_ghost * A_g
            L.state.q[i, I_Y_A]   = rho_f * Y_ghost * A_g

    return p_j
