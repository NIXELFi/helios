"""Source terms for friction and wall heat transfer in quasi-1D pipes.

Reference: Toro, "Riemann Solvers and Numerical Methods for Fluid Dynamics",
3rd ed., 2009, Chapter 16 (source-term treatment via Strang splitting).

We split the PDE into a hyperbolic part (MUSCL-Hancock + HLLC) and a source
part. The source part is an ODE per cell:
    d(ρuA)/dt = -A·f·ρ|u|u/(2D)         ← friction (Blasius f)
    d(EA)/dt = -A·h·P_w·(T − T_wall)    ← wall heat (Dittus-Boelter h)
where P_w = π·D is the wetted perimeter and A is the cross-section.

We integrate this ODE explicitly over the source sub-step. At small Mach
and realistic engine pipe sizes the source time scale is comfortably
larger than the CFL-limited hyperbolic dt, so explicit integration is
stable without subcycling; caller can subdivide if needed.

Physical constants (gas properties) are copied from V1's
`gas_dynamics/gas_properties.py` and adapted to be @njit-friendly.

Source copy header
──────────────────
Source: 1d/engine_simulator/gas_dynamics/gas_properties.py  (read-only)
Copy date: 2026-04-13
Changes: (1) inlined into solver/sources.py as @njit functions, (2) removed
NumPy vectorization wrappers (the sources are called per-cell inside an
@njit loop), (3) dropped Benson non-dimensionalization helpers (V2 is SI).
"""

from __future__ import annotations

import numpy as np
from numba import njit


R_AIR_DEFAULT = 287.0  # J/(kg·K)


@njit(cache=True, fastmath=False)
def _friction_factor_blasius(Re: float) -> float:
    """Darcy friction factor — Blasius correlation (smooth pipe).

    Laminar: f = 64/Re (Re < 2300)
    Turbulent: f = 0.3164·Re^(-0.25) (Re > 2300)
    Below Re = 1 we return 0 (quiescent gas).
    """
    if Re < 1.0:
        return 0.0
    if Re < 2300.0:
        return 64.0 / Re
    return 0.3164 * Re ** (-0.25)


@njit(cache=True, fastmath=False)
def _dynamic_viscosity_air(T: float) -> float:
    """Air dynamic viscosity (Pa·s). Simple power-law fit to Sutherland data:
    μ ≈ 1.8e-5 · (T/293)^0.7 — identical to V1."""
    return 1.8e-5 * (T / 293.0) ** 0.7


@njit(cache=True, fastmath=False)
def _thermal_conductivity_air(T: float) -> float:
    """Air thermal conductivity (W/(m·K)). k ≈ 0.026 · (T/300)^0.7."""
    return 0.026 * (T / 300.0) ** 0.7


@njit(cache=True, fastmath=False)
def _nusselt_dittus_boelter(Re: float) -> float:
    """Nu = 0.023 · Re^0.8 · Pr^0.4, Pr = 0.71 for air."""
    if Re < 1.0:
        return 0.0
    return 0.023 * Re ** 0.8 * 0.71 ** 0.4


