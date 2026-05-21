"""Characteristic-coupled constant-static-pressure junction BC.

Parallel alternative to ``bcs/junction_cv.py:JunctionCV``. Preserves
more of the incident wave amplitude across a multi-pipe merge than the
stagnation-CV formulation does, at the cost of approximate (not exact)
energy conservation across area-mismatched junctions.

**Two junction types are available in the codebase; choose deliberately.**

- ``bcs.junction_cv.JunctionCV`` — stagnation control volume. Strictly
  conservative in mass + energy + ρY. Dissipative at the face: per-
  junction acoustic transmission ~0.69 for the SDM26 4-2-1 geometry.
  **Default**; use when conservation matters more than wave propagation.

- ``bcs.junction_characteristic.CharacteristicJunction`` (this file) —
  constant static pressure across all legs, characteristic compatibility
  from each interior, mass-conservative by Newton residual, energy-
  conservative to O(ΔA/A̅) at mismatched junctions. Per-junction
  transmission ~0.91 for SDM26 linear acoustics. Use when tuned-length
  effects need to propagate (e.g. engine torque tuning).

History
-------
The Phase-3 WIP draft at ``bcs/junction.py`` implemented a similar
formulation but was never wired in or tested. Phase E (acoustic audit
2026-04, Phase C1/C2/C3 follow-up) promoted it to production by
fixing the following specific issues:

1. Inflow legs now use junction-mixed entropy (not interior entropy)
2. Three-regime choked-leg dispatch (startup / subsonic / choked)
3. Analytic Jacobian in Newton iteration (replaces finite-difference)
4. Explicit convergence error raise on max_iter hit (no silent stall)
5. Signed energy residual diagnostic (+ = gain, physical violation)
6. Numba ready (kernel separated from the dataclass state object)
7. Full 8-test unit suite at tests/test_junction_characteristic.py
8. Module docstring citing the draft as predecessor

Leave ``bcs/junction.py`` in place as historical reference.

References
----------
Winterbone & Pearson, "Design Techniques for Engine Manifolds," 1999.
  Constant-static-pressure Type-1 multi-pipe junction, §9 (sections
  not verified against the book — book not on disk at implementation
  time, see docs/phase_e_design.md §1).
Corberán & Gascón, IJTS 1995. Conservation properties of multi-pipe
  junction models.
Toro, "Riemann Solvers and Numerical Methods for Fluid Dynamics,"
  2009. §3 for Riemann invariants along characteristics; §6 for BCs.
LeVeque, "Finite Volume Methods for Hyperbolic Problems," 2002.
  Framework for conservative coupling between FV domains.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Tuple

import numpy as np

from solver.state import PipeState, I_RHO_A, I_MOM_A, I_E_A, I_Y_A
from solver.hllc import hllc_flux


def _minmod(a: float, b: float) -> float:
    """Minmod limiter (same convention as solver/muscl.py:_minmod)."""
    if a * b <= 0.0:
        return 0.0
    return a if abs(a) < abs(b) else b


LEFT = "left"
RIGHT = "right"


class JunctionConvergenceError(RuntimeError):
    """Raised when Newton iteration does not converge in max_iter steps."""


class JunctionAllChokedError(RuntimeError):
    """Raised when every incident leg is simultaneously choked at the
    junction face — a physical contradiction (no degrees of freedom
    left to balance mass). Indicates an upstream pathology, not a
    solver failure."""


@dataclass
class JunctionLeg:
    """One pipe connected to the junction at a specific end.

    sign convention: if positive velocity at the pipe's junction face
    means flow *into* the junction, ``sign_into = +1``. RIGHT-end legs
    default to +1 (u>0 at pipe right-end goes out of pipe into
    junction), LEFT-end legs default to −1.
    """
    state: PipeState
    end: str                  # "left" or "right"
    sign_into: int = 0

    def __post_init__(self) -> None:
        if self.sign_into == 0:
            self.sign_into = +1 if self.end == RIGHT else -1

    @property
    def face_cell_index(self) -> int:
        """Index of the first real cell adjacent to the junction face."""
        ng = self.state.n_ghost
        return ng if self.end == LEFT else ng + self.state.n_cells - 1

    @property
    def s_end(self) -> float:
        """+1 at RIGHT end (outgoing invariant is J+); −1 at LEFT end."""
        return +1.0 if self.end == RIGHT else -1.0


# ---------------------------------------------------------------------------
# Leg kinematics: interior state, face state given p_j, and per-leg mass flux
# ---------------------------------------------------------------------------

def _primitives_at(state: PipeState, cell_i: int) -> Tuple[float, float, float, float]:
    """Read (ρ, u, p, ρY) at a single cell index. ρY form (not Y) matches
    MUSCL's internal convention where the 4th reconstructed channel is
    ρY, not the mass-fraction Y."""
    gm1 = state.gamma - 1.0
    A = state.area[cell_i]
    rho = state.q[cell_i, I_RHO_A] / A
    u = state.q[cell_i, I_MOM_A] / (rho * A)
    E = state.q[cell_i, I_E_A] / A
    p = max(gm1 * (E - 0.5 * rho * u * u), 1.0)
    rhoY = state.q[cell_i, I_Y_A] / A
    return rho, u, p, rhoY


def _interior_primitives(leg: JunctionLeg) -> Tuple[
    float, float, float, float, float, float, float,
    float, float, float, float,
]:
    """Read primitives at the first real cell adjacent to the junction
    face, AND at the next-interior cell (needed for MUSCL slope
    reconstruction). Returns:

        (rho_i, u_i, p_i, Y_i, c_i, A_i, gamma,
         rho_in, u_in, p_in, rhoY_in)

    where subscript ``_i`` = junction-adjacent real cell and ``_in`` =
    one cell deeper into the pipe interior. Per-leg γ is included so
    the HLLC residual uses the same γ that the pipe boundary HLLC
    call will use.
    """
    state = leg.state
    gamma = state.gamma
    gm1 = gamma - 1.0
    i = leg.face_cell_index

    A = state.area[i]
    rho_i, u_i, p_i, rhoY_i = _primitives_at(state, i)
    Y_i = rhoY_i / max(rho_i, 1e-20)
    c_i = float(np.sqrt(gamma * p_i / max(rho_i, 1e-9)))

    # Next-interior cell: at RIGHT end, that's i-1; at LEFT end, i+1.
    i_in = i - 1 if leg.end == RIGHT else i + 1
    rho_in, u_in, p_in, rhoY_in = _primitives_at(state, i_in)
    return (
        rho_i, u_i, p_i, Y_i, c_i, A, gamma,
        rho_in, u_in, p_in, rhoY_in,
    )


def _muscl_face_reconstruction(
    rho_i: float, u_i: float, p_i: float, rhoY_i: float,
    rho_in: float, u_in: float, p_in: float, rhoY_in: float,
    rho_g: float, u_g: float, p_g: float, rhoY_g: float,
    gamma: float, dx: float, dt: float,
    end: str,
):
    """Reproduce MUSCL-Hancock's face reconstruction on the interior
    side of the junction face. The ghost side is unchanged (ghost
    cells with uniform fill have zero slope and thus zero predictor
    shift, so the ghost-side face value equals the raw ghost state).

    Slope at the interior cell: minmod of backward and forward
    primitive differences (NOT divided by dx — matching MUSCL's
    internal convention where the "slope" is stored as a per-cell
    difference and the 1/dx factor is applied in the predictor).

    Predictor: evolve primitives by dt/2 using the primitive Euler
    PDE (see solver/muscl.py step 3).

    Face extrapolation: +0.5 · slope for RIGHT end (face is to the
    right of the interior cell), −0.5 · slope for LEFT end.

    Returns (rho_face, u_face, p_face, Y_face) — primitive state at
    the face from the interior side, as MUSCL will compute it.
    """
    # Slope via minmod on raw differences.
    if end == RIGHT:
        # interior_inner is to the left, ghost is to the right
        a_rho   = rho_i  - rho_in
        a_u     = u_i    - u_in
        a_p     = p_i    - p_in
        a_rhoY  = rhoY_i - rhoY_in
        b_rho   = rho_g  - rho_i
        b_u     = u_g    - u_i
        b_p     = p_g    - p_i
        b_rhoY  = rhoY_g - rhoY_i
        sign_half = +0.5
    else:
        # ghost is to the left, interior_inner is to the right
        a_rho   = rho_i  - rho_g
        a_u     = u_i    - u_g
        a_p     = p_i    - p_g
        a_rhoY  = rhoY_i - rhoY_g
        b_rho   = rho_in - rho_i
        b_u     = u_in   - u_i
        b_p     = p_in   - p_i
        b_rhoY  = rhoY_in - rhoY_i
        sign_half = -0.5

    srho  = _minmod(a_rho,  b_rho)
    su    = _minmod(a_u,    b_u)
    sp    = _minmod(a_p,    b_p)
    srhoY = _minmod(a_rhoY, b_rhoY)

    # Predictor: dt/2 time evolution (primitive form, matches
    # solver/muscl.py step 3 verbatim).
    half_dt_dx = 0.5 * dt / dx
    drho  = -half_dt_dx * (u_i * srho + rho_i * su)
    du    = -half_dt_dx * (u_i * su + sp / rho_i)
    dp    = -half_dt_dx * (u_i * sp + gamma * p_i * su)
    drhoY = -half_dt_dx * (u_i * srhoY + rhoY_i * su)

    rho_f  = rho_i  + drho  + sign_half * srho
    u_f    = u_i    + du    + sign_half * su
    p_f    = p_i    + dp    + sign_half * sp
    rhoY_f = rhoY_i + drhoY + sign_half * srhoY

    # Positivity fallback (same policy as MUSCL)
    if rho_f <= 0.0 or p_f <= 0.0:
        rho_f = rho_i
        u_f   = u_i
        p_f   = p_i
        rhoY_f = rhoY_i

    Y_f = rhoY_f / max(rho_f, 1e-20)
    return rho_f, u_f, p_f, Y_f


def _face_from_pj(
    rho_ref: float, u_ref: float, p_ref: float, c_ref: float,
    p_j: float, gamma: float, s_end: float,
) -> Tuple[float, float, float, float, float]:
    """Isentropic expansion from reference interior state to junction p_j,
    with the outgoing characteristic (J+ at s_end=+1, J− at s_end=−1) held
    invariant between interior and face.

    Returns (ρ_f, u_f, c_f, dρf_dpj, duf_dpj) — last two are the analytic
    derivatives needed for Newton on mass residual.

    Derivation of derivatives:
        Let r = p_j / p_ref, so dr/dp_j = 1/p_ref.
        c_f    = c_ref · r^((γ−1)/(2γ))
        ρ_f    = ρ_ref · r^(1/γ)
        u_f    = u_ref + (2/(γ−1)) · (c_ref − c_f) · s_end
        dc_f / dp_j = c_f · ((γ−1)/(2γ)) · (1/p_j)                 [chain rule]
        dρ_f / dp_j = ρ_f · (1/γ) · (1/p_j)
        du_f / dp_j = −(2/(γ−1)) · s_end · dc_f/dp_j
    """
    gm1 = gamma - 1.0
    r = max(p_j / p_ref, 1e-9)
    c_f = c_ref * r ** (gm1 / (2.0 * gamma))
    rho_f = rho_ref * r ** (1.0 / gamma)
    u_f = u_ref + (2.0 / gm1) * (c_ref - c_f) * s_end
    # analytic derivatives in p_j
    dcf_dpj = c_f * (gm1 / (2.0 * gamma)) / max(p_j, 1.0)
    drhof_dpj = rho_f * (1.0 / gamma) / max(p_j, 1.0)
    duf_dpj = -(2.0 / gm1) * s_end * dcf_dpj
    return rho_f, u_f, c_f, drhof_dpj, duf_dpj


def _hllc_mass_residual(
    legs: List[JunctionLeg],
    interiors: List[Tuple[float, float, float, float, float, float, float,
                          float, float, float, float]],
    p_j: float,
    references: List[Tuple[float, float, float, float]],
    dt: float,
) -> Tuple[float, List[Tuple[float, float, float, float]]]:
    """HLLC-consistent mass residual, reproducing MUSCL-Hancock's
    face reconstruction on the interior side so that the flux the
    Newton balances matches *exactly* the flux the MUSCL step will
    deliver at the boundary face.

    This is the machine-precision-conservation fix: without the
    MUSCL-aware reconstruction the residual is HLLC(raw interior,
    ghost), but MUSCL actually evaluates HLLC(predicted+half-slope
    interior, ghost). The mismatch is O(Δx) per step per leg and
    accumulates as the conservation drift identified in the Phase-E
    amplitude scan.

    ``references`` supplies (ρ_ref, u_ref, p_ref, c_ref) for the
    characteristic expansion, per leg. Usually equals the interior
    state; for inflow legs with the Picard correction this is the
    junction-mixed reservoir state.

    Ghost cells are filled with the uniform face state (cell[0] =
    cell[1] = face state), so the ghost-side slope is zero, predictor
    is a no-op, and the ghost-side face value used in HLLC is simply
    the face state (no reconstruction required).

    Returns (R, face_states) where face_states[i] =
    (ρ_ghost, u_ghost, p_ghost, F_mass_leg_i). ``ρ_ghost etc.`` are
    the values written into the ghost cells; the interior-side MUSCL
    reconstruction is used internally for HLLC but not returned.
    """
    R = 0.0
    face_states: List[Tuple[float, float, float, float]] = []
    for leg, interior, ref in zip(legs, interiors, references):
        (rho_i, u_i, p_i, Y_i, c_i, A_i, gamma_leg,
         rho_in, u_in, p_in, rhoY_in) = interior
        rho_ref, u_ref, p_ref, c_ref = ref
        # Characteristic face state (goes into ghost cells)
        rho_g, u_g, c_g, _, _ = _face_from_pj(
            rho_ref, u_ref, p_ref, c_ref, p_j, gamma_leg, leg.s_end,
        )
        p_g = rho_g * c_g * c_g / gamma_leg
        Y_g = Y_i   # will be overwritten by mixed-Y for inflow legs later
        rhoY_g = rho_g * Y_g

        # Interior-side MUSCL reconstruction: match what the pipe
        # will do when its MUSCL step runs.
        rhoY_i = rho_i * Y_i
        rho_fI, u_fI, p_fI, Y_fI = _muscl_face_reconstruction(
            rho_i, u_i, p_i, rhoY_i,
            rho_in, u_in, p_in, rhoY_in,
            rho_g, u_g, p_g, rhoY_g,
            gamma_leg, leg.state.dx, dt, leg.end,
        )

        # Ghost-side face value = ghost cell state (slope 0, predictor no-op)
        rho_fG, u_fG, p_fG, Y_fG = rho_g, u_g, p_g, Y_g

        # HLLC flux at the boundary face.
        if leg.end == RIGHT:
            # Interior is LEFT of face, ghost is RIGHT
            F = hllc_flux(rho_fI, u_fI, p_fI, Y_fI,
                          rho_fG, u_fG, p_fG, Y_fG,
                          gamma_leg)
        else:
            # Ghost is LEFT of face, interior is RIGHT
            F = hllc_flux(rho_fG, u_fG, p_fG, Y_fG,
                          rho_fI, u_fI, p_fI, Y_fI,
                          gamma_leg)
        F_mass = F[0]
        R += leg.sign_into * F_mass * A_i
        face_states.append((rho_g, u_g, p_g, F_mass))
    return R, face_states


# ---------------------------------------------------------------------------
# CharacteristicJunction class
# ---------------------------------------------------------------------------

@dataclass
class CharacteristicJunction:
    """Constant-static-pressure characteristic-coupled N-pipe junction.

    Lifecycle (matches JunctionCV for swap-in compatibility):
      1. fill_ghosts()     — called BEFORE each pipe's MUSCL step.
      2. absorb_fluxes(dt) — called AFTER each pipe's MUSCL step.
                            **No-op here**: mass and energy flow through
                            the ghost-mediated face flux directly; there
                            is no separate CV state to update. Kept for
                            interface symmetry.

    Robustness:
      - Newton on scalar p_j with analytic Jacobian.
      - 20% step damping (standard Winterbone recommendation for
        area-mismatched junctions; prevents overshoot on the first step
        when the initial guess is far from the fixed point).
      - Floor p_j at 1000 Pa to catch cavitation-style runaway.
      - If any leg goes sonic (|M_f| > 1 − choke_margin) at the
        converged p_j, re-dispatch to the choked branch (§4 of design).
      - If non-convergence in ``newton_max_iter`` steps, raise
        JunctionConvergenceError (no silent fallback).
    """

    legs: List[JunctionLeg]
    gamma: float = 1.4
    R_gas: float = 287.0
    newton_tol: float = 1e-13       # absolute mass-residual tolerance [kg/s]
    newton_max_iter: int = 30
    choke_margin: float = 0.02      # |M| < 1 − margin counts as subsonic

    # Internal-only: inflow-entropy Picard correction. On by default.
    # NOT in the constructor signature to prevent it being used as a
    # result-tuning lever (the junction is more correct with it on,
    # and the small transmission cost is the price of correctness).
    _inflow_entropy_picard: bool = field(default=True, repr=False)

    # Audit 2026-05-19 Fix 13: Borda-Carnot loss coefficient on incoming legs.
    # Applies Δp = ξ · ½ · ρ_f · u_f² to the ghost cell pressure of any leg
    # receiving mass from the junction (junction → pipe direction). Models
    # the energy dissipation at sudden area expansion (plenum mouth).
    #
    # Result of audit testing on SDM25 (loss values 0.05, 0.15, 0.30):
    # damping the wave reduces the constructive resonance at 11000 RPM
    # peak more than it helps the destructive resonance at 11500 RPM cliff.
    # Wave physics is symmetric — you cannot damp the bad wave without
    # damping the good one. Default kept at 0.0 (off). Parameter retained
    # for future experimentation; do not use without dual-engine validation.
    inflow_loss_coef: float = 0.0

    # diagnostics (written each fill_ghosts call)
    last_p_junction: float = 101325.0
    last_mass_residual: float = 0.0
    last_energy_residual: float = 0.0
    last_niter: int = 0
    last_regime: str = "subsonic"
    last_y_mixed: float = 0.0

    # --- lifecycle ------------------------------------------------------

    def fill_ghosts(self, dt: float) -> None:
        """Solve Newton on junction pressure and write ghost cells.

        ``dt`` is the time step about to be taken by the MUSCL-Hancock
        step for the adjacent pipes. It is required because the
        characteristic-junction Newton residual uses MUSCL-Hancock's
        face reconstruction (predictor + half-slope extrapolation)
        to match the flux the pipe will actually deliver at the
        boundary. Passing an incorrect dt reintroduces a conservation
        drift of O(Δdt · flow amplitude). Compute dt from the pipe
        interiors (cfl_dt works without valid ghosts) BEFORE calling
        this method.
        """
        if len(self.legs) < 2:
            return

        interiors = [_interior_primitives(L) for L in self.legs]

        # Initial guess: area-weighted mean of interior pressures
        sum_pA = sum(it[2] * it[5] for it in interiors)
        sum_A  = sum(it[5] for it in interiors)
        p_j = sum_pA / sum_A

        # References for the characteristic expansion, starts as interior
        # state for every leg. May be overridden per-leg by the
        # inflow-entropy Picard pass below.
        references = [(it[0], it[1], it[2], it[4]) for it in interiors]

        # --- Secant iteration on HLLC-consistent mass balance ----------
        p_j, niter, face_states, converged = self._secant_mass_balance(
            interiors, references, p_j, dt,
        )
        if not converged:
            raise JunctionConvergenceError(
                f"CharacteristicJunction did not converge in "
                f"{self.newton_max_iter} secant steps. "
                f"last p_j = {p_j:.1f} Pa, last |R| = {self.last_mass_residual:.3e} kg/s. "
                f"Leg interiors (ρ, u, p): "
                f"{[(it[0], it[1], it[2]) for it in interiors]}"
            )

        # --- Regime check: any choked legs? ----------------------------
        # face_states entries are (rho_f, u_f, p_f, F_mass). Map to
        # (rho_f, u_f, c_f) for the existing choke classifier.
        face_states_ruc = [
            (rho_f, u_f, float(np.sqrt(it[6] * p_f / max(rho_f, 1e-9))))
            for (rho_f, u_f, p_f, _F), it in zip(face_states, interiors)
        ]
        choked_legs = self._detect_choked_legs(face_states_ruc)
        if choked_legs:
            p_j, niter_c, face_states = self._solve_with_choked(
                interiors, references, choked_legs, dt,
            )
            niter += niter_c
            self.last_regime = f"choked_{len(choked_legs)}"
        else:
            self.last_regime = "subsonic"

        # --- Inflow entropy correction (Picard one pass) ---------------
        # Internal knob _inflow_entropy_picard is True by default; not
        # surfaced in the constructor signature to prevent it being
        # used as a result-tuning lever.
        if self._inflow_entropy_picard and not choked_legs:
            p_j_corr, face_states_corr, references_corr = self._inflow_entropy_pass(
                interiors, face_states, references, p_j, dt,
            )
            if p_j_corr is not None:
                p_j = p_j_corr
                face_states = face_states_corr
                references = references_corr

        # --- Composition mixing ----------------------------------------
        Y_mixed = self._compute_mixed_Y(interiors, face_states)
        self.last_y_mixed = Y_mixed

        # --- Energy residual (diagnostic, signed) ----------------------
        self.last_energy_residual = self._energy_residual(
            interiors, face_states,
        )

        # --- Ghost-cell write ------------------------------------------
        self._write_ghosts(interiors, face_states, Y_mixed, p_j)

        self.last_p_junction = p_j
        self.last_niter = niter

    def absorb_fluxes(self, dt: float) -> None:
        """No-op. The characteristic junction has no separate control-volume
        state; conservation is maintained by the ghost-mediated face
        fluxes directly. Method kept for API symmetry with JunctionCV."""
        _ = dt

    # --- Secant mass balance (HLLC-consistent) -------------------------

    def _secant_mass_balance(self, interiors, references, p_j, dt):
        """Secant iteration on p_j with the HLLC-based residual. Secant
        instead of Newton because dR/dp_j under HLLC has internal
        branches (S_L/S_R/S* sign changes) that make an analytic
        Jacobian fragile; secant uses two residual evaluations per
        step and is robust under branches.
        """
        p_floor = 1000.0
        dp_fd = 1.0   # 1 Pa perturbation for initial finite difference

        # Prime with two residual evaluations at p_j and p_j + 1 Pa.
        R0, fs0 = _hllc_mass_residual(self.legs, interiors, p_j, references, dt)
        self.last_mass_residual = R0
        if abs(R0) < self.newton_tol:
            return p_j, 1, fs0, True

        p_prev = p_j
        R_prev = R0
        p_curr = p_j + dp_fd
        R_curr, fs_curr = _hllc_mass_residual(
            self.legs, interiors, p_curr, references, dt,
        )

        for it in range(self.newton_max_iter):
            self.last_mass_residual = R_curr
            if abs(R_curr) < self.newton_tol:
                return p_curr, it + 2, fs_curr, True
            denom = R_curr - R_prev
            if abs(denom) < 1e-30:
                return p_curr, it + 2, fs_curr, False
            slope = denom / (p_curr - p_prev)
            dp = -R_curr / slope
            cap = 0.2 * p_curr
            if dp > cap:
                dp = cap
            elif dp < -cap:
                dp = -cap
            p_next = max(p_curr + dp, p_floor)
            R_next, fs_next = _hllc_mass_residual(
                self.legs, interiors, p_next, references, dt,
            )
            p_prev, R_prev = p_curr, R_curr
            p_curr, R_curr, fs_curr = p_next, R_next, fs_next

        self.last_mass_residual = R_curr
        return p_curr, self.newton_max_iter + 1, fs_curr, False

    # --- Choked-leg dispatch -------------------------------------------

    def _detect_choked_legs(self, face_states_ruc):
        """Return indices of legs whose converged face state is at or
        above Mach (1 − choke_margin) with flow INTO the junction.

        ``face_states_ruc`` is a list of (rho_f, u_f, c_f) tuples
        (the "ruc" = rho,u,c form; separate from the 4-tuple used
        by the HLLC residual path)."""
        choked = []
        for i, (L, (rho_f, u_f, c_f)) in enumerate(zip(self.legs, face_states_ruc)):
            M_into = L.sign_into * u_f / max(c_f, 1.0)
            if M_into > 1.0 - self.choke_margin:
                choked.append(i)
        return choked

    def _solve_with_choked(self, interiors, references, choked_indices, dt):
        """Reduced HLLC-consistent solve: choked legs contribute a
        fixed sonic mass flux; secant iterates p_j across the
        subsonic legs so the HLLC mass flux sum (choked + subsonic)
        balances to zero."""
        choked_set = set(choked_indices)
        if len(choked_set) == len(self.legs):
            raise JunctionAllChokedError(
                f"All {len(self.legs)} legs simultaneously choked at "
                f"the junction face — no subsonic leg remains to balance "
                f"mass. Indicates upstream pathology."
            )

        # Sonic throat mass flux for each choked leg, using the leg's
        # interior stagnation state as reservoir. The sonic flux is a
        # *physical* flux (not HLLC-consistent), but the choked ghost
        # state written later feeds HLLC; HLLC on (interior, sonic
        # ghost) will deliver ≈ the sonic mass flux up to reconstruction
        # error, and the residual below treats the choked legs as
        # exactly sonic to close the system.
        fixed_mdot = []
        for idx in choked_indices:
            it = interiors[idx]
            rho_i, u_i, p_i, _Y = it[0], it[1], it[2], it[3]
            c_i, A_i, gamma_leg = it[4], it[5], it[6]
            gp1 = gamma_leg + 1.0
            gm1 = gamma_leg - 1.0
            choke_exp = -0.5 * gp1 / gm1
            M_i = u_i / max(c_i, 1.0)
            t0_factor = 1.0 + 0.5 * gm1 * M_i * M_i
            rho0 = rho_i * t0_factor ** (1.0 / gm1)
            c0 = c_i * np.sqrt(t0_factor)
            mdot_star = rho0 * c0 * A_i * (gp1 / 2.0) ** choke_exp
            sigma = self.legs[idx].sign_into
            fixed_mdot.append((idx, sigma * mdot_star))
        fixed_mdot_sum = sum(v for _, v in fixed_mdot)

        # Restrict residual to non-choked legs (MUSCL-aware, matches
        # the main subsonic residual's reconstruction behavior).
        def residual(p_j):
            face_states_all = [None] * len(self.legs)  # type: ignore
            R = fixed_mdot_sum
            # Build a legs-slice + interiors-slice for just the non-choked
            # legs and call the main residual machinery on it.
            sub_legs = []
            sub_interiors = []
            sub_refs = []
            sub_indices = []
            for i, (leg, it, ref) in enumerate(
                zip(self.legs, interiors, references)
            ):
                if i in choked_set:
                    continue
                sub_legs.append(leg)
                sub_interiors.append(it)
                sub_refs.append(ref)
                sub_indices.append(i)
            R_sub, fs_sub = _hllc_mass_residual(
                sub_legs, sub_interiors, p_j, sub_refs, dt,
            )
            R += R_sub
            for sub_idx, full_idx in enumerate(sub_indices):
                face_states_all[full_idx] = fs_sub[sub_idx]
            return R, face_states_all

        # Initial guess: area-weighted mean over non-choked legs
        sum_pA = 0.0
        sum_A = 0.0
        for i, it in enumerate(interiors):
            if i in choked_set:
                continue
            sum_pA += it[2] * it[5]   # p_i * A_i
            sum_A  += it[5]
        p_j = sum_pA / max(sum_A, 1e-9)

        # Secant
        p_floor = 1000.0
        dp_fd = 1.0
        R_prev, fs_prev = residual(p_j)
        if abs(R_prev) < self.newton_tol:
            self._fill_choked_face_states(interiors, choked_indices, fs_prev)
            self.last_mass_residual = R_prev
            return p_j, 1, fs_prev
        p_prev = p_j
        p_curr = p_j + dp_fd
        R_curr, fs_curr = residual(p_curr)
        for it in range(self.newton_max_iter):
            if abs(R_curr) < self.newton_tol:
                self._fill_choked_face_states(interiors, choked_indices, fs_curr)
                self.last_mass_residual = R_curr
                return p_curr, it + 2, fs_curr
            denom = R_curr - R_prev
            if abs(denom) < 1e-30:
                break
            slope = denom / (p_curr - p_prev)
            dp = -R_curr / slope
            cap = 0.2 * p_curr
            if dp > cap:
                dp = cap
            elif dp < -cap:
                dp = -cap
            p_next = max(p_curr + dp, p_floor)
            R_next, fs_next = residual(p_next)
            p_prev, R_prev = p_curr, R_curr
            p_curr, R_curr, fs_curr = p_next, R_next, fs_next

        raise JunctionConvergenceError(
            f"CharacteristicJunction choked branch did not converge "
            f"({len(choked_indices)} legs choked, "
            f"{len(self.legs) - len(choked_indices)} subsonic). "
            f"last p_j = {p_curr:.1f} Pa, |R| = {abs(R_curr):.3e}"
        )

    def _fill_choked_face_states(
        self, interiors, choked_indices, face_states_all,
    ):
        """Populate face_states_all entries for choked legs with their
        sonic-throat state, packaged as (rho_f, u_f, p_f, F_mass) to
        match the subsonic face-state tuple shape."""
        for idx in choked_indices:
            L = self.legs[idx]
            it = interiors[idx]
            rho_i, u_i, p_i = it[0], it[1], it[2]
            c_i, A_i, gamma_leg = it[4], it[5], it[6]
            gm1 = gamma_leg - 1.0
            M_i = u_i / max(c_i, 1.0)
            t0_factor = 1.0 + 0.5 * gm1 * M_i * M_i
            rho0 = rho_i * t0_factor ** (1.0 / gm1)
            c0 = c_i * np.sqrt(t0_factor)
            t_star_over_t0 = 2.0 / (gamma_leg + 1.0)
            rho_star = rho0 * t_star_over_t0 ** (1.0 / gm1)
            c_star = c0 * np.sqrt(t_star_over_t0)
            u_star = L.sign_into * c_star
            p_star = rho_star * c_star * c_star / gamma_leg
            F_mass_star = L.sign_into * rho_star * abs(c_star) * A_i  # throat mass flux
            face_states_all[idx] = (rho_star, u_star, p_star, F_mass_star)

    # --- Inflow entropy Picard pass ------------------------------------

    def _inflow_entropy_pass(
        self, interiors, face_states, references, p_j_current, dt,
    ):
        """One-pass Picard correction: for legs carrying mass out of the
        junction (into the pipe), re-evaluate the face state using the
        junction-mixed entropy as the reference state rather than the
        leg's own interior entropy, then re-solve secant for p_j.

        face_states entries: (rho_f, u_f, p_f, F_mass).

        Returns (new_p_j, new_face_states, new_references) if applied,
        else (None, None, None)."""
        inflow_legs = []
        outflow_legs = []
        for i, (L, fs) in enumerate(zip(self.legs, face_states)):
            _rho_f, _u_f, _p_f, F_mass = fs
            if L.sign_into * F_mass < 0.0:
                inflow_legs.append(i)
            else:
                outflow_legs.append(i)

        if not inflow_legs or not outflow_legs:
            return None, None, None

        # Mass-weighted ρ, p across outflow legs = junction reservoir.
        # Use HLLC-consistent F_mass (not analytic ρ_f·u_f) so the
        # reservoir state matches what MUSCL will actually deliver.
        mdot_out_total = 0.0
        rho_mix = 0.0
        p_mix = 0.0
        for i in outflow_legs:
            L = self.legs[i]
            rho_f, _u_f, _p_f, F_mass = face_states[i]
            A_i = interiors[i][5]
            mdot = L.sign_into * F_mass * A_i
            mdot_out_total += mdot
            rho_mix += mdot * rho_f
            p_mix   += mdot * interiors[i][2]   # interior p
        if mdot_out_total <= 0.0:
            return None, None, None
        rho_mix /= mdot_out_total
        p_mix   /= mdot_out_total

        # Build corrected references. For inflow legs, use (rho_mix,
        # u_interior, p_mix, c_mix) — interior u is still the velocity
        # reference along the outgoing characteristic, the rest comes
        # from the junction reservoir. For outflow legs, keep their
        # original interior reference.
        new_refs = list(references)
        for i in inflow_legs:
            # interiors[i] shape: (rho, u, p, Y, c, A, gamma, rho_in, u_in, p_in, rhoY_in)
            u_i = interiors[i][1]
            gamma_leg = interiors[i][6]
            c_mix = float(np.sqrt(gamma_leg * p_mix / max(rho_mix, 1e-9)))
            new_refs[i] = (rho_mix, u_i, p_mix, c_mix)

        # Re-run secant from current p_j with corrected references.
        p_j, niter, fs_new, converged = self._secant_mass_balance(
            interiors, new_refs, p_j_current, dt,
        )
        if converged:
            return p_j, fs_new, new_refs
        # Picard didn't converge — drop the correction.
        return None, None, None

    # --- Composition mixing --------------------------------------------

    def _compute_mixed_Y(self, interiors, face_states):
        """Mass-weighted Y of legs delivering mass INTO the junction.

        Uses the HLLC-consistent mass flux from face_states[i][3] (what
        MUSCL will actually deliver at the boundary face), not the
        analytic ρ_f·u_f·A product — those two quantities differ
        slightly, and using the analytic version here leaks species
        mass (ρY non-conservation) at machine scale."""
        mdot_in_total = 0.0
        YsumIn = 0.0
        for L, fs, it in zip(self.legs, face_states, interiors):
            _rho_f, _u_f, _p_f, F_mass = fs
            Y_i = it[3]
            A_i = it[5]
            signed_into_j = L.sign_into * F_mass * A_i
            if signed_into_j > 0.0:
                mdot_in_total += signed_into_j
                YsumIn += signed_into_j * Y_i
        if mdot_in_total > 1e-30:
            return YsumIn / mdot_in_total
        return 0.0

    # --- Energy residual -----------------------------------------------

    def _energy_residual(self, interiors, face_states):
        """Signed energy residual at the junction face. Σ σ_i ρ_f u_f A_i h0_f.

        Positive residual = junction gaining energy (physically impossible,
        flags numerical bug). Negative of small magnitude = lossy mixing
        across area change, expected and correct for mismatched junctions."""
        E_flux = 0.0
        for L, fs, it in zip(self.legs, face_states, interiors):
            rho_f, u_f, p_f, _F = fs
            A_i = it[5]
            gamma_leg = it[6]
            gm1 = gamma_leg - 1.0
            # h from face state: h = c²/(γ−1) where c² = γ·p/ρ
            c_f_sq = gamma_leg * p_f / max(rho_f, 1e-9)
            h = c_f_sq / gm1
            h0 = h + 0.5 * u_f * u_f
            E_flux += L.sign_into * rho_f * u_f * A_i * h0
        return E_flux

    # --- Ghost write ---------------------------------------------------

    def _write_ghosts(self, interiors, face_states, Y_mixed, p_j):
        for leg, it, fs in zip(self.legs, interiors, face_states):
            Y_i = it[3]
            gamma_leg = it[6]
            rho_f, u_f, p_f, F_mass = fs
            gm1 = gamma_leg - 1.0
            # Y upstream-upwind: use HLLC-consistent sign to match what
            # MUSCL's HLLC will do when upwinding species at the face.
            signed_into_hllc = leg.sign_into * F_mass
            Y_ghost = Y_i if signed_into_hllc >= 0.0 else Y_mixed

            # Fix 13: Borda-Carnot loss on incoming (receiving) legs.
            # For mass entering the leg from the junction (junction → pipe),
            # apply a dynamic-pressure loss to model area-expansion + air-
            # filter + throttle losses that aren't modeled in the lossless
            # 1-D pipe + ideal-isentropic junction system.
            # The loss reduces ghost pressure; density adjusts isentropically
            # to maintain entropy along the (now lossier) characteristic.
            if self.inflow_loss_coef > 0.0 and signed_into_hllc < 0.0:
                dp_loss = self.inflow_loss_coef * 0.5 * rho_f * u_f * u_f
                p_f_new = max(p_f - dp_loss, 0.5 * p_f)  # floor at 50% to avoid runaway
                # Isentropic ρ from p change (preserves entropy s = p/ρ^γ)
                rho_f_new = rho_f * (p_f_new / max(p_f, 1.0)) ** (1.0 / gamma_leg)
                p_f = p_f_new
                rho_f = rho_f_new

            E_ghost_density = p_f / gm1 + 0.5 * rho_f * u_f * u_f
            state = leg.state
            ng = state.n_ghost
            nc = state.n_cells
            if leg.end == LEFT:
                ghost_range = range(0, ng)
            else:
                ghost_range = range(ng + nc, state.n_total)
            for i in ghost_range:
                A_g = state.area[i]
                state.q[i, I_RHO_A] = rho_f * A_g
                state.q[i, I_MOM_A] = rho_f * u_f * A_g
                state.q[i, I_E_A]   = E_ghost_density * A_g
                state.q[i, I_Y_A]   = rho_f * Y_ghost * A_g


# ---------------------------------------------------------------------------
# Factory for model wiring. Default stays "stagnation" per Phase E review
# decision — characteristic junction is opt-in, requested explicitly by
# models that want wave propagation through the merge.
# ---------------------------------------------------------------------------

def make_junction(
    junction_type: str,
    legs: List[JunctionLeg],
    *,
    gamma: float = 1.4,
    R_gas: float = 287.0,
    p_init: float = 101325.0,
    T_init: float = 300.0,
    Y_init: float = 0.0,
):
    """Factory returning either a JunctionCV (stagnation, default) or a
    CharacteristicJunction. Both expose the same fill_ghosts /
    absorb_fluxes lifecycle.

    - junction_type="stagnation" → bcs.junction_cv.JunctionCV
    - junction_type="characteristic" → CharacteristicJunction

    Leg types differ: JunctionCV wants JunctionCVLeg, this module wants
    JunctionLeg. The factory handles the conversion when needed.
    """
    if junction_type == "stagnation":
        # Late import to avoid circularity at module load.
        from bcs.junction_cv import JunctionCV, JunctionCVLeg
        cv_legs = [JunctionCVLeg(L.state, L.end) for L in legs]
        return JunctionCV.from_legs(
            cv_legs,
            p_init=p_init, T_init=T_init, Y_init=Y_init,
            gamma=gamma, R_gas=R_gas,
        )
    if junction_type == "characteristic":
        return CharacteristicJunction(
            legs=legs, gamma=gamma, R_gas=R_gas,
        )
    raise ValueError(
        f"unknown junction_type {junction_type!r}; "
        f"choose 'stagnation' (default, strict conservation) or "
        f"'characteristic' (better wave transmission)"
    )
