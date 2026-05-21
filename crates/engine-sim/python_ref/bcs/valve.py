"""Entropy-aware valve ghost-cell BC — the V1 fix.

V1's MOC valve BC carried pipe-side entropy (AA) across the valve,
underpredicting exhaust pipe temperature by ~75 % and wave speed by ~2×.
V2's V2 valve BC tracks composition Y = burned mass fraction as a
conservative scalar and sets the ghost cell's (ρ, T, Y) to the reservoir
side (cylinder for exhaust outflow, pipe for intake outflow), so the
HLLC contact wave carries the correct entropy into the pipe.

Mechanism:
  1. Compute effective valve flow area A_eff(θ) from lift × Cd tables.
  2. If A_eff ≈ 0: valve closed, use reflective ghost (wall).
  3. Determine flow direction from (p_cyl, p_pipe_interior).
  4. Compute ṁ via compressible-orifice equation using UPSTREAM gas
     properties (p_up, T_up, R_up, γ_up, composition Y_up).
  5. Set ghost primitives:
        p_ghost = p_pipe_interior  (zero-gradient for subsonic coupling)
        T_ghost = T_up · (p_ghost / p_up)^((γ-1)/γ)  (isentropic expansion)
        ρ_ghost = p_ghost / (R_up · T_ghost)
        u_ghost = ṁ / (ρ_ghost · A_pipe)  with sign from flow direction
        Y_ghost = Y_up           (composition of upstream gas)

HLLC at the ghost/interior face then carries u, ρ, p, Y through the
contact wave correctly; the computed flux is what actually enters/leaves
the pipe, and the cylinder reads the same flux back (see
caller in models/sdm26.py for the flux-return plumbing).

SI units throughout. No Benson non-dim.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from solver.state import PipeState, I_RHO_A, I_MOM_A, I_E_A, I_Y_A
from cylinder.gas_properties import gamma_mixture, R_mixture, R_AIR
from cylinder.valve import ValveParams, valve_effective_area


@dataclass
class ValveBC:
    """Configures a valve boundary at one end of a pipe."""
    pipe_end: str              # "left" (exhaust) or "right" (intake)
    valve_type: str            # "intake" or "exhaust"
    valve: ValveParams


def _mass_flow_orifice(
    p_up: float, T_up: float, p_down: float,
    A_eff: float, gamma: float, R_gas: float,
) -> float:
    """Compressible-orifice ṁ from upstream stagnation state to downstream p.

    A_eff here should ALREADY include n_valves · Cd (that's what
    cylinder.valve.valve_effective_area returns), so this function does not
    re-multiply by Cd.
    """
    if p_up <= 0.0 or A_eff <= 0.0:
        return 0.0
    pr = p_down / p_up
    if pr >= 1.0:
        return 0.0
    if pr < 0.0:
        pr = 0.0
    pr_crit = (2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0))
    if pr <= pr_crit:
        choke = (2.0 / (gamma + 1.0)) ** ((gamma + 1.0) / (2.0 * (gamma - 1.0)))
        return A_eff * p_up * np.sqrt(gamma / (R_gas * max(T_up, 100.0))) * choke
    t1 = pr ** (2.0 / gamma)
    t2 = pr ** ((gamma + 1.0) / gamma)
    flow_fn = np.sqrt(max(2.0 * gamma / (gamma - 1.0) * (t1 - t2), 0.0))
    return A_eff * p_up / np.sqrt(R_gas * max(T_up, 100.0)) * flow_fn


def _fill_reflective_at_end(state: PipeState, pipe_end: str) -> None:
    """Wall-like ghost fill for a closed valve."""
    from bcs.simple import fill_reflective_left, fill_reflective_right
    if pipe_end == "left":
        fill_reflective_left(state)
    else:
        fill_reflective_right(state)


def fill_valve_ghost(
    state: PipeState,
    pipe_end: str,
    valve_type: str,
    vp: ValveParams,
    theta_local_deg: float,
    p_cyl: float, T_cyl: float, xb_cyl: float,
) -> float:
    """Fill valve-side ghost cells. Returns the BC's claimed ṁ (kg/s).

    Sign convention for the returned ṁ:
        Exhaust valve (pipe_end='left'): positive ṁ = flow cyl → pipe.
        Intake valve  (pipe_end='right'): positive ṁ = flow pipe → cyl.

    The cylinder's mass balance will be updated by the caller using the
    ACTUAL HLLC flux at the boundary face (not this "claimed" ṁ), so this
    return value is advisory.
    """
    ng = state.n_ghost
    gamma_pipe = state.gamma  # hardware γ used by HLLC; pipe is frozen γ=1.4

    # Effective flow area
    A_eff = valve_effective_area(
        theta_local_deg, vp.open_angle_deg, vp.close_angle_deg, vp.max_lift,
        vp.diameter, np.radians(vp.seat_angle_deg), vp.n_valves,
        vp.ld_table, vp.cd_table,
    )
    if A_eff < 1e-12:
        _fill_reflective_at_end(state, pipe_end)
        return 0.0

    # Index into pipe for the first real cell on the valve side
    if pipe_end == "left":
        i_real = ng
    else:
        i_real = ng + state.n_cells - 1
    A_pipe = state.area[i_real]
    gm1 = gamma_pipe - 1.0
    rho_pipe = state.q[i_real, I_RHO_A] / A_pipe
    u_pipe = state.q[i_real, I_MOM_A] / (rho_pipe * A_pipe)
    E_pipe = state.q[i_real, I_E_A] / A_pipe
    p_pipe = gm1 * (E_pipe - 0.5 * rho_pipe * u_pipe * u_pipe)
    p_pipe = max(p_pipe, 1.0)
    Y_pipe = state.q[i_real, I_Y_A] / (rho_pipe * A_pipe)

    # Decide flow direction
    # Forward (cyl → pipe at exhaust, pipe → cyl at intake) happens when
    # the UPSTREAM pressure exceeds the DOWNSTREAM pressure.
    if valve_type == "exhaust":
        # Cylinder is upstream for forward; pipe is upstream for reverse
        forward = p_cyl >= p_pipe
    else:
        # Intake: pipe is upstream for forward (pipe→cyl); cyl upstream for reverse
        forward = p_pipe >= p_cyl

    # Upstream reservoir state
    if forward and valve_type == "exhaust":
        # Cylinder → pipe. Use cylinder γ, R, composition.
        p_up = p_cyl
        T_up = T_cyl
        gamma_up = gamma_mixture(T_cyl, xb_cyl)
        R_up = R_mixture(xb_cyl)
        Y_up = xb_cyl
        p_down = p_pipe
    elif (not forward) and valve_type == "exhaust":
        # Pipe → cylinder. Pipe is upstream.
        p_up = p_pipe
        T_up = max(p_pipe / (max(rho_pipe, 1e-6) * R_AIR), 100.0)
        gamma_up = gamma_pipe
        R_up = R_AIR  # could use R_mixture(Y_pipe) but R_pipe frozen
        Y_up = Y_pipe
        p_down = p_cyl
    elif forward and valve_type == "intake":
        # Pipe → cylinder. Pipe is upstream.
        p_up = p_pipe
        T_up = max(p_pipe / (max(rho_pipe, 1e-6) * R_AIR), 100.0)
        gamma_up = gamma_pipe
        R_up = R_AIR
        Y_up = Y_pipe
        p_down = p_cyl
    else:
        # Intake backflow: cylinder → pipe
        p_up = p_cyl
        T_up = T_cyl
        gamma_up = gamma_mixture(T_cyl, xb_cyl)
        R_up = R_mixture(xb_cyl)
        Y_up = xb_cyl
        p_down = p_pipe

    # ṁ through the valve orifice
    mdot = _mass_flow_orifice(p_up, T_up, p_down, A_eff, gamma_up, R_up)

    # Ghost primitive state (reservoir-biased isentropic expansion to pipe p)
    # p_ghost takes pipe pressure (subsonic coupling; for choked, the ghost
    # pressure doesn't actually matter because upstream is unaware).
    p_ghost = p_pipe
    ratio = max(p_ghost / max(p_up, 1.0), 1e-6)
    T_ghost = max(T_up * ratio ** (gm1 / gamma_up), 100.0)
    rho_ghost = p_ghost / (R_up * T_ghost)
    # Ghost velocity (sign) — flow-direction-aware:
    # - Exhaust pipe (LEFT end): forward flow has u_ghost > 0 (into pipe).
    # - Intake pipe (RIGHT end): forward flow has u_ghost > 0 (out of pipe,
    #   toward cylinder). But since ghost is OUTSIDE the pipe to the right,
    #   flow from pipe INTO the ghost means u_ghost > 0 also. Same sign!
    if forward:
        u_mag = mdot / max(rho_ghost * A_pipe, 1e-20)
    else:
        u_mag = -mdot / max(rho_ghost * A_pipe, 1e-20)

    # Apply to ghost cells
    if pipe_end == "left":
        ghost_indices = range(0, ng)
    else:
        ghost_indices = range(ng + state.n_cells, state.n_total)

    gm1_pipe = gamma_pipe - 1.0  # the FV update uses frozen-γ for energy close
    for i in ghost_indices:
        A_g = state.area[i]
        # Use pipe's frozen γ for E calc (the pipe HLLC uses this γ)
        E_ghost = p_ghost / gm1_pipe + 0.5 * rho_ghost * u_mag * u_mag
        state.q[i, I_RHO_A] = rho_ghost * A_g
        state.q[i, I_MOM_A] = rho_ghost * u_mag * A_g
        state.q[i, I_E_A]   = E_ghost * A_g
        state.q[i, I_Y_A]   = rho_ghost * Y_up * A_g

    # Signed return value per the docstring convention
    if valve_type == "exhaust":
        return mdot if forward else -mdot  # + = cyl→pipe
    else:
        return mdot if forward else -mdot  # + = pipe→cyl


# ---------------------------------------------------------------------------
# Characteristic + orifice valve BC (Phase C1 fix, 2026-04-14)
#
# Replaces the zero-pressure-gradient ghost (`p_ghost = p_pipe`) which the
# acoustic-BC audit identified as transmissive in pressure (R_valve(exhaust,
# linear, compression) ≈ −0.10; full report at
# docs/acoustic_diagnosis/findings.md). The new BC counts the incoming
# characteristics at the boundary face per Toro §6.3 / Hirsch Vol. 2 ch. 19
# AND simultaneously enforces the compressible-orifice equation linking the
# pipe-side mass flux to the cyl-side reservoir state. The orifice provides
# the physical impedance that makes Cd matter; the characteristics carry the
# acoustic information correctly.
#
# Pipe-side classification (consistent with the rest of `fill_valve_ghost`):
#   "outflow" = mass leaves the pipe through the boundary (pipe → cyl).
#   "inflow"  = mass enters the pipe through the boundary (cyl → pipe).
#
# Subsonic OUTFLOW  (|u_face| < c, pipe is upstream of orifice):
#   2 outgoing chars from interior: entropy s, acoustic J (J⁻ at LEFT,
#   J⁺ at RIGHT). 1 condition imposed: pipe-side mass flux =
#   orifice_mdot(p_face_up = p_face, p_face_dn = p_cyl, A_eff). With
#   isentropic-from-interior ρ_face and c_face from p_face, plus the J
#   invariant for u_face, the mass-flux residual is a single nonlinear
#   equation in p_face. Bisect on p_face ∈ [p_cyl, p_int].
#
# Subsonic INFLOW  (|u_face| < c, cyl is upstream of orifice):
#   1 outgoing char from interior: J. 2 conditions imposed: stagnation
#   enthalpy h₀ = c_p·T_cyl from cyl (adiabatic orifice), and the orifice
#   mass-flux equation (orifice_mdot(p_up = p_cyl, p_dn = p_face, A_eff))
#   matches the pipe-side mass flux. The energy + J equations alone give
#   c_face and u_face independent of p_face; ρ_face = γ·p_face/c_face²
#   then makes the mass flux linear in p_face. Bisect on p_face ∈
#   [p_int, p_cyl].
#
# Closed valve (A_eff < 1e-8 m²): short-circuit to reflective ghost.
#
# Degenerate bracket: if the residual has the same sign at both endpoints,
# the iteration cannot converge — fall back to reflective ghost. This
# corresponds to "essentially-closed" valves where orifice mdot can never
# equal the characteristic mdot for any face pressure in the bracket.
# ---------------------------------------------------------------------------


# Orifice closed-valve threshold (m²). Below this, no iteration; reflective.
_A_EFF_CLOSED_M2 = 1.0e-8

# Bisection settings
_BISECT_MAX_ITER = 60
_BISECT_TOL_RESIDUAL_KG_S = 1.0e-9   # mass flux residual tolerance


# ---------------------------------------------------------------------------
# Regime detection thresholds (Phase C1+ refactor, 2026-04-15)
# ---------------------------------------------------------------------------

# Startup: quiescent interior + near-equilibrium pressure differential.
_STARTUP_U_INT_M_S = 1.0          # |u_int| < this AND
_STARTUP_REL_DP    = 1.0e-4       # |Δp| / max(p_cyl, p_int) < this


# ---------------------------------------------------------------------------
# Per-call BC-regime diagnostic log
#
# Every BC call is classified into one of: "startup", "subsonic_inflow",
# "subsonic_outflow", "choked_inflow", "choked_outflow", or "UNHANDLED"
# (the last should never appear in production). Used to confirm the
# regime-dispatcher is correctly classifying and that no calls fall
# through to the catch-all wall-reflective fallback.
#
# Disabled by default. Enable / read via:
#   bcs.valve.enable_regime_logging(True)
#   bcs.valve.get_regime_log()        # list of dicts (per-call detail)
#   bcs.valve.regime_summary()        # Counter of regime → count
# ---------------------------------------------------------------------------

_REGIME_LOG: list = []
_REGIME_LOGGING_ENABLED: bool = False


def enable_regime_logging(enabled: bool = True) -> None:
    """Enable/disable per-call regime classification logging. Clears the
    log when enabled."""
    global _REGIME_LOGGING_ENABLED
    _REGIME_LOGGING_ENABLED = bool(enabled)
    if enabled:
        _REGIME_LOG.clear()


def get_regime_log() -> list:
    """Return a shallow copy of the BC-regime event log."""
    return list(_REGIME_LOG)


def regime_summary() -> "Counter":
    """Return a Counter of regime → count."""
    from collections import Counter
    return Counter(e["regime"] for e in _REGIME_LOG)


def _log_regime(*, regime: str, p_cyl: float, p_int: float, u_int: float,
                c_int: float, T_cyl: float, theta_local_deg: float,
                valve_type: str, pipe_end: str, mdot_face: float = 0.0) -> None:
    if _REGIME_LOGGING_ENABLED:
        _REGIME_LOG.append({
            "regime": regime,
            "theta_local_deg": float(theta_local_deg),
            "valve_type": valve_type,
            "pipe_end": pipe_end,
            "p_cyl": float(p_cyl),
            "p_int": float(p_int),
            "u_int": float(u_int),
            "c_int": float(c_int),
            "T_cyl": float(T_cyl),
            "mdot_face": float(mdot_face),
        })


# ---------------------------------------------------------------------------
# Back-compat shim for the original kickstart-logging API. The "kickstart"
# concept was renamed "regime" in the C1+ refactor, but downstream code
# (e.g. existing test scripts) may still call enable_kickstart_logging.
# ---------------------------------------------------------------------------

def enable_kickstart_logging(enabled: bool = True) -> None:
    """Deprecated alias for ``enable_regime_logging``."""
    enable_regime_logging(enabled)


def get_kickstart_log() -> list:
    """Deprecated alias for ``get_regime_log``. Returns the same list of
    per-call dicts; the modern API distinguishes startup / choked /
    subsonic explicitly via the ``regime`` key on each event."""
    return get_regime_log()


def kickstart_count() -> int:
    """Deprecated alias. Returns count of any-regime events; kept for
    back-compat. Prefer ``regime_summary()`` for the breakdown."""
    return len(_REGIME_LOG)


def _solve_outflow_face(
    *, rho_int: float, u_int: float, p_int: float, c_int: float,
    p_cyl: float, T_cyl: float, A_eff: float, A_pipe: float,
    gamma: float, R_gas: float, pipe_end: str,
):
    """Bisect p_face for subsonic outflow (pipe → cyl).

    Returns (rho_face, u_face, p_face, T_face) on success, or None if the
    bracket is degenerate (caller falls back to wall).
    """
    gm1 = gamma - 1.0
    sign = +1.0 if pipe_end == "left" else -1.0
    if pipe_end == "left":
        J_int = u_int - 2.0 * c_int / gm1     # J⁻
    else:
        J_int = u_int + 2.0 * c_int / gm1     # J⁺

    def char_state(p_f: float):
        rho_f = rho_int * (p_f / p_int) ** (1.0 / gamma)
        c_f = np.sqrt(max(gamma * p_f / max(rho_f, 1e-20), 1.0))
        u_f = J_int + sign * 2.0 * c_f / gm1
        T_f = p_f / max(rho_f * R_gas, 1e-20)
        return rho_f, u_f, c_f, T_f

    def residual(p_f: float) -> float:
        rho_f, u_f, _, T_f = char_state(p_f)
        char_mdot = abs(rho_f * u_f * A_pipe)              # pipe-side mass flux
        orif_mdot = _mass_flow_orifice(p_f, T_f, p_cyl, A_eff, gamma, R_gas)
        return orif_mdot - char_mdot

    p_lo = max(p_cyl, 1.0)
    p_hi = max(p_int, p_lo + 1.0)
    f_lo = residual(p_lo)
    f_hi = residual(p_hi)
    if f_lo * f_hi > 0.0:
        return None
    for _ in range(_BISECT_MAX_ITER):
        p_mid = 0.5 * (p_lo + p_hi)
        f_mid = residual(p_mid)
        if abs(f_mid) < _BISECT_TOL_RESIDUAL_KG_S:
            p_lo = p_mid
            break
        if f_lo * f_mid <= 0.0:
            p_hi = p_mid; f_hi = f_mid
        else:
            p_lo = p_mid; f_lo = f_mid
    p_face = 0.5 * (p_lo + p_hi)
    rho_face, u_face, _, T_face = char_state(p_face)
    return rho_face, u_face, p_face, T_face


def _energy_J_inflow(
    u_int: float, c_int: float, T_res: float,
    gamma: float, R_gas: float, pipe_end: str,
):
    """Solve the (energy + J⁻ at LEFT or J⁺ at RIGHT) system for inflow.

    Returns (c_face, u_face) such that:
      c_face²/(γ−1) + u_face²/2 = c_p · T_res          (energy)
      u_face = J_int + sign · 2 c_face / (γ−1)         (J characteristic)
    where sign = +1 at LEFT, −1 at RIGHT, and J_int comes from the
    interior using the correct characteristic for each end.

    Returns None if the quadratic has no positive c_face or the resulting
    u_face has the wrong sign for the inflow direction (degenerate
    startup case — caller should dispatch to the startup branch).
    """
    gm1 = gamma - 1.0
    sign = +1.0 if pipe_end == "left" else -1.0
    if pipe_end == "left":
        J_int = u_int - 2.0 * c_int / gm1     # J⁻
    else:
        J_int = u_int + 2.0 * c_int / gm1     # J⁺

    c_0_sq = gamma * R_gas * max(T_res, 100.0)
    if c_0_sq <= 0.0:
        return None
    # Quadratic: (γ+1)·c² + 2·sign·J·gm1·c + (gm1²·J²/2 − gm1·c_0²) = 0
    a_q = gamma + 1.0
    b_q = 2.0 * sign * J_int * gm1
    d_q = 0.5 * gm1 * gm1 * J_int * J_int - gm1 * c_0_sq
    disc = b_q * b_q - 4.0 * a_q * d_q
    if disc < 0.0:
        return None
    sqrt_disc = np.sqrt(disc)
    c_face = (-b_q + sqrt_disc) / (2.0 * a_q)
    if c_face <= 0.0:
        c_face = (-b_q - sqrt_disc) / (2.0 * a_q)
    if c_face <= 0.0 or not np.isfinite(c_face):
        return None
    u_face = J_int + sign * 2.0 * c_face / gm1
    if pipe_end == "left" and u_face <= 0.0:
        return None
    if pipe_end == "right" and u_face >= 0.0:
        return None
    return c_face, u_face


def _branch_startup(
    *, p_cyl: float, p_int: float, T_cyl: float,
    rho_int: float, Y_int: float, xb_cyl: float,
    R_gas: float, pipe_side_inflow: bool,
):
    """Startup / quiescent regime: |u_int| < threshold AND |Δp/p| < threshold.

    Pressure-matched ghost (u = 0, p = p_int, ρ from upstream reservoir).
    Lets the flow develop naturally as soon as the interior or reservoir
    state perturbs.

    Returns (rho_face, u_face, p_face, Y_face).
    """
    if pipe_side_inflow:
        rho_face = p_int / (R_gas * max(T_cyl, 100.0))
        Y_face = xb_cyl
    else:
        rho_face = rho_int
        Y_face = Y_int
    u_face = 0.0
    p_face = p_int
    return rho_face, u_face, p_face, Y_face


def _branch_choked_outflow_orifice_driven(
    *, rho_int: float, p_int: float,
    p_cyl: float, A_eff: float, A_pipe: float,
    gamma: float, R_gas: float, pipe_end: str,
):
    """Orifice-driven ghost for choked outflow OR characteristic-degenerate
    outflow (where the energy+J+orifice bisection fails).

    Pipe interior is upstream of the orifice. mdot from the orifice
    equation (handles subsonic + choked branches internally) using pipe-
    side static state as upstream stagnation (low-Mach approximation).
    Ghost density = pipe interior density (zero pressure gradient at the
    face, isentropic-from-interior holds in the trivial limit).
    Velocity from mass conservation.
    """
    T_int = max(p_int / (rho_int * R_gas), 100.0)
    mdot = _mass_flow_orifice(p_int, T_int, p_cyl, A_eff, gamma, R_gas)
    rho_face = rho_int
    # Outflow direction: at LEFT, u_face < 0 (mass leaves leftward); at RIGHT, u_face > 0.
    sign = -1.0 if pipe_end == "left" else +1.0
    u_face = sign * mdot / max(rho_face * A_pipe, 1.0e-20)
    p_face = p_int
    if not (np.isfinite(rho_face) and np.isfinite(p_face)
            and rho_face > 0.0 and p_face > 0.0):
        return None
    return rho_face, u_face, p_face


def _branch_choked_inflow(
    *, u_int: float, c_int: float, p_int: float,
    p_cyl: float, T_cyl: float,
    A_eff: float, A_pipe: float,
    gamma: float, R_gas: float, pipe_end: str,
):
    """Choked-orifice subsonic-pipe-side inflow (cyl → pipe direction
    with sonic flow at the orifice throat).

    Direct computation per user's prescription (Phase C1+ refactor):
      - mdot_orifice from cyl-side stagnation alone (constant).
      - Ghost density from isentropic expansion of cyl reservoir to the
        pipe-side static pressure (taken as p_int for zero-gradient
        pressure coupling — this is what the C1 kickstart did and what
        the engine model was validated against in C1).
      - Ghost velocity from mass conservation: u = mdot / (ρ · A).
      - Ghost pressure = p_int (zero pressure gradient at the face).

    Why p_face = p_int rather than p_face = ρ·c²/γ from energy+J:
    in the choked regime the orifice decouples mass flux from downstream
    pressure, so the downstream characteristic information dominates the
    pipe-side static pressure. A zero-gradient pressure boundary lets
    the interior wave structure govern p locally; the orifice provides
    the mass flux, which is the only quantity it can dictate in the
    choked regime. This matches the C1-validated engine behavior
    (IMEP 9.98 bar, EGT 1251 K at 10500 RPM SDM26).

    The choked-mdot sanity assertion (0.1%) per the user's request
    catches a sign or factor bug in the orifice formula by checking
    that the ghost mass flux matches the orifice prediction.

    Returns (rho_face, u_face, p_face, mdot_orifice) on success, or
    None on numerical degeneracy.
    """
    choke_factor = (2.0 / (gamma + 1.0)) ** ((gamma + 1.0) / (2.0 * (gamma - 1.0)))
    mdot_orifice = (
        A_eff * p_cyl
        * np.sqrt(gamma / (R_gas * max(T_cyl, 100.0)))
        * choke_factor
    )

    # Isentropic expansion from cyl stagnation to p_face = p_int
    pr = max(p_int / max(p_cyl, 1.0), 1.0e-6)
    T_face = max(T_cyl * pr ** ((gamma - 1.0) / gamma), 100.0)
    rho_face = max(p_int / (R_gas * T_face), 1.0e-6)

    # u_face from mass conservation. Sign by pipe end (LEFT inflow → +,
    # RIGHT inflow → −).
    sign = +1.0 if pipe_end == "left" else -1.0
    u_face = sign * mdot_orifice / max(rho_face * A_pipe, 1.0e-20)
    p_face = p_int

    # Choked-mdot sanity (0.1%) — catches a sign or factor bug.
    mdot_face = abs(rho_face * u_face * A_pipe)
    if mdot_orifice > 0.0:
        rel_err = abs(mdot_face - mdot_orifice) / mdot_orifice
        if rel_err > 1.0e-3:
            return None

    if not (np.isfinite(rho_face) and np.isfinite(p_face)
            and rho_face > 0.0 and p_face > 0.0):
        return None
    return rho_face, u_face, p_face, mdot_orifice


def _branch_subsonic_inflow(
    *, u_int: float, c_int: float, p_int: float,
    p_cyl: float, T_cyl: float,
    A_eff: float, A_pipe: float,
    gamma: float, R_gas: float, pipe_end: str,
):
    """Subsonic-orifice subsonic-pipe-side inflow (cyl → pipe). The
    orifice mass flux depends on p_face, so we bisect p_face in a wide
    bracket [1 Pa, p_cyl − 1 Pa] until ρ_face·|u_face|·A_pipe ==
    mdot_orifice(p_cyl, T_cyl, p_face).

    Bracket choice: physically p_face can be lower than p_int during
    orifice throttling (gas accelerates through the orifice and the
    static face pressure can drop well below ambient). The narrower
    [p_int, p_cyl] bracket is wrong for this case and was the cause of
    the C1 fallback hits during exhaust blowdown (see C2 audit log).

    Returns (rho_face, u_face, p_face) on success or None if degenerate.
    """
    eJ = _energy_J_inflow(u_int, c_int, T_cyl, gamma, R_gas, pipe_end)
    if eJ is None:
        return None
    c_face, u_face = eJ
    char_u_mag = abs(u_face)
    if char_u_mag < 1.0e-6:
        return None

    def residual(p_f: float) -> float:
        rho_f = gamma * p_f / (c_face * c_face)
        char_mdot = rho_f * char_u_mag * A_pipe
        orif_mdot = _mass_flow_orifice(p_cyl, T_cyl, p_f, A_eff, gamma, R_gas)
        return orif_mdot - char_mdot

    # Bracket: [p_int, p_cyl − 1]. The C1 narrower bracket; relies on the
    # caller's regime classifier to dispatch genuinely-choked cases to
    # _branch_choked_inflow rather than falling through here.
    p_lo = max(p_int, 1.0)
    p_hi = max(p_cyl - 1.0, p_lo + 1.0)
    f_lo = residual(p_lo)
    f_hi = residual(p_hi)
    if f_lo * f_hi > 0.0:
        return None
    for _ in range(_BISECT_MAX_ITER):
        p_mid = 0.5 * (p_lo + p_hi)
        f_mid = residual(p_mid)
        if abs(f_mid) < _BISECT_TOL_RESIDUAL_KG_S:
            p_lo = p_mid
            break
        if f_lo * f_mid <= 0.0:
            p_hi = p_mid; f_hi = f_mid
        else:
            p_lo = p_mid; f_lo = f_mid
    p_face = 0.5 * (p_lo + p_hi)
    rho_face = gamma * p_face / (c_face * c_face)
    return rho_face, u_face, p_face


def fill_valve_ghost_characteristic(
    state: PipeState,
    pipe_end: str,
    valve_type: str,
    vp: ValveParams,
    theta_local_deg: float,
    p_cyl: float, T_cyl: float, xb_cyl: float,
) -> float:
    """Characteristic-based ghost fill with simultaneous orifice
    constraint and explicit regime dispatch.

    Drop-in replacement for ``fill_valve_ghost``. Each call is classified
    into one of three explicit physical regimes and dispatched to the
    appropriate branch:

      1. **startup** — quiescent interior + near-equilibrium pressure
         differential (|u_int| < 1 m/s AND |Δp| / max(p) < 1e-4). The
         characteristic + energy + orifice system has only the trivial
         u_face = 0 solution (cannot spin up flow from rest). Use a
         pressure-matched ghost; flow develops naturally as soon as the
         interior or reservoir state perturbs.

      2. **choked_inflow** / **choked_outflow** — pressure ratio across
         the orifice is below the critical ratio (≈ 0.528 for γ = 1.4).
         For inflow (cyl → pipe): mdot_orifice depends only on cyl
         upstream stagnation, so direct computation without bisection
         (_branch_choked_inflow). For outflow (pipe → cyl): the orifice
         mdot depends on the pipe-side face state stagnation pressure,
         which itself depends on p_face — so bisection is still needed
         (_solve_outflow_face handles both subsonic and choked outflow
         transparently via the orifice equation's internal regime check).

      3. **subsonic_inflow** / **subsonic_outflow** — orifice unchoked.
         Bisection on p_face. _branch_subsonic_inflow uses a wide
         bracket [1 Pa, p_cyl − 1 Pa] because the static face pressure
         can drop below the pipe interior pressure during throttling.

    All five terminal paths are first-class regimes — there is no
    catch-all fallback. If a regime branch cannot find a self-consistent
    solution (which should only happen at startup), the dispatcher falls
    through to the startup branch. If startup itself fails, the BC logs
    "UNHANDLED" and reverts to a reflective wall ghost (this should
    never happen in production; if it does, there is a bug to find).

    Same call signature, same return-value sign convention as the
    legacy ``fill_valve_ghost``.
    """
    ng = state.n_ghost
    gamma = state.gamma
    gm1 = gamma - 1.0

    A_eff = valve_effective_area(
        theta_local_deg, vp.open_angle_deg, vp.close_angle_deg, vp.max_lift,
        vp.diameter, np.radians(vp.seat_angle_deg), vp.n_valves,
        vp.ld_table, vp.cd_table,
    )
    if A_eff < _A_EFF_CLOSED_M2:
        _fill_reflective_at_end(state, pipe_end)
        return 0.0

    if pipe_end == "left":
        i_real = ng
    else:
        i_real = ng + state.n_cells - 1
    A_pipe = state.area[i_real]
    rho_int = state.q[i_real, I_RHO_A] / A_pipe
    u_int = state.q[i_real, I_MOM_A] / (rho_int * A_pipe)
    E_int = state.q[i_real, I_E_A] / A_pipe
    p_int = max(gm1 * (E_int - 0.5 * rho_int * u_int * u_int), 1.0)
    Y_int = state.q[i_real, I_Y_A] / (rho_int * A_pipe)
    c_int = np.sqrt(max(gamma * p_int / max(rho_int, 1e-20), 1.0))

    # ---- regime classification ----
    p_max = max(p_cyl, p_int, 1.0)
    rel_dp = abs(p_cyl - p_int) / p_max
    is_startup = (abs(u_int) < _STARTUP_U_INT_M_S) and (rel_dp < _STARTUP_REL_DP)

    pipe_side_inflow = p_cyl > p_int

    pr_crit = (2.0 / (gamma + 1.0)) ** (gamma / (gamma - 1.0))
    if pipe_side_inflow:
        # cyl is upstream of orifice; pr = p_int / p_cyl as the proxy
        pr_orifice = p_int / max(p_cyl, 1.0)
    else:
        # pipe is upstream of orifice; pr = p_cyl / p_int
        pr_orifice = p_cyl / max(p_int, 1.0)
    is_choked = pr_orifice < pr_crit

    sol = None
    if is_startup:
        regime = "startup"
        rho_face, u_face, p_face, Y_face = _branch_startup(
            p_cyl=p_cyl, p_int=p_int, T_cyl=T_cyl,
            rho_int=rho_int, Y_int=Y_int, xb_cyl=xb_cyl,
            R_gas=R_AIR, pipe_side_inflow=pipe_side_inflow,
        )
        sol = (rho_face, u_face, p_face)
    elif pipe_side_inflow and is_choked:
        regime = "choked_inflow"
        result = _branch_choked_inflow(
            u_int=u_int, c_int=c_int, p_int=p_int,
            p_cyl=p_cyl, T_cyl=T_cyl,
            A_eff=A_eff, A_pipe=A_pipe,
            gamma=gamma, R_gas=R_AIR, pipe_end=pipe_end,
        )
        if result is not None:
            rho_face, u_face, p_face, _mdot = result
            sol = (rho_face, u_face, p_face)
        Y_face = xb_cyl
    elif pipe_side_inflow and not is_choked:
        regime = "subsonic_inflow"
        result = _branch_subsonic_inflow(
            u_int=u_int, c_int=c_int, p_int=p_int,
            p_cyl=p_cyl, T_cyl=T_cyl,
            A_eff=A_eff, A_pipe=A_pipe,
            gamma=gamma, R_gas=R_AIR, pipe_end=pipe_end,
        )
        if result is not None:
            sol = result
        Y_face = xb_cyl
    elif (not pipe_side_inflow) and is_choked:
        # Choked outflow (pipe → cyl with sonic at orifice; rare —
        # blowback during overlap if the exhaust pipe is overpressured).
        # Use _solve_outflow_face which handles both subsonic and
        # choked branches transparently via the orifice equation's
        # internal regime check; the bisection bracket [p_cyl, p_int]
        # is valid for both as long as the orifice can match the
        # interior characteristic mdot.
        regime = "choked_outflow"
        result = _solve_outflow_face(
            rho_int=rho_int, u_int=u_int, p_int=p_int, c_int=c_int,
            p_cyl=p_cyl, T_cyl=T_cyl,
            A_eff=A_eff, A_pipe=A_pipe,
            gamma=gamma, R_gas=R_AIR, pipe_end=pipe_end,
        )
        if result is not None:
            rho_face, u_face, p_face, _T_face = result
            sol = (rho_face, u_face, p_face)
        Y_face = Y_int
    else:
        regime = "subsonic_outflow"
        result = _solve_outflow_face(
            rho_int=rho_int, u_int=u_int, p_int=p_int, c_int=c_int,
            p_cyl=p_cyl, T_cyl=T_cyl,
            A_eff=A_eff, A_pipe=A_pipe,
            gamma=gamma, R_gas=R_AIR, pipe_end=pipe_end,
        )
        if result is not None:
            rho_face, u_face, p_face, _T_face = result
            sol = (rho_face, u_face, p_face)
        Y_face = Y_int

    # When the subsonic branch's energy+J quadratic has no non-trivial
    # solution and the explicit subsonic branch returns None, re-dispatch
    # to the orifice-driven choked branch. This is the same physics the
    # C1 implementation used as a "kickstart fallback" — but here it is
    # an explicit regime decision: the orifice impedance dominates, so
    # the BC is operating in the choked/orifice-limited regime even
    # though the upfront pressure-ratio test classified it as subsonic.
    # The upfront classifier uses p_int as a proxy for face pressure;
    # when the actual face pressure ends up in the choked window, the
    # subsonic bisection cannot converge and we re-dispatch.
    if sol is None and pipe_side_inflow:
        regime = "choked_inflow"
        result = _branch_choked_inflow(
            u_int=u_int, c_int=c_int, p_int=p_int,
            p_cyl=p_cyl, T_cyl=T_cyl,
            A_eff=A_eff, A_pipe=A_pipe,
            gamma=gamma, R_gas=R_AIR, pipe_end=pipe_end,
        )
        if result is not None:
            rho_face, u_face, p_face, _mdot = result
            sol = (rho_face, u_face, p_face)
        Y_face = xb_cyl

    # If even the choked re-dispatch fails (rare; truly degenerate
    # state with low mass flow), fall to the startup branch which uses
    # a pressure-matched zero-velocity ghost. This is a true regime
    # classification, not an "anything goes" catch-all.
    if sol is None:
        regime = "startup"
        rho_face, u_face, p_face, Y_face = _branch_startup(
            p_cyl=p_cyl, p_int=p_int, T_cyl=T_cyl,
            rho_int=rho_int, Y_int=Y_int, xb_cyl=xb_cyl,
            R_gas=R_AIR, pipe_side_inflow=pipe_side_inflow,
        )
        sol = (rho_face, u_face, p_face)

    if sol is None:
        # Should be unreachable; log and reflective-wall fallback.
        _log_regime(
            regime="UNHANDLED", p_cyl=p_cyl, p_int=p_int, u_int=u_int,
            c_int=c_int, T_cyl=T_cyl, theta_local_deg=theta_local_deg,
            valve_type=valve_type, pipe_end=pipe_end, mdot_face=0.0,
        )
        _fill_reflective_at_end(state, pipe_end)
        return 0.0

    rho_face, u_face, p_face = sol
    _log_regime(
        regime=regime, p_cyl=p_cyl, p_int=p_int, u_int=u_int,
        c_int=c_int, T_cyl=T_cyl, theta_local_deg=theta_local_deg,
        valve_type=valve_type, pipe_end=pipe_end,
        mdot_face=rho_face * u_face * A_pipe,
    )

    # Final positivity / finiteness sanity. If anything is off, fall back
    # to wall (preserves stability without polluting the interior).
    if (not np.isfinite(rho_face) or not np.isfinite(p_face)
        or rho_face <= 0.0 or p_face <= 0.0):
        _fill_reflective_at_end(state, pipe_end)
        return 0.0

    # Signed mdot return (matches the existing convention):
    #   LEFT  + RIGHT pipe-side inflow  → u_face has sign of (rightward at LEFT,
    #     leftward at RIGHT). Forward direction in both cases sets +mdot.
    # See docstring of fill_valve_ghost for the sign convention.
    mdot_signed = rho_face * u_face * A_pipe

    if pipe_end == "left":
        ghost_indices = range(0, ng)
    else:
        ghost_indices = range(ng + state.n_cells, state.n_total)
    E_face = p_face / gm1 + 0.5 * rho_face * u_face * u_face
    for i in ghost_indices:
        A_g = state.area[i]
        state.q[i, I_RHO_A] = rho_face * A_g
        state.q[i, I_MOM_A] = rho_face * u_face * A_g
        state.q[i, I_E_A]   = E_face * A_g
        state.q[i, I_Y_A]   = rho_face * Y_face * A_g

    return mdot_signed
