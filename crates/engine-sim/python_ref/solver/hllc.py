"""HLLC Riemann solver with Einfeldt-Batten wave-speed estimate.

Reference: Toro, "Riemann Solvers and Numerical Methods for Fluid Dynamics",
3rd ed., 2009, Chapter 10.

All SI units, conservative variables (ρ, ρu, E, ρY) — area is NOT baked into
the flux at this level; multiply by face area to get the pipe-cross-section
flux.

Composition scalar Y is a passive scalar. Because HLLC resolves the contact
wave discretely, Y is advected without numerical diffusion beyond what the
limiter allows — this is the whole reason we use HLLC and not HLL for this
application.

Wave-speed estimate: Einfeldt-Batten (Toro 10.52-10.53), sometimes called the
"direct" estimate. Not the pressure-based (Toro 10.59-10.61) estimate.
EB uses Roe averages û and â, with
    S_L = min(u_L - a_L, û - â)
    S_R = max(u_R + a_R, û + â)

This implementation targets exact double-precision correctness on smooth flow
and the Sod / 123 tests; minor algebraic rearrangements from the Toro text
are called out inline.
"""

from __future__ import annotations

import numpy as np
from numba import njit


# ------------------------------------------------------------------
# Primitive / conservative conversion (standalone, testable, @njit)
# ------------------------------------------------------------------

@njit(cache=True, fastmath=False)
def prim_to_cons(rho: float, u: float, p: float, Y: float, gamma: float):
    """(ρ, u, p, Y) → (ρ, ρu, E, ρY) — E is total energy per unit volume."""
    gm1 = gamma - 1.0
    E = p / gm1 + 0.5 * rho * u * u
    return rho, rho * u, E, rho * Y


@njit(cache=True, fastmath=False)
def cons_to_prim(rho: float, rho_u: float, E: float, rho_Y: float, gamma: float):
    """(ρ, ρu, E, ρY) → (ρ, u, p, Y). ρ must be > 0."""
    gm1 = gamma - 1.0
    u = rho_u / rho
    p = gm1 * (E - 0.5 * rho_u * rho_u / rho)
    Y = rho_Y / rho
    return rho, u, p, Y


# ------------------------------------------------------------------
# Physical Euler flux
# ------------------------------------------------------------------

@njit(cache=True, fastmath=False)
def euler_flux(rho: float, u: float, p: float, Y: float, gamma: float):
    """Standard 1D Euler flux F(U).

    F = (ρu, ρu²+p, (E+p)u, ρu·Y)
    """
    gm1 = gamma - 1.0
    E = p / gm1 + 0.5 * rho * u * u
    return (
        rho * u,
        rho * u * u + p,
        (E + p) * u,
        rho * u * Y,
    )


# ------------------------------------------------------------------
# HLLC flux
# ------------------------------------------------------------------