@njit(cache=True, fastmath=False)
def apply_sources(
    q: np.ndarray,           # (N, 4) conservative (ρA, ρuA, EA, ρYA)
    area: np.ndarray,        # (N,)
    hyd_D: np.ndarray,       # (N,) hydraulic diameter
    dt: float,
    gamma: float,
    R_gas: float,
    T_wall: float,
    n_ghost: int,
    apply_friction: bool = True,
    apply_heat: bool = True,
):
    """Explicit ODE integration of friction + wall heat sources over Δt.

    Modifies q in place on real cells only.

    Friction: momentum loss dq₁/dt = −A·(f/2D)·ρ|u|u.
    Wall heat: energy loss dq₂/dt = −A·(h·P_w/A)·(T − T_wall)·A_cross
               Wait — we're updating EA, so dq₂/dt = −h·P_w·(T − T_wall)
               where P_w = π·D is the perimeter. Energy per unit volume
               changes at rate −h·P_w·(T − T_wall)/A; so d(EA)/dt =
               −h·P_w·(T − T_wall). Same dimensional form.

    For explicit stability: caller ensures dt is small enough. Typically
    the CFL-limited hyperbolic dt is fine; if source stiffness grows
    (huge h or tiny D), subcycle externally.
    """
    n = q.shape[0]
    gm1 = gamma - 1.0
    for i in range(n_ghost, n - n_ghost):
        A = area[i]
        D = hyd_D[i]
        if D <= 0.0 or A <= 0.0:
            continue
        # Primitives
        rho = q[i, 0] / A
        if rho <= 0.0:
            continue
        u = q[i, 1] / (rho * A)
        E = q[i, 2] / A
        p = gm1 * (E - 0.5 * rho * u * u)
        if p <= 0.0:
            continue
        T = p / (rho * R_gas)

        # Friction: d(ρuA)/dt = -A · f · ρ|u|u / (2D)
        if apply_friction:
            mu = _dynamic_viscosity_air(T)
            Re = rho * abs(u) * D / max(mu, 1e-20)
            f = _friction_factor_blasius(Re)
            # Implicit-in-|u| for stability at low Mach: treat |u| as the
            # pre-step magnitude. Explicit Euler is OK if Δt is CFL-bounded.
            dmom_A_dt = -A * f * rho * abs(u) * u / (2.0 * D)
            q[i, 1] += dt * dmom_A_dt
            # Audit 2026-05-19: Removed `q[i,2] += dt * dmom_A_dt * u`.
            # Adiabatic wall friction is internal dissipation: the lost
            # kinetic energy becomes internal energy of the same gas
            # parcel (Fanno flow has constant stagnation enthalpy
            # h_0 = h + u²/2). Total energy E is conserved by friction
            # alone; only wall heat transfer below removes E. V1's MOC
            # solver does this correctly via the entropy parameter; the
            # comment claiming "consistency with V1" for the subtraction
            # was factually wrong. Reference: Toro 2009 §1.2.2,
            # LeVeque §14.6, Anderson "Modern Compressible Flow" §6.4.
            # Revert: add back `q[i, 2] += dt * dmom_A_dt * u`.

        # Wall heat transfer: d(EA)/dt = -h · P_w · (T − T_wall)
        if apply_heat:
            mu = _dynamic_viscosity_air(T)
            Re = rho * abs(u) * D / max(mu, 1e-20)
            Nu = _nusselt_dittus_boelter(Re)
            k = _thermal_conductivity_air(T)
            # Forced-convection h; for still gas add a natural-convection
            # floor so a quiescent hot pipe still cools. Use h_floor from
            # conduction-only limit: Nu≈1, so h_floor ≈ k/D.
            h_forced = Nu * k / D
            h_floor = k / D
            h = max(h_forced, h_floor)
            P_w = np.pi * D
            dE_A_dt = -h * P_w * (T - T_wall)
            q[i, 2] += dt * dE_A_dt


def strang_split_step(
    q: np.ndarray, area: np.ndarray, area_f: np.ndarray, hyd_D: np.ndarray,
    dx: float, dt: float, gamma: float, R_gas: float, T_wall: float,
    n_ghost: int, limiter: int,
    apply_friction: bool, apply_heat: bool,
    w: np.ndarray, slopes: np.ndarray,
    wL: np.ndarray, wR: np.ndarray, flux: np.ndarray,
):
    """Second-order Strang-split step: source(dt/2) · hyperbolic(dt) · source(dt/2).

    Regular Python wrapper that calls two @njit kernels in sequence. The
    per-step overhead is Python function-call cost (a few microseconds),
    which is negligible compared to the per-cell work inside the kernels
    for typical grids (≥ 50 cells per pipe).
    """
    # Source: dt/2
    apply_sources(q, area, hyd_D, 0.5 * dt, gamma, R_gas, T_wall, n_ghost,
                  apply_friction, apply_heat)
    # Hyperbolic: dt
    muscl_hancock_step(q, area, area_f, dx, dt, gamma, n_ghost, limiter,
                      w, slopes, wL, wR, flux)
    # Source: dt/2
    apply_sources(q, area, hyd_D, 0.5 * dt, gamma, R_gas, T_wall, n_ghost,
                  apply_friction, apply_heat)


from solver.muscl import muscl_hancock_step  # noqa: E402
