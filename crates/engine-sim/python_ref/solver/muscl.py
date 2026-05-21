"""MUSCL-Hancock predictor-corrector with slope-limited linear reconstruction.

Reference: Toro, "Riemann Solvers and Numerical Methods for Fluid Dynamics",
3rd ed., 2009, Chapter 14 (second-order TVD methods).

Reconstruction is on primitive-like variables (ρ, u, p, ρY). Minmod is the
default; van Leer and superbee are available. The predictor evolves the
boundary-extrapolated states by Δt/2 using the quasi-linear Euler form
(Toro 14.22). The corrector solves HLLC Riemann problems at each face.

Quasi-1D formulation: state is (ρA, ρuA, EA, ρYA); flux is
((ρu)·A, (ρu²+p)·A, (E+p)u·A, ρuY·A); pressure-area source p·dA/dx is added
to the momentum equation. No source on mass, energy, or composition from
area variation alone (inviscid, no heat input from geometry).

Derivation (momentum): starting from the PDE
  ∂(ρuA)/∂t = -(∂/∂x)(ρu²·A) - A·(∂p/∂x)
             = -(∂/∂x)((ρu²+p)·A) + p·(dA/dx).
So the quasi-1D conservative form has flux (ρu²+p)·A AND a source +p·dA/dx.

================================================================================
Why channel 3 is ρY (conservative), not Y (primitive) — READ BEFORE EDITING
================================================================================
Channels 0, 1, 2 of the reconstruction vector are primitives (ρ, u, p).
Channel 3 is the CONSERVATIVE composition density ρY, NOT the primitive
mass fraction Y.

The reason: two independent primitive reconstructions of ρ and Y produce
face states ρ_face and Y_face whose product ρ_face · Y_face is NOT equal
to (ρY)_face from a separate linear reconstruction of ρY — because the
product of two linears is quadratic. If we fed HLLC a Y_face derived from
primitive reconstruction, the composition flux ρ·u·Y at the face would
differ from what an honest conservative reconstruction of ρY would give,
and the scalar ρY would not be discretely conserved. This is the bug that
bites every multi-fluid / multi-species Euler code if you're not careful.

The fix: reconstruct ρY linearly in channel 3, and at each face compute the
face-Y that HLLC needs as
    Y_face = (ρY)_face_reconstructed / ρ_face_reconstructed .
That way ρY is conservatively transported (provably, because HLLC × A_face
× dt is the face flux of ρY that updates the adjacent cells' ρYA) and Y
is just a derived quantity at faces.

Downstream reader: if you ever think "why is composition weird at channel 3
when pressure is at 2? Let's move it alongside the primitives," don't.
Put a comment on your commit explaining the multi-fluid reconstruction
issue first; if you still want to move it, prove it preserves ρY to
machine precision on a closed-domain test (tests/test_conservation.py).
================================================================================
"""

from __future__ import annotations

import numpy as np
from numba import njit

from solver.hllc import hllc_flux


LIMITER_MINMOD = 0
LIMITER_VAN_LEER = 1
LIMITER_SUPERBEE = 2


@njit(cache=True, fastmath=False)
def _minmod(a: float, b: float) -> float:
    if a * b <= 0.0:
        return 0.0
    if abs(a) < abs(b):
        return a
    return b


@njit(cache=True, fastmath=False)
def _van_leer(a: float, b: float) -> float:
    """Van Leer: ψ = 2·a·b/(a+b) when a·b > 0, else 0."""
    if a * b <= 0.0:
        return 0.0
    return 2.0 * a * b / (a + b)


@njit(cache=True, fastmath=False)
def _superbee(a: float, b: float) -> float:
    """Superbee limiter: max of minmod(2a,b) and minmod(a,2b)."""
    if a * b <= 0.0:
        return 0.0
    # minmod(2a, b)
    if abs(2.0 * a) < abs(b):
        lim1 = 2.0 * a
    else:
        lim1 = b
    # minmod(a, 2b)
    if abs(a) < abs(2.0 * b):
        lim2 = a
    else:
        lim2 = 2.0 * b
    if abs(lim1) > abs(lim2):
        return lim1
    return lim2