@njit(cache=True, fastmath=False)
def hllc_flux(
    rhoL: float, uL: float, pL: float, YL: float,
    rhoR: float, uR: float, pR: float, YR: float,
    gamma: float,
):
    """HLLC numerical flux from L/R primitive states.

    Returns (F_mass, F_mom, F_energy, F_composition).

    Uses Einfeldt-Batten wave speed estimates (Toro eq. 10.52-10.53). The
    contact speed S* follows Toro eq. 10.37. Star-state conservative
    variables follow Toro eq. 10.39. The flux selection is Toro eq. 10.26.

    Assumes both states have rho > 0 and p > 0. Caller is responsible for
    positivity preservation (e.g., minmod limiter + MUSCL half-step).
    """
    gm1 = gamma - 1.0

    # 1) Sound speeds
    aL = np.sqrt(gamma * pL / rhoL)
    aR = np.sqrt(gamma * pR / rhoR)

    # 2) Einfeldt-Batten Roe-averaged wave speeds
    # Specific total enthalpy H = (E + p)/ρ = p/ρ·γ/(γ-1) + u²/2
    HL = gamma * pL / (gm1 * rhoL) + 0.5 * uL * uL
    HR = gamma * pR / (gm1 * rhoR) + 0.5 * uR * uR
    sqrtL = np.sqrt(rhoL)
    sqrtR = np.sqrt(rhoR)
    denom = sqrtL + sqrtR
    u_roe = (sqrtL * uL + sqrtR * uR) / denom
    H_roe = (sqrtL * HL + sqrtR * HR) / denom
    a_roe_sq = gm1 * (H_roe - 0.5 * u_roe * u_roe)
    # Guard against tiny negative due to roundoff
    if a_roe_sq < 0.0:
        a_roe_sq = 0.0
    a_roe = np.sqrt(a_roe_sq)

    S_L = min(uL - aL, u_roe - a_roe)
    S_R = max(uR + aR, u_roe + a_roe)

    # 3) Physical Euler fluxes
    EL = pL / gm1 + 0.5 * rhoL * uL * uL
    ER = pR / gm1 + 0.5 * rhoR * uR * uR
    FL0 = rhoL * uL
    FL1 = rhoL * uL * uL + pL
    FL2 = (EL + pL) * uL
    FL3 = rhoL * uL * YL
    FR0 = rhoR * uR
    FR1 = rhoR * uR * uR + pR
    FR2 = (ER + pR) * uR
    FR3 = rhoR * uR * YR

    # Early exits (supersonic)
    if S_L >= 0.0:
        return FL0, FL1, FL2, FL3
    if S_R <= 0.0:
        return FR0, FR1, FR2, FR3

    # 4) Contact speed S* (Toro 10.37)
    # Numerator:   p_R - p_L + ρ_L u_L (S_L - u_L) - ρ_R u_R (S_R - u_R)
    # Denominator: ρ_L (S_L - u_L) - ρ_R (S_R - u_R)
    S_star_num = pR - pL + rhoL * uL * (S_L - uL) - rhoR * uR * (S_R - uR)
    S_star_den = rhoL * (S_L - uL) - rhoR * (S_R - uR)
    S_star = S_star_num / S_star_den

    # 5) Star state flux (Toro 10.26 + 10.39)
    if S_star >= 0.0:
        # Left star state
        coef = rhoL * (S_L - uL) / (S_L - S_star)  # = ρ*_L
        U_star_0 = coef
        U_star_1 = coef * S_star
        U_star_2 = coef * (EL / rhoL + (S_star - uL) * (S_star + pL / (rhoL * (S_L - uL))))
        U_star_3 = coef * YL  # composition follows contact side
        UL0 = rhoL
        UL1 = rhoL * uL
        UL2 = EL
        UL3 = rhoL * YL
        return (
            FL0 + S_L * (U_star_0 - UL0),
            FL1 + S_L * (U_star_1 - UL1),
            FL2 + S_L * (U_star_2 - UL2),
            FL3 + S_L * (U_star_3 - UL3),
        )
    else:
        # Right star state
        coef = rhoR * (S_R - uR) / (S_R - S_star)
        U_star_0 = coef
        U_star_1 = coef * S_star
        U_star_2 = coef * (ER / rhoR + (S_star - uR) * (S_star + pR / (rhoR * (S_R - uR))))
        U_star_3 = coef * YR
        UR0 = rhoR
        UR1 = rhoR * uR
        UR2 = ER
        UR3 = rhoR * YR
        return (
            FR0 + S_R * (U_star_0 - UR0),
            FR1 + S_R * (U_star_1 - UR1),
            FR2 + S_R * (U_star_2 - UR2),
            FR3 + S_R * (U_star_3 - UR3),
        )


@njit(cache=True, fastmath=False)
def hllc_flux_array(
    wL: np.ndarray, wR: np.ndarray, gamma: float, out: np.ndarray,
) -> None:
    """Vectorised version: fill `out[i, :] = hllc_flux(wL[i], wR[i], ...)`.

    wL, wR shape (N, 4): primitives (ρ, u, p, Y).
    out shape (N, 4).
    """
    n = wL.shape[0]
    for i in range(n):
        f0, f1, f2, f3 = hllc_flux(
            wL[i, 0], wL[i, 1], wL[i, 2], wL[i, 3],
            wR[i, 0], wR[i, 1], wR[i, 2], wR[i, 3],
            gamma,
        )
        out[i, 0] = f0
        out[i, 1] = f1
        out[i, 2] = f2
        out[i, 3] = f3
