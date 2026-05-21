"""0D cylinder thermodynamic integrator.

Source: 1d/engine_simulator/engine/cylinder.py  (read-only V1 file)
Copy date: 2026-04-13

Changes vs V1:
- Python-level class (not @njit) because advance() is called once per time
  step per cylinder, not per cell, and it calls @njit sub-models (Wiebe,
  Woschni, gas props). Per-call overhead is negligible.
- Interface change: instead of pulling MOC characteristic values from a
  pipe, V2 receives (ṁ_in, ṁ_out) fluxes directly from the valve ghost-cell
  BCs, which in turn got those fluxes from the HLLC flux at the pipe
  boundary face during the previous MUSCL-Hancock step. This is the
  conservative coupling: one number for mass flow, shared between pipe
  and cylinder, automatically consistent.
- No 0.88 Wiebe cap. η_comb is a named parameter, default 0.96 (physics).
- No RPM-dependent ramps on duration or efficiency. Those were V1 fudges
  to mask the wave-speed and entropy BC errors; V2 shouldn't need them.

Integration scheme:
- Gas exchange (any valve open): forward Euler on (p, m) using the first
  law with flow enthalpy terms, then T from ideal gas.
- Closed cycle (both valves closed): RK4 on p(θ) using
      dp/dθ = -γ·(p/V)·dV/dθ + (γ-1)/V·(dQ_comb/dθ - dQ_ht/dθ)
  then T from ideal gas with m held constant.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from cylinder.combustion import (
    WiebeParams, wiebe_xb, wiebe_burn_rate, is_combusting,
)
from cylinder.gas_properties import gamma_mixture, R_mixture, R_AIR
from cylinder.geometry import (
    cylinder_volume, cylinder_dVdtheta, cylinder_surface_area,
)
from cylinder.heat_transfer import WoschniParams, woschni_h
from cylinder.valve import ValveParams


@dataclass
class CylinderGeom:
    bore: float
    stroke: float
    con_rod: float
    CR: float
    n_intake_valves: int = 2
    n_exhaust_valves: int = 2

    @property
    def V_d(self) -> float:
        return 0.25 * np.pi * self.bore ** 2 * self.stroke

    @property
    def V_c(self) -> float:
        return self.V_d / (self.CR - 1.0)


@dataclass
class CylinderState:
    """Time-varying cylinder state."""
    p: float = 101325.0          # Pa
    T: float = 300.0             # K
    m: float = 0.0               # kg, total gas
    x_b: float = 0.0             # burned mass fraction
    m_fuel: float = 0.0          # kg, trapped fuel (set at IVC)
    # Per-cycle accumulators
    m_intake_total: float = 0.0
    m_exhaust_total: float = 0.0
    work_cycle: float = 0.0
    p_at_IVC: float = 101325.0
    T_at_IVC: float = 300.0
    V_at_IVC: float = 0.0
    # External-flux inputs (set by valve BCs each step)
    mdot_intake: float = 0.0      # kg/s, into cylinder (positive) from intake pipe
    mdot_exhaust: float = 0.0     # kg/s, out of cylinder (positive) into exhaust pipe
    T_intake: float = 300.0       # K, gas T flowing in through intake valve (from pipe)
    T_exhaust: float = 1000.0     # K, gas T in exhaust pipe at valve face (used when
                                  # mdot_exhaust < 0 = blowback from pipe into cylinder)
    # Residual-gas tracking (audit 2026-05-20). m_residual is the cylinder
    # mass sampled at EVC — the burned-products mass that remains trapped
    # after blowdown + overlap scavenging, before fresh charge is inducted
    # during the post-EVC portion of the intake stroke. Replaces the
    # incorrect `m_fuel = m_trapped / (1+AFR)` formula which counted the
    # residual as fuelable fresh charge.
    m_residual: float = 0.0       # kg, burned-gas residual at EVC
    p_at_EVC: float = 101325.0    # Pa, diagnostic
    T_at_EVC: float = 1000.0      # K, diagnostic
    # f_residual_at_IVC is the well-defined residual fraction sampled at
    # IVC (when both m_residual and m_at_IVC are physically meaningful).
    # Averaging m_residual/m across all 4 cylinders at an arbitrary global
    # crank-time gives a misleading value because cylinders are at different
    # phases — a cylinder at TDC overlap has m ≈ m_residual → ratio ≈ 1.
    f_residual_at_IVC: float = 0.0
    m_at_IVC: float = 0.0         # kg, trapped mass at IVC (diagnostic)
    # Cycle tracking
    phase_offset_deg: float = 0.0


class CylinderModel:
    """One cylinder: integrate (p, T, m, x_b) given per-step valve fluxes."""

    def __init__(
        self,
        geom: CylinderGeom,
        wiebe: WiebeParams,
        woschni: WoschniParams,
        intake_valve: ValveParams,
        exhaust_valve: ValveParams,
        phase_offset_deg: float = 0.0,
        enable_residual_tracking: bool = False,
    ):
        self.geom = geom
        self.wiebe = wiebe
        self.woschni = woschni
        self.intake_valve = intake_valve
        self.exhaust_valve = exhaust_valve
        self.state = CylinderState(phase_offset_deg=phase_offset_deg)
        # Audit 2026-05-20 Fix 18: residual-gas tracking. Off by default.
        # When True, sample m at EVC (= residual burned mass), set
        # m_fuel from fresh charge only, and seed x_b with the residual
        # fraction at IVC. Tested on SDM25+SDM26 sweeps fix18/fix18b;
        # didn't improve dyno match because the model's residual fraction
        # is ~0.02-0.04 across RPM (much smaller than literature 0.04-0.12),
        # so the fueling correction is tiny. See findings doc for detail.
        self.enable_residual_tracking = enable_residual_tracking

    # -------- helpers --------
    def local_theta(self, theta_global_deg: float) -> float:
        return (theta_global_deg - self.state.phase_offset_deg) % 720.0

    def V(self, theta_local_deg: float) -> float:
        g = self.geom
        return cylinder_volume(theta_local_deg, g.bore, g.stroke, g.con_rod, g.CR)

    def dVdtheta(self, theta_local_deg: float) -> float:
        g = self.geom
        return cylinder_dVdtheta(theta_local_deg, g.bore, g.stroke, g.con_rod)

    def initialize(self, p: float = 101325.0, T: float = 300.0,
                   theta_global_deg: float = 0.0) -> None:
        st = self.state
        st.p = p
        st.T = T
        theta_local = self.local_theta(theta_global_deg)
        V0 = self.V(theta_local)
        R = R_mixture(0.0)
        st.m = p * V0 / (R * T)
        st.x_b = 0.0
        st.m_fuel = 0.0
        st.m_intake_total = 0.0
        st.m_exhaust_total = 0.0
        st.work_cycle = 0.0
        st.p_at_IVC = p
        st.T_at_IVC = T
        st.V_at_IVC = V0
        st.m_residual = 0.0
        st.p_at_EVC = p
        st.T_at_EVC = T

    # -------- phase logic --------
    def _phase_code(self, theta_local_deg: float) -> int:
        """0 = gas_exchange, 1 = compression, 2 = combustion/expansion."""
        iv_open = _valve_is_open(theta_local_deg, self.intake_valve)
        ev_open = _valve_is_open(theta_local_deg, self.exhaust_valve)
        if iv_open or ev_open:
            return 0
        if is_combusting(theta_local_deg, self.wiebe.theta_start, self.wiebe.duration_deg):
            return 2
        # Between IVC and TDC firing: compression
        ivc = self.intake_valve.close_angle_deg % 720.0
        if ivc < theta_local_deg < 720.0:
            return 1
        return 2  # post-combustion expansion

    # -------- advance --------
    def advance(self, theta_global_deg: float, dtheta_deg: float, rpm: float,
                dt: float) -> None:
        """Advance cylinder state by dtheta degrees (or equivalently dt).

        Pre-condition: the caller has set self.state.mdot_intake and
        self.state.mdot_exhaust from the pipe-side boundary fluxes.
        """
        st = self.state
        g = self.geom
        w = self.wiebe
        ws = self.woschni

        theta_local = self.local_theta(theta_global_deg)
        omega = 2.0 * np.pi * rpm / 60.0 if rpm > 0 else 1.0

        gamma = gamma_mixture(st.T, st.x_b)
        R_gas = R_mixture(st.x_b)

        V = self.V(theta_local)
        dVdt = self.dVdtheta(theta_local) * (180.0 / np.pi) * omega  # m³/s

        phase = self._phase_code(theta_local)

        # Heat transfer
        A_surf = cylinder_surface_area(theta_local, g.bore, g.stroke, g.con_rod, g.CR)
        p_ref = st.p_at_IVC
        T_ref = st.T_at_IVC
        V_ref = st.V_at_IVC if st.V_at_IVC > 0 else V
        h_c = woschni_h(
            st.p, st.T, rpm, V, g.V_d,
            phase if phase != 1 else 1,  # pass through phase code
            p_ref, T_ref, V_ref,
            ws.bore, ws.stroke,
            ws.C1_gas_exchange, ws.C1_compression,
            ws.C1_combustion, ws.C2_combustion,
        )
        dQht_dt = h_c * A_surf * (st.T - ws.T_wall)

        # Combustion heat release (Phase F4: RPM-dependent eta_comb)
        eta = w.eta_comb_at_rpm(rpm)
        dQcomb_dt = 0.0
        if is_combusting(theta_local, w.theta_start, w.duration_deg) and st.m_fuel > 0.0:
            dxb_dtheta = wiebe_burn_rate(theta_local, w.a, w.m, w.theta_start, w.duration_deg)
            dxb_dt = dxb_dtheta * 180.0 / np.pi * omega  # 1/s
            dQcomb_dt = eta * st.m_fuel * w.q_lhv * dxb_dt
            st.x_b = wiebe_xb(theta_local, w.a, w.m, w.theta_start, w.duration_deg)

        if phase == 0:
            # Open-cycle (gas exchange): Euler on p, m with flow enthalpy.
            #
            # Audit 2026-05-19: branch on flow direction. Gas flowing INTO
            # the cylinder carries the upstream-side enthalpy; gas flowing
            # OUT carries cylinder enthalpy. Original code used T_pipe for
            # intake and T_cyl for exhaust unconditionally, which is wrong
            # during pressure-wave-driven backflow (e.g., overlap blowback
            # at high RPM where intake reverse-flow can be substantial).
            # Revert: set T_eff_in = T_intake, T_eff_out = T (no branching).
            mdot_in = st.mdot_intake
            mdot_out = st.mdot_exhaust
            T_eff_in = st.T_intake if mdot_in >= 0.0 else st.T
            T_eff_out = st.T if mdot_out >= 0.0 else st.T_exhaust
            if V > 1e-20:
                dp_dt = (1.0 / V) * (
                    -gamma * st.p * dVdt
                    + (gamma - 1.0) * (dQcomb_dt - dQht_dt)
                    + gamma * R_gas * T_eff_in * mdot_in
                    - gamma * R_gas * T_eff_out * mdot_out
                )
            else:
                dp_dt = 0.0
            dm_dt = mdot_in - mdot_out
            if st.m > 1e-10:
                dT_dt = st.T * (dp_dt / max(st.p, 1.0) + dVdt / V - dm_dt / st.m)
            else:
                dT_dt = 0.0
            st.p += dp_dt * dt
            st.m += dm_dt * dt
            st.T += dT_dt * dt
            st.m_intake_total += mdot_in * dt
            st.m_exhaust_total += mdot_out * dt
        else:
            # Closed cycle: RK4 on p(θ). m is conserved; T from ideal gas.
            dth_rad = np.radians(dtheta_deg)
            th0 = theta_local

            def dpdth(p_local: float, th: float) -> float:
                Vl = self.V(th)
                dVl_dth = self.dVdtheta(th)  # per degree
                dVl_dth_rad = dVl_dth * (180.0 / np.pi)  # per radian
                T_local = (p_local * Vl) / (st.m * R_gas) if st.m > 1e-10 else st.T
                # Heat transfer at this local state
                As = cylinder_surface_area(th, g.bore, g.stroke, g.con_rod, g.CR)
                h_local = woschni_h(
                    p_local, T_local, rpm, Vl, g.V_d, phase,
                    p_ref, T_ref, V_ref,
                    ws.bore, ws.stroke,
                    ws.C1_gas_exchange, ws.C1_compression,
                    ws.C1_combustion, ws.C2_combustion,
                )
                dQht = h_local * As * (T_local - ws.T_wall) / max(omega, 1.0)  # J/rad
                dQcomb_local = 0.0
                if is_combusting(th, w.theta_start, w.duration_deg) and st.m_fuel > 0.0:
                    dxb_dth = wiebe_burn_rate(th, w.a, w.m, w.theta_start, w.duration_deg)
                    # dxb per degree → per radian
                    dQcomb_local = eta * st.m_fuel * w.q_lhv * dxb_dth * (180.0 / np.pi)
                if Vl < 1e-20:
                    return 0.0
                return -gamma * (p_local / Vl) * dVl_dth_rad + (gamma - 1.0) / Vl * (dQcomb_local - dQht)

            k1 = dpdth(st.p, th0)
            k2 = dpdth(st.p + 0.5 * dth_rad * k1, th0 + 0.5 * dtheta_deg)
            k3 = dpdth(st.p + 0.5 * dth_rad * k2, th0 + 0.5 * dtheta_deg)
            k4 = dpdth(st.p + dth_rad * k3, th0 + dtheta_deg)
            st.p += dth_rad / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4)
            # m unchanged in closed cycle
            # T from ideal gas
            theta_new = (theta_local + dtheta_deg) % 720.0
            V_new = self.V(theta_new)
            if st.m > 1e-10:
                st.T = st.p * V_new / (st.m * R_gas)
            st.T = max(st.T, 100.0)
            st.p = max(st.p, 100.0)

        # Work accumulator
        st.work_cycle += st.p * dVdt * dt

        # EVC bookkeeping (audit 2026-05-20 residual-gas tracking, gated).
        # At the instant the exhaust valve closes, whatever mass is in the
        # cylinder is the burned-gas residual that will be trapped this
        # cycle. PARKED OFF by default — see SDM26Config.enable_residual_tracking.
        evc = self.exhaust_valve.close_angle_deg % 720.0
        if self.enable_residual_tracking and theta_local <= evc < (theta_local + dtheta_deg):
            st.m_residual = st.m
            st.p_at_EVC = st.p
            st.T_at_EVC = st.T

        # IVC bookkeeping: set reference state and trapped fuel mass.
        #
        # Audit 2026-05-20 (gated): when enable_residual_tracking=True, the
        # fuel-mass formula uses FRESH CHARGE only (m_trapped − m_residual)
        # / (1+AFR), and x_b is seeded with m_residual/m. With the flag
        # off (default), the original formula m_trapped / (1+AFR) is used
        # and x_b is reset to 0.0 — preserving audit-2026-05-19 baseline
        # behavior.
        ivc = self.intake_valve.close_angle_deg % 720.0
        if theta_local <= ivc < (theta_local + dtheta_deg):
            st.p_at_IVC = st.p
            st.T_at_IVC = st.T
            st.V_at_IVC = V
            st.m_at_IVC = st.m
            if self.enable_residual_tracking:
                m_fresh = max(st.m - st.m_residual, 0.0)
                st.m_fuel = m_fresh / (1.0 + w.afr_target)
                if st.m > 1e-12:
                    st.x_b = min(max(st.m_residual / st.m, 0.0), 1.0)
                    st.f_residual_at_IVC = st.x_b
                else:
                    st.x_b = 0.0
                    st.f_residual_at_IVC = 0.0
            else:
                # Pre-2026-05-20 baseline behavior.
                st.m_fuel = st.m / (1.0 + w.afr_target)
                st.x_b = 0.0
                st.f_residual_at_IVC = 0.0


def _valve_is_open(theta_local_deg: float, vp: ValveParams) -> bool:
    theta = theta_local_deg % 720.0
    if vp.open_angle_deg < vp.close_angle_deg:
        return vp.open_angle_deg <= theta <= vp.close_angle_deg
    # wrap-around
    return (theta >= vp.open_angle_deg) or (theta <= vp.close_angle_deg)
