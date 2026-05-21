"""Valve lift profile, Cd(L/D) lookup, effective flow area.

Source: 1d/engine_simulator/engine/valve.py  (read-only V1 file)
Copy date: 2026-04-13

Changes vs V1:
- Ported to @njit free functions. The Valve class is replaced by a small
  dataclass of geometry + a flat array for the Cd table, with @njit
  lookup functions.
- The 2007 CBR600RR Cd tables from cbr600rr.json are preserved verbatim
  (intake peak 0.57, exhaust peak 0.55 from V1 measurements).

Valve lift (sin² profile) — identical to V1. This is acknowledged in the
Phase 1 audit as gentler than real cam ramps; a more accurate profile
would be a measured lift curve. That is a future upgrade; for V2 we use
the same sin² for apples-to-apples comparison with V1.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Tuple

import numpy as np
from numba import njit


@dataclass
class ValveParams:
    diameter: float             # m, port/valve diameter
    max_lift: float             # m
    open_angle_deg: float       # deg, cam event open
    close_angle_deg: float      # deg, cam event close
    seat_angle_deg: float = 45.0
    n_valves: int = 2
    # Cd(L/D) table: arrays of the same length
    ld_table: np.ndarray = None  # shape (K,)
    cd_table: np.ndarray = None  # shape (K,)

    @property
    def duration_deg(self) -> float:
        return self.close_angle_deg - self.open_angle_deg

    @property
    def port_area(self) -> float:
        return 0.25 * np.pi * self.diameter ** 2


# ---------------------------------------------------------------------------
# @njit helpers — take flat arrays for Cd table and valve geometry scalars
# ---------------------------------------------------------------------------

@njit(cache=True, fastmath=False)
def valve_lift(
    theta_local_deg: float,
    open_angle: float, close_angle: float, max_lift: float,
) -> float:
    """sin² lift profile: L(θ) = max_lift · sin²(π · (θ − θ_open)/duration)."""
    theta = theta_local_deg % 720.0
    duration = close_angle - open_angle
    if open_angle < close_angle:
        if theta < open_angle or theta > close_angle:
            return 0.0
        phase = np.pi * (theta - open_angle) / duration
    else:
        # Wrap-around (valve event straddles 720→0)
        if theta >= open_angle:
            phase = np.pi * (theta - open_angle) / duration
        elif theta <= close_angle:
            phase = np.pi * (theta + 720.0 - open_angle) / duration
        else:
            return 0.0
    if phase < 0.0 or phase > np.pi:
        return 0.0
    s = np.sin(phase)
    return max_lift * s * s


@njit(cache=True, fastmath=False)
def valve_Cd(lift: float, diameter: float,
             ld_table: np.ndarray, cd_table: np.ndarray) -> float:
    """Linear interpolation on the Cd(L/D) table; below table[0] linear to 0."""
    if lift <= 0.0:
        return 0.0
    ld = lift / diameter
    if ld <= ld_table[0]:
        return cd_table[0] * (ld / ld_table[0])
    if ld >= ld_table[-1]:
        return cd_table[-1]
    for k in range(ld_table.shape[0] - 1):
        if ld_table[k] <= ld <= ld_table[k + 1]:
            frac = (ld - ld_table[k]) / (ld_table[k + 1] - ld_table[k])
            return cd_table[k] + frac * (cd_table[k + 1] - cd_table[k])
    return cd_table[-1]


@njit(cache=True, fastmath=False)
def valve_reference_area(lift: float, diameter: float, seat_angle_rad: float) -> float:
    """Reference flow area: low-lift curtain, medium-lift full curtain,
    high-lift port-limited (Heywood Ch.6)."""
    if lift <= 0.0:
        return 0.0
    ld = lift / diameter
    port_area = 0.25 * np.pi * diameter * diameter
    if ld < 0.125:
        return np.pi * diameter * lift * np.cos(seat_angle_rad)
    if ld < 0.25:
        return np.pi * diameter * lift
    return port_area


@njit(cache=True, fastmath=False)
def valve_effective_area(
    theta_local_deg: float,
    open_angle: float, close_angle: float, max_lift: float,
    diameter: float, seat_angle_rad: float, n_valves: int,
    ld_table: np.ndarray, cd_table: np.ndarray,
) -> float:
    """A_eff = n_valves · Cd(L/D) · A_ref(L)."""
    L = valve_lift(theta_local_deg, open_angle, close_angle, max_lift)
    if L <= 0.0:
        return 0.0
    Cd = valve_Cd(L, diameter, ld_table, cd_table)
    A_ref = valve_reference_area(L, diameter, seat_angle_rad)
    return n_valves * Cd * A_ref


# Default tables from V1 cbr600rr.json (2007 measured)
INTAKE_LD_TABLE = np.array([0.05, 0.10, 0.15, 0.20, 0.25, 0.30])
INTAKE_CD_TABLE = np.array([0.19, 0.38, 0.494, 0.551, 0.57, 0.57])
EXHAUST_LD_TABLE = np.array([0.05, 0.10, 0.15, 0.20, 0.25, 0.30])
EXHAUST_CD_TABLE = np.array([0.171, 0.333, 0.456, 0.523, 0.542, 0.551])
