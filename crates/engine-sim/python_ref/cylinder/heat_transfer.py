"""Woschni in-cylinder heat transfer correlation.

Source: 1d/engine_simulator/engine/heat_transfer.py  (read-only V1 file)
Copy date: 2026-04-13

Changes vs V1:
- Ported to @njit free functions with an explicit per-cylinder params
  struct. V1's class held reference-state state; V2 passes references
  explicitly so the function is pure.
- V1 coefficients preserved unchanged (C1 for gas-exchange, compression,
  combustion phases and C2 for combustion, from Woschni 1967 via Heywood).
  These are physics-empirical, not numerical fudges, so they stay.

Woschni:
    w = C1 · S̄_p + C2 · (V_d · T_ref)/(p_ref · V_ref) · max(p − p_mot, 0)
    h_c = 3.26 · B^{-0.2} · p_kPa^{0.8} · T^{-0.53} · w^{0.8}
    dQ_ht/dt = h_c · A_surface · (T_gas − T_wall)

T_wall is chosen PHYSICALLY (per Phase 1 audit recommendation):
    piston + head + liner composite ≈ 450 K at WOT for the CBR600RR stroke.
The per-pipe wall temperatures (runners, primaries, secondaries, collector)
are separate, picked from physical measurements at WOT:
    intake runners    ≈ 325 K
    exhaust primaries ≈ 1000 K (up from V1's 650 K — V1 ran too cool to
                                compensate for entropy-BC cold-pipe gas)
    exhaust secondaries ≈ 800 K
    exhaust collector  ≈ 700 K
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numba import njit


@dataclass
class WoschniParams:
    bore: float                         # m
    stroke: float                       # m
    T_wall: float = 450.0               # K, cylinder composite
    C1_gas_exchange: float = 6.18       # Woschni 1967
    C1_compression: float = 2.28
    C1_combustion: float = 2.28
    C2_combustion: float = 3.24e-3


@njit(cache=True, fastmath=False)
def mean_piston_speed(stroke: float, rpm: float) -> float:
    """S̄_p = 2 · S · N / 60 (m/s)."""
    return 2.0 * stroke * rpm / 60.0


@njit(cache=True, fastmath=False)
def motored_pressure(V: float, p_ref: float, V_ref: float, gamma_poly: float = 1.35) -> float:
    """Polytropic motored pressure from an IVC reference state."""
    if p_ref <= 0.0 or V <= 0.0:
        return 0.0
    return p_ref * (V_ref / V) ** gamma_poly


@njit(cache=True, fastmath=False)
def _characteristic_velocity(
    rpm: float, p: float, V: float, V_d: float,
    phase: int,               # 0 = gas_exchange, 1 = compression, 2 = combustion
    p_ref: float, T_ref: float, V_ref: float,
    stroke: float,
    C1_gx: float, C1_co: float, C1_cb: float, C2_cb: float,
    gamma_poly: float = 1.35,
) -> float:
    Sp = mean_piston_speed(stroke, rpm)
    if phase == 0:
        return C1_gx * Sp
    # Compression or combustion: need motored pressure
    if phase == 1:
        return C1_co * Sp
    # Combustion / expansion
    if p_ref <= 0.0 or V_ref <= 0.0:
        return C1_cb * Sp
    p_mot = motored_pressure(V, p_ref, V_ref, gamma_poly)
    bump = p - p_mot
    if bump < 0.0:
        bump = 0.0
    pressure_term = C2_cb * (V_d * T_ref) / (p_ref * V_ref) * bump
    return C1_cb * Sp + pressure_term


@njit(cache=True, fastmath=False)
def woschni_h(
    p: float, T: float, rpm: float, V: float, V_d: float,
    phase: int, p_ref: float, T_ref: float, V_ref: float,
    bore: float, stroke: float,
    C1_gx: float, C1_co: float, C1_cb: float, C2_cb: float,
) -> float:
    """h_c (W/m²/K): Woschni correlation.

    h_c = 3.26 · B^{-0.2} · p_kPa^{0.8} · T^{-0.53} · w^{0.8}
    """
    w = _characteristic_velocity(
        rpm, p, V, V_d, phase, p_ref, T_ref, V_ref, stroke,
        C1_gx, C1_co, C1_cb, C2_cb,
    )
    if w < 0.1:
        w = 0.1
    p_kPa = p / 1000.0
    T_safe = T if T > 100.0 else 100.0
    return 3.26 * bore ** (-0.2) * p_kPa ** 0.8 * T_safe ** (-0.53) * w ** 0.8


@njit(cache=True, fastmath=False)
def woschni_dQdt(
    p: float, T: float, rpm: float, V: float, V_d: float,
    A_surface: float, T_wall: float,
    phase: int, p_ref: float, T_ref: float, V_ref: float,
    bore: float, stroke: float,
    C1_gx: float, C1_co: float, C1_cb: float, C2_cb: float,
) -> float:
    h = woschni_h(
        p, T, rpm, V, V_d, phase, p_ref, T_ref, V_ref,
        bore, stroke, C1_gx, C1_co, C1_cb, C2_cb,
    )
    return h * A_surface * (T - T_wall)