@njit(cache=True, fastmath=False)
def _limit(a: float, b: float, limiter: int) -> float:
    if limiter == LIMITER_VAN_LEER:
        return _van_leer(a, b)
    if limiter == LIMITER_SUPERBEE:
        return _superbee(a, b)
    return _minmod(a, b)


@njit(cache=True, fastmath=False)
def _compute_primitives(q: np.ndarray, area: np.ndarray, gamma: float, w_out: np.ndarray):
    """Fill w_out[i, :] = (ρ, u, p, ρY) from q[i, :] and area[i].

    NOTE: index 3 stores the CONSERVATIVE composition ρY, not the primitive
    mass fraction Y. This keeps composition reconstruction consistent with
    the conservative variable it advects (ρY), avoiding the well-known
    de-sync between ρ and Y midpoints when Y is reconstructed as a
    primitive. The HLLC wrapper below converts ρY → Y at each face by
    dividing by the reconstructed ρ.
    """
    n = q.shape[0]
    gm1 = gamma - 1.0
    for i in range(n):
        A = area[i]
        rho = q[i, 0] / A
        rho_u = q[i, 1] / A
        E = q[i, 2] / A
        rho_Y = q[i, 3] / A
        u = rho_u / rho
        p = gm1 * (E - 0.5 * rho_u * rho_u / rho)
        w_out[i, 0] = rho
        w_out[i, 1] = u
        w_out[i, 2] = p
        w_out[i, 3] = rho_Y


@njit(cache=True, fastmath=False)
def _reconstruct_slopes(w: np.ndarray, slopes: np.ndarray, limiter: int):
    """Slope-limited primitive slopes σ_i for interior cells."""
    n = w.shape[0]
    for i in range(1, n - 1):
        for k in range(4):
            a = w[i, k] - w[i - 1, k]
            b = w[i + 1, k] - w[i, k]
            slopes[i, k] = _limit(a, b, limiter)
    for k in range(4):
        slopes[0, k] = 0.0
        slopes[n - 1, k] = 0.0


