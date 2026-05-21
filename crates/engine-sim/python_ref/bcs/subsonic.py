"""Subsonic inflow and back-pressure outflow BCs.

Two flavors of subsonic-inflow BC are provided:

- ``fill_subsonic_inflow_left`` — original 4-primitive (over-determined)
  imposition. Kept for back-compat with existing nozzle and friction
  validation tests, which use it to "set the face state directly" for
  driven-flow validations (where the imposed static pressure +
  prescribed velocity is the intended behavior). The acoustic-BC audit
  diagnosed it as absorbing for incident waves (R_plenum ≈ −0.07
  instead of the physical −1; see
  ``docs/acoustic_diagnosis/findings.md``), so it must NOT be used in
  the engine model or anywhere wave reflection matters.

- ``fill_subsonic_inflow_left_characteristic`` — Phase C2 (2026-04-14)
  characteristic-correct subsonic inflow for a stagnation reservoir.
  Imposes 2 conditions from the reservoir (stagnation enthalpy h₀ +
  entropy s₀ derived from the supplied (rho, p, T) treated as
  stagnation values) and takes 1 outgoing acoustic invariant J⁻ from
  the interior. The supplied ``u`` argument is ignored (a stagnation
  reservoir is by definition u = 0). Standard CFD treatment per Toro
  § 6.3 / Hirsch Vol. 2 Ch. 19; reflects acoustic waves with R = −1 in
  the linear limit. **This is the function to use in production / the
  engine model.**

Subsonic outflow (``fill_subsonic_outflow_right``): imposes p in the
ghost cells and extrapolates ρ, u, Y from the adjacent interior cell.
1 characteristic enters → 1 condition imposed; this BC is already
characteristic-correct for subsonic outflow.

Degenerate cold-start: when the interior is at rest with c_int ≈ c_0
(stagnation sound speed of the reservoir), the characteristic +
energy system has only the trivial u_face = 0 solution (no
characteristic-consistent way to spin up flow from rest). In that
case the BC falls back to imposing the reservoir state (effectively
the over-determined behavior). This is harmless because (a) at
startup there are no waves to absorb and (b) once any non-trivial
acoustic content reaches the interior, u_int develops and the
characteristic path takes over.
"""

from __future__ import annotations

import numpy as np

from solver.state import PipeState, I_RHO_A, I_MOM_A, I_E_A, I_Y_A


# ---------------------------------------------------------------------------
# OVER-DETERMINED BC (back-compat, used by existing driven-flow tests)
# ---------------------------------------------------------------------------

def fill_subsonic_inflow_left(
    state: PipeState, rho: float, u: float, p: float, Y: float,
) -> None:
    """Original 4-primitive imposition. Acoustically absorbing for
    incident waves; do not use where wave reflection matters. See module
    docstring."""
    ng = state.n_ghost
    gamma = state.gamma
    gm1 = gamma - 1.0
    E = p / gm1 + 0.5 * rho * u * u
    for i in range(ng):
        A = state.area[i]
        state.q[i, I_RHO_A] = rho * A
        state.q[i, I_MOM_A] = rho * u * A
        state.q[i, I_E_A]   = E * A
        state.q[i, I_Y_A]   = rho * Y * A


# ---------------------------------------------------------------------------
# CHARACTERISTIC-CORRECT BC (Phase C2 fix, 2026-04-14)
# ---------------------------------------------------------------------------

