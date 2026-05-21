"""Gas properties — burned/unburned γ(T) and mixture R(xb), all SI, all @njit.

Source: 1d/engine_simulator/gas_dynamics/gas_properties.py  (read-only V1 file)
Copy date: 2026-04-13

Changes vs V1:
- Ported from module-level numpy-array-vectorised functions to @njit scalar
  free functions callable from V2 @njit kernels (valve BC ghost-cell fill).
  V1's use of np.clip / np.asarray is replaced with scalar min/max.
- Dropped all Benson non-dimensionalization helpers (V2 is SI throughout).
- Dropped friction and heat-transfer correlations from this file; they live
  in solver/sources.py (also ported from V1 with their own header).

V1 coefficients (preserved verbatim):
    R_AIR    = 287.0   J/(kg·K)
    R_BURNED = 295.0   J/(kg·K)  (approximate stoich gasoline-air)
    γ_unburned(T) = 1.38 − 1.2e-4 · clamp(T, 300..900) offset 300
    γ_burned(T)   = 1.30 − 8.0e-5 · clamp(T, 300..3000) offset 300
    γ_mix(T, xb)  = (1-xb)·γ_unburned + xb·γ_burned
    R_mix(xb)     = (1-xb)·R_AIR + xb·R_BURNED

These polynomials are JIT-friendly as written; no table lookups.
"""

from __future__ import annotations

import numpy as np
from numba import njit


R_AIR = 287.0       # J/(kg·K), dry air
R_BURNED = 295.0    # J/(kg·K), burned stoichiometric gasoline-air approx


@njit(cache=True, fastmath=False)
def gamma_unburned(T: float) -> float:
    """γ(T) for unburned air-fuel mixture, valid 300..3000 K.

    Audit 2026-05-20: replaced V1's linear fit clamped at T=900 K with a
    NASA-7 quadratic fit to stoich gasoline-air (C8H18 in stoich air),
    same treatment that the 2026-05-19 audit applied to γ_burned. The
    clamp at 900 K kept γ artificially HIGH for the unburned end-gas
    fraction during combustion (where local T reaches 1500..2500 K and
    real γ drops to ~1.20..1.28). Mixture γ during the burn was biased
    high by up to +0.05, inflating dp/dθ.

    Quadratic fitted to NASA-7 reference points (frozen-composition
    stoich C8H18+air):
        T=300 K  γ_NASA=1.378  γ_quad=1.378
        T=900 K  γ_NASA=1.323  γ_quad=1.322
        T=1500 K γ_NASA=1.279  γ_quad=1.279
        T=2400 K γ_NASA=1.250  γ_quad=1.240
        T=3000 K γ_NASA=1.231  γ_quad=1.231
    Max residual ±0.010 over 300..3000 K (acceptable; the burned-fraction
    γ_burned dominates above x_b ≈ 0.5).
    Revert: restore `1.38 - 1.2e-4 * (T_clamped - 300.0)` with clamp at 900 K.
    """
    T_clamped = T
    if T_clamped < 300.0:
        T_clamped = 300.0
    elif T_clamped > 3000.0:
        T_clamped = 3000.0
    return 1.4112 - 1.162e-4 * T_clamped + 1.870e-8 * T_clamped * T_clamped


@njit(cache=True, fastmath=False)
def gamma_burned(T: float) -> float:
    """γ(T) for burned stoichiometric gasoline-air, valid 300..3000 K.

    Audit 2026-05-19: replaced V1's linear fit (1.30 - 8.0e-5·(T-300)),
    which was ~2× too steep AND too low intercept, with a quadratic fit
    to NASA-7 frozen-composition γ for stoich C8H18+air products
    (yCO2=0.125, yH2O=0.1406, yN2=0.7344). Max residual ±0.007 K vs
    NASA-7 over 300..3000 K. Reference points:
        T=300 K  γ_NASA=1.370   γ_quad=1.366
        T=1500 K γ_NASA=1.267   γ_quad=1.268
        T=2400 K γ_NASA=1.246   γ_quad=1.241
        T=3000 K γ_NASA=1.240   γ_quad=1.246

    V1's polynomial gave γ=1.132 at 2400 K, biasing IMEP/power low by
    5-15% at high RPM. Revert: restore `1.30 - 8.0e-5 * (T_clamped - 300.0)`.
    """
    T_clamped = T
    if T_clamped < 300.0:
        T_clamped = 300.0
    elif T_clamped > 3000.0:
        T_clamped = 3000.0
    return 1.40186 - 1.273e-4 * T_clamped + 2.518e-8 * T_clamped * T_clamped


@njit(cache=True, fastmath=False)
def gamma_mixture(T: float, x_b: float) -> float:
    """Mass-fraction weighted γ during combustion. x_b in [0, 1]."""
    if x_b <= 0.0:
        return gamma_unburned(T)
    if x_b >= 1.0:
        return gamma_burned(T)
    return (1.0 - x_b) * gamma_unburned(T) + x_b * gamma_burned(T)


@njit(cache=True, fastmath=False)
def R_mixture(x_b: float) -> float:
    """Mass-fraction weighted specific gas constant."""
    if x_b <= 0.0:
        return R_AIR
    if x_b >= 1.0:
        return R_BURNED
    return (1.0 - x_b) * R_AIR + x_b * R_BURNED


@njit(cache=True, fastmath=False)
def speed_of_sound(gamma: float, R: float, T: float) -> float:
    """a = sqrt(γ·R·T). Clamps T at 1 K to avoid sqrt of negatives on broken state."""
    if T < 1.0:
        T = 1.0
    return np.sqrt(gamma * R * T)
