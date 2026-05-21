"""Wiebe combustion model.

Source: 1d/engine_simulator/engine/combustion.py  (read-only V1 file)
Copy date: 2026-04-13

Changes vs V1:
- Ported to @njit free functions. The WiebeCombustion class is replaced by
  pure functions plus a small dataclass for per-cylinder parameters.
- Removed V1's RPM-dependent combustion-efficiency and duration ramps and
  the 0.88 cap. V2 treats η_comb as a fixed physics parameter in [0,1];
  if observed VE/IMEP undershoots at particular RPMs, the fix is elsewhere
  (wave transport, valve BC, geometry), not a cap on Wiebe.

Wiebe:  x_b(θ) = 1 − exp[−a · ((θ − θ_start) / Δθ)^(m+1)]
    dx_b/dθ = a · (m+1) / Δθ · τ^m · exp[−a · τ^(m+1)]
    where τ = (θ − θ_start) / Δθ  in [0, 1].

Canonical form: θ_start = -spark_advance + ignition_delay. A local angle
near 720° is mapped to a small negative value when the combustion straddles
TDC (θ_start < 0).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numba import njit


@dataclass
class WiebeParams:
    a: float = 5.0                     # V1 default
    m: float = 2.0                     # V1 default
    duration_deg: float = 50.0         # V1 default for CBR600RR config
    spark_advance_deg: float = 25.0    # V1 default
    ignition_delay_deg: float = 7.0    # V1 default
    eta_comb: float = 0.96             # base combustion efficiency (Wiebe model's
                                       # theoretical maximum if everything were perfect)
    q_lhv: float = 44.0e6             # J/kg, gasoline
    afr_target: float = 13.1          # slightly rich for power

    # V2 two-segment efficiency-factor ramp (Phase F4 v3, corrected).
    #
    # Structure: actual_eta_comb = base_efficiency × factor(RPM).
    # Shape inherited from V1 (two-segment, knee at 6000 RPM):
    #   steep below 6000 (poor low-RPM combustion: low turbulence,
    #   long burn duration, wall quench) + gentle above 6000
    #   (approaching design-point efficiency).
    #
    # Factor MAGNITUDES are V2-appropriate, NOT V1's values:
    #   V1 used factor cap = 0.88 (→ peak eta = 0.845) to compensate
    #   for V1's non-conservative MOC scheme's mass leak that
    #   artificially inflated cylinder charge at high RPM.
    #   V2 is conservation-correct to machine precision and does NOT
    #   need V1's peak derating. V2's Phase E demonstrated +0.7%
    #   peak-power match vs SDM25 dyno at eta_comb = 0.96 constant
    #   (first-principles, not fitted), so the peak factor is 1.00.
    #
    # The low-RPM factors (0.70, 0.85) are calibrated against the
    # observed Phase E over-prediction pattern (+23 Nm mean in the
    # 4000-5700 RPM band). These are engineering estimates within the
    # physically-plausible range, not optimization results.
    #
    # Iteration history:
    #   v1 (rejected): 0.55 → 0.96 single-segment. Implicitly fitted.
    #   v2 (rejected): V1 exact 0.55/0.80/0.88 × 0.96. -17% peak.
    #   v3 (this): V1 shape, V2 magnitudes 0.70/0.85/1.00 × 0.96.
    # Audit 2026-05-19: F4 ramp neutered (all factors = 1.0). The Phase F4
    # calibration was found to compensate for upstream physics bugs
    # (gamma_burned slope, friction energy double-removal, restrictor BC).
    # Fixing those bugs is preferable to band-aid calibration of eta_comb.
    # Revert: restore 0.70 / 0.85 / 1.00 to reactivate the ramp.
    _factor_rpm_lo: float = 3500.0
    _factor_rpm_knee: float = 6000.0
    _factor_rpm_hi: float = 10500.0
    _factor_lo: float = 1.00           # was 0.70 (F4 v3)
    _factor_knee: float = 1.00         # was 0.85 (F4 v3)
    _factor_hi: float = 1.00           # was 1.00 (F4 v3, unchanged)

    def eta_comb_at_rpm(self, rpm: float) -> float:
        """RPM-dependent combustion efficiency with V2-appropriate
        factor values applied to the base eta_comb.

        Two-segment piecewise linear on the efficiency_factor:
          RPM <= 3500:          factor = 0.70
          3500 < RPM <= 6000:   linear 0.70 -> 0.85  (steep segment)
          6000 < RPM <= 10500:  linear 0.85 -> 1.00  (gentle segment)
          RPM > 10500:          factor = 1.00  (no derating at peak)

        Resulting actual_eta_comb = base (0.96) x factor:
          3500 RPM:  0.96 x 0.70 = 0.672
          6000 RPM:  0.96 x 0.85 = 0.816
          10500 RPM: 0.96 x 1.00 = 0.960
          13500 RPM: 0.96 x 1.00 = 0.960

        Shape from V1 orchestrator.py:267-276. Factor magnitudes
        calibrated for V2's conservation-correct physics (V1's 0.88
        cap compensated for V1's mass leak; V2 does not have that leak).
        Reference: Heywood 1988 S9 on combustion efficiency correlations.
        """
        if rpm <= self._factor_rpm_lo:
            factor = self._factor_lo
        elif rpm <= self._factor_rpm_knee:
            frac = (rpm - self._factor_rpm_lo) / (self._factor_rpm_knee - self._factor_rpm_lo)
            factor = self._factor_lo + frac * (self._factor_knee - self._factor_lo)
        elif rpm <= self._factor_rpm_hi:
            frac = (rpm - self._factor_rpm_knee) / (self._factor_rpm_hi - self._factor_rpm_knee)
            factor = self._factor_knee + frac * (self._factor_hi - self._factor_knee)
        else:
            factor = self._factor_hi
        return self.eta_comb * factor

    @property
    def theta_start(self) -> float:
        return -self.spark_advance_deg + self.ignition_delay_deg

    @property
    def theta_end(self) -> float:
        return self.theta_start + self.duration_deg


@njit(cache=True, fastmath=False)
def _to_combustion_angle(theta_local_deg: float, theta_start: float) -> float:
    """Map a cylinder-local crank angle in [0, 720) to the canonical
    combustion coordinate (negative = BTDC)."""
    t = theta_local_deg % 720.0
    if theta_start < 0.0 and t > 360.0:
        t -= 720.0
    return t


@njit(cache=True, fastmath=False)
def wiebe_xb(theta_local_deg: float, a: float, m: float,
             theta_start: float, duration: float) -> float:
    """Mass fraction burned x_b at the given local crank angle."""
    t = _to_combustion_angle(theta_local_deg, theta_start)
    if t < theta_start:
        return 0.0
    if t > theta_start + duration:
        return 1.0
    tau = (t - theta_start) / duration
    if tau < 0.0:
        tau = 0.0
    elif tau > 1.0:
        tau = 1.0
    return 1.0 - np.exp(-a * tau ** (m + 1.0))


@njit(cache=True, fastmath=False)
def wiebe_burn_rate(theta_local_deg: float, a: float, m: float,
                    theta_start: float, duration: float) -> float:
    """dx_b/dθ (per degree) at the given local crank angle."""
    t = _to_combustion_angle(theta_local_deg, theta_start)
    if t < theta_start or t > theta_start + duration:
        return 0.0
    tau = (t - theta_start) / duration
    if tau < 1e-12:
        tau = 1e-12
    if tau > 1.0 - 1e-12:
        tau = 1.0 - 1e-12
    return (a * (m + 1.0) / duration) * tau ** m * np.exp(-a * tau ** (m + 1.0))


@njit(cache=True, fastmath=False)
def is_combusting(theta_local_deg: float, theta_start: float, duration: float) -> bool:
    t = _to_combustion_angle(theta_local_deg, theta_start)
    return (theta_start <= t) and (t <= theta_start + duration)