def fill_subsonic_inflow_left_characteristic(
    state: PipeState, rho: float, u: float, p: float, Y: float,
) -> None:
    """Characteristic-based subsonic inflow at the LEFT boundary.

    Replaces the legacy 4-primitive over-determined BC. Same call
    signature for back-compat. The (rho, p) reservoir state is taken
    from the call args; the supplied ``u`` argument is ignored
    (stagnation reservoir is by definition u = 0). ``Y`` is used as
    the reservoir composition.

    For the LEFT boundary with subsonic inflow into the pipe (u_face > 0
    expected) the characteristic count is:
      λ₁ = u − c < 0 → outgoing  → take J⁻ from interior
      λ₂ = u > 0     → incoming  → impose entropy s₀ from reservoir
      λ₃ = u + c > 0 → incoming  → impose stagnation enthalpy h₀

    The energy + J⁻ pair pins (c_face, u_face) via a quadratic
    independent of p_face; (ρ_face, p_face) then follow from the
    reservoir entropy K = p/ρ^γ.

    Cold-start fallback: when the quadratic has no positive c_face or
    the resulting u_face is non-positive (i.e. the interior cannot
    support inflow at this reservoir condition), set ghost to the
    reservoir state with u = 0. Acoustically transmissive at startup
    only — see module docstring for why this is harmless.
    """
    ng = state.n_ghost
    gamma = state.gamma
    gm1 = gamma - 1.0
    R_gas = state.R_gas

    # Reservoir state. Note: the supplied `rho` is used as-is for the
    # reservoir density (back-compat with the original signature). For
    # most engine call sites, rho = p / (R·T_atm), so this is consistent.
    rho_res = max(rho, 1e-20)
    p_res = max(p, 1.0)
    T_res = p_res / (rho_res * R_gas)

    # Interior cell adjacent to the boundary face
    A_pipe = state.area[ng]
    rho_int = state.q[ng, I_RHO_A] / A_pipe
    u_int = state.q[ng, I_MOM_A] / (rho_int * A_pipe)
    E_int = state.q[ng, I_E_A] / A_pipe
    p_int = max(gm1 * (E_int - 0.5 * rho_int * u_int * u_int), 1.0)
    c_int = float(np.sqrt(max(gamma * p_int / max(rho_int, 1e-20), 1.0)))

    # Characteristic outgoing invariant from interior:
    J_minus = u_int - 2.0 * c_int / gm1

    # Energy + J quadratic in c_face:
    c_0_sq = gamma * R_gas * max(T_res, 100.0)
    a_q = gamma + 1.0
    b_q = 2.0 * J_minus * gm1
    d_q = 0.5 * gm1 * gm1 * J_minus * J_minus - gm1 * c_0_sq
    disc = b_q * b_q - 4.0 * a_q * d_q

    use_fallback = False
    rho_face = u_face = p_face = None
    if disc >= 0.0:
        sqrt_disc = float(np.sqrt(disc))
        c_face = (-b_q + sqrt_disc) / (2.0 * a_q)
        if c_face <= 0.0:
            c_face = (-b_q - sqrt_disc) / (2.0 * a_q)
        if c_face > 0.0 and np.isfinite(c_face):
            u_face = J_minus + 2.0 * c_face / gm1
            if u_face > 0.0:
                # ρ from reservoir entropy K = p_res/ρ_res^γ
                K = p_res / (rho_res ** gamma)
                rho_face = (c_face * c_face / (gamma * K)) ** (1.0 / gm1)
                p_face = K * rho_face ** gamma
                if not (np.isfinite(rho_face) and np.isfinite(p_face)
                        and rho_face > 0.0 and p_face > 0.0):
                    use_fallback = True
            else:
                use_fallback = True
        else:
            use_fallback = True
    else:
        use_fallback = True

    if use_fallback:
        rho_face = rho_res
        u_face = 0.0
        p_face = p_res

    Y_face = Y
    E_face = p_face / gm1 + 0.5 * rho_face * u_face * u_face
    for i in range(ng):
        A = state.area[i]
        state.q[i, I_RHO_A] = rho_face * A
        state.q[i, I_MOM_A] = rho_face * u_face * A
        state.q[i, I_E_A]   = E_face * A
        state.q[i, I_Y_A]   = rho_face * Y_face * A


def fill_subsonic_outflow_right(state: PipeState, p_back: float) -> None:
    """Set right ghosts to the interior primitives (ρ, u, Y) with p replaced."""
    ng = state.n_ghost
    nc = state.n_cells
    gamma = state.gamma
    gm1 = gamma - 1.0
    src = ng + nc - 1
    A_src = state.area[src]
    rho = state.q[src, I_RHO_A] / A_src
    u = state.q[src, I_MOM_A] / (rho * A_src)
    Y = state.q[src, I_Y_A] / (rho * A_src)
    p = p_back
    E = p / gm1 + 0.5 * rho * u * u
    for i in range(ng + nc, state.n_total):
        A = state.area[i]
        state.q[i, I_RHO_A] = rho * A
        state.q[i, I_MOM_A] = rho * u * A
        state.q[i, I_E_A]   = E * A
        state.q[i, I_Y_A]   = rho * Y * A