@njit(cache=True, fastmath=False)
def muscl_hancock_step(
    q: np.ndarray,        # (N, 4) conservative (ρA, ρuA, EA, ρYA)
    area: np.ndarray,     # (N,)   cell-centre area
    area_f: np.ndarray,   # (N+1,) face area
    dx: float,
    dt: float,
    gamma: float,
    n_ghost: int,
    limiter: int,
    w: np.ndarray,        # (N, 4) scratch: primitives
    slopes: np.ndarray,   # (N, 4) scratch: limited slopes
    w_pred_L: np.ndarray, # (N, 4) scratch: left-extrap evolved primitives
    w_pred_R: np.ndarray, # (N, 4) scratch: right-extrap evolved primitives
    flux: np.ndarray,     # (N+1, 4) scratch: face fluxes (with A_face baked in)
):
    """Single MUSCL-Hancock + HLLC step for quasi-1D Euler.

    Ghost cells (indices 0..n_ghost-1 and n-n_ghost..n-1) must be filled
    by the caller before entry; this function only updates real cells.

    See module docstring for the governing equations and source term.
    """
    n = q.shape[0]

    # Step 1: primitives
    _compute_primitives(q, area, gamma, w)

    # Step 2: slopes
    _reconstruct_slopes(w, slopes, limiter)

    # Step 3: Hancock predictor.
    # We store (ρ, u, p, ρY) and evolve each by dt/2 using its primitive
    # PDE (ρY uses the conservation form since it is itself a conserved
    # density):
    #   ∂ρ/∂t + u·∂ρ/∂x + ρ·∂u/∂x = 0                 (mass)
    #   ∂u/∂t + u·∂u/∂x + (1/ρ)·∂p/∂x = 0             (momentum, Toro 14.22)
    #   ∂p/∂t + u·∂p/∂x + γp·∂u/∂x = 0                (energy, pressure form)
    #   ∂(ρY)/∂t + u·∂(ρY)/∂x + (ρY)·∂u/∂x = 0        (composition conservation)
    # σ is the discrete ∂·/∂x · Δx estimate per variable.
    half_dt_dx = 0.5 * dt / dx
    for i in range(n):
        rho = w[i, 0]; u = w[i, 1]; p = w[i, 2]; rhoY = w[i, 3]
        srho = slopes[i, 0]; su = slopes[i, 1]; sp = slopes[i, 2]; srhoY = slopes[i, 3]

        drho  = -half_dt_dx * (u * srho + rho * su)
        du    = -half_dt_dx * (u * su + sp / rho)
        dp    = -half_dt_dx * (u * sp + gamma * p * su)
        drhoY = -half_dt_dx * (u * srhoY + rhoY * su)

        w_pred_L[i, 0] = rho  + drho  - 0.5 * srho
        w_pred_L[i, 1] = u    + du    - 0.5 * su
        w_pred_L[i, 2] = p    + dp    - 0.5 * sp
        w_pred_L[i, 3] = rhoY + drhoY - 0.5 * srhoY
        w_pred_R[i, 0] = rho  + drho  + 0.5 * srho
        w_pred_R[i, 1] = u    + du    + 0.5 * su
        w_pred_R[i, 2] = p    + dp    + 0.5 * sp
        w_pred_R[i, 3] = rhoY + drhoY + 0.5 * srhoY

    # Step 4: corrector — HLLC at each face.
    # Face j separates cell (j-1) on the left from cell j on the right.
    # Reconstruction stores ρY in channel 3; we divide by the reconstructed
    # ρ at each face to get the primitive Y that HLLC expects.
    for j in range(1, n):
        rhoL  = w_pred_R[j - 1, 0]; uL = w_pred_R[j - 1, 1]
        pL    = w_pred_R[j - 1, 2]
        rhoYL = w_pred_R[j - 1, 3]
        rhoR  = w_pred_L[j, 0];     uR = w_pred_L[j, 1]
        pR    = w_pred_L[j, 2]
        rhoYR = w_pred_L[j, 3]
        # Positivity fallback
        if rhoL <= 0.0 or pL <= 0.0 or rhoR <= 0.0 or pR <= 0.0:
            rhoL = w[j - 1, 0]; uL = w[j - 1, 1]; pL = w[j - 1, 2]; rhoYL = w[j - 1, 3]
            rhoR = w[j, 0];     uR = w[j, 1];     pR = w[j, 2];     rhoYR = w[j, 3]
        YL = rhoYL / rhoL
        YR = rhoYR / rhoR

        f0, f1, f2, f3 = hllc_flux(rhoL, uL, pL, YL, rhoR, uR, pR, YR, gamma)
        Af = area_f[j]
        flux[j, 0] = f0 * Af
        flux[j, 1] = f1 * Af
        flux[j, 2] = f2 * Af
        flux[j, 3] = f3 * Af

    # Step 5: conservative update on real cells.
    inv_dx = 1.0 / dx
    for i in range(n_ghost, n - n_ghost):
        q[i, 0] -= dt * inv_dx * (flux[i + 1, 0] - flux[i, 0])
        q[i, 1] -= dt * inv_dx * (flux[i + 1, 1] - flux[i, 1])
        # Pressure-area source on momentum
        dA_dx = (area_f[i + 1] - area_f[i]) * inv_dx
        q[i, 1] += dt * w[i, 2] * dA_dx
        q[i, 2] -= dt * inv_dx * (flux[i + 1, 2] - flux[i, 2])
        q[i, 3] -= dt * inv_dx * (flux[i + 1, 3] - flux[i, 3])


@njit(cache=True, fastmath=False)
def cfl_dt(
    q: np.ndarray, area: np.ndarray, dx: float, gamma: float,
    cfl_number: float, n_ghost: int,
) -> float:
    """CFL-limited time step: dt = cfl · dx / max(|u|+a) over real cells.

    Returns 0.0 as a signal if positivity is violated in any real cell.
    """
    n = q.shape[0]
    gm1 = gamma - 1.0
    max_speed = 1e-30
    for i in range(n_ghost, n - n_ghost):
        A = area[i]
        rho = q[i, 0] / A
        rho_u = q[i, 1] / A
        E = q[i, 2] / A
        u = rho_u / rho
        p = gm1 * (E - 0.5 * rho_u * rho_u / rho)
        if p <= 0.0 or rho <= 0.0:
            return 0.0
        a = np.sqrt(gamma * p / rho)
        s = abs(u) + a
        if s > max_speed:
            max_speed = s
    return cfl_number * dx / max_speed
