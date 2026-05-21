"""Capture deterministic kernel outputs from the pinned Python tree into
JSON fixtures the Rust port can verify against.

Run from `python_ref/`:

    python scripts/capture_goldens.py

Writes `../fixtures/parity/*.json`. Each file has the shape:

    {
        "kernel": "<name>",
        "git_sha": "<pinned 1d_v2 sha>",
        "tolerance": {"rtol": ..., "atol": ...},
        "cases": [
            {"name": "...", "inputs": {...}, "outputs": {...}},
            ...
        ]
    }

Every fixture is deterministic: no `np.random`, no time-dependent state.
A given commit of this script always emits byte-identical fixtures.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np


# --------------------------------------------------------------------
# Make `python_ref/` (the pinned 1d_v2 tree above this script) the
# import root so `from solver.hllc import ...` works even when this
# script is invoked from elsewhere.
# --------------------------------------------------------------------

REF_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REF_ROOT))

FIXTURES_DIR = REF_ROOT.parent / "fixtures" / "parity"
FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

PINNED_SHA = (REF_ROOT / "PINNED_SHA").read_text().splitlines()[0].strip()

KERNEL_TOLERANCE = {"rtol": 1e-12, "atol": 1e-14}
ARRAY_TOLERANCE = {"rtol": 1e-10, "atol": 1e-12}
ENGINE_TOLERANCE = {"rtol": 1e-6, "atol": 1e-9}


def _np_to_json(x):
    """Convert numpy scalars / arrays to JSON-friendly Python objects."""
    if isinstance(x, np.ndarray):
        return x.tolist()
    if isinstance(x, (np.floating,)):
        return float(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (list, tuple)):
        return [_np_to_json(v) for v in x]
    if isinstance(x, dict):
        return {k: _np_to_json(v) for k, v in x.items()}
    return x


def _write(name: str, cases, tolerance):
    payload = {
        "kernel": name,
        "git_sha": PINNED_SHA,
        "tolerance": tolerance,
        "cases": [_np_to_json(c) for c in cases],
    }
    path = FIXTURES_DIR / f"{name}.json"
    path.write_text(json.dumps(payload, indent=2, default=float))
    print(f"  wrote {path.relative_to(REF_ROOT.parent)}  ({len(cases)} cases)")


# ====================================================================
# cylinder/gas_properties
# ====================================================================

def capture_gas_properties():
    from cylinder.gas_properties import (
        gamma_unburned, gamma_burned, gamma_mixture, R_mixture,
        speed_of_sound, R_AIR, R_BURNED,
    )
    Ts = list(range(200, 3501, 50)) + [299.999, 300.0, 300.001, 900.0, 3000.0, 3000.001]
    cases = []
    for T in Ts:
        cases.append({
            "name": f"gamma_unburned@T={T}",
            "inputs": {"T": T},
            "outputs": {"gamma_unburned": gamma_unburned(float(T))},
        })
        cases.append({
            "name": f"gamma_burned@T={T}",
            "inputs": {"T": T},
            "outputs": {"gamma_burned": gamma_burned(float(T))},
        })
    for T in [300.0, 500.0, 1200.0, 2400.0]:
        for xb in [0.0, 0.001, 0.25, 0.5, 0.75, 0.999, 1.0]:
            cases.append({
                "name": f"gamma_mixture@T={T},xb={xb}",
                "inputs": {"T": T, "x_b": xb},
                "outputs": {"gamma_mixture": gamma_mixture(float(T), float(xb))},
            })
    for xb in [0.0, 0.1, 0.5, 0.9, 1.0]:
        cases.append({
            "name": f"R_mixture@xb={xb}",
            "inputs": {"x_b": xb},
            "outputs": {"R_mixture": R_mixture(float(xb))},
        })
    for (g, R, T) in [(1.4, 287.0, 300.0), (1.3, 295.0, 1500.0), (1.35, 290.0, 1.0)]:
        cases.append({
            "name": f"speed_of_sound@g={g},R={R},T={T}",
            "inputs": {"gamma": g, "R": R, "T": T},
            "outputs": {"a": speed_of_sound(g, R, T)},
        })
    _write("gas_properties", cases, KERNEL_TOLERANCE)


# ====================================================================
# cylinder/geometry
# ====================================================================

def capture_geometry():
    from cylinder.geometry import (
        cylinder_volume, cylinder_dVdtheta, cylinder_surface_area,
    )
    # SDM26 geometry
    B, S, L, CR = 0.067, 0.0425, 0.0963, 12.2
    thetas = np.linspace(0.0, 720.0, 181).tolist()  # every 4 deg
    out_V = [cylinder_volume(t, B, S, L, CR) for t in thetas]
    out_dV = [cylinder_dVdtheta(t, B, S, L) for t in thetas]
    out_A = [cylinder_surface_area(t, B, S, L, CR) for t in thetas]
    cases = [{
        "name": "sdm26_geometry_full_cycle",
        "inputs": {"bore": B, "stroke": S, "con_rod": L, "CR": CR, "thetas": thetas},
        "outputs": {"V": out_V, "dVdtheta": out_dV, "A_surface": out_A},
    }]
    _write("geometry", cases, KERNEL_TOLERANCE)


# ====================================================================
# cylinder/kinematics
# ====================================================================

def capture_kinematics():
    from cylinder.kinematics import omega_from_rpm, cylinder_phase_offsets
    rpms = [1000.0, 3000.0, 6000.0, 10000.0, 14000.0]
    omegas = [omega_from_rpm(r) for r in rpms]
    offsets = cylinder_phase_offsets(4, [1, 2, 4, 3], 180.0)
    cases = [
        {
            "name": "omega_from_rpm",
            "inputs": {"rpms": rpms},
            "outputs": {"omegas": omegas},
        },
        {
            "name": "phase_offsets_sdm26",
            "inputs": {"n_cyl": 4, "firing_order": [1, 2, 4, 3], "firing_interval": 180.0},
            "outputs": {"offsets": {str(k): v for k, v in offsets.items()}},
        },
    ]
    _write("kinematics", cases, KERNEL_TOLERANCE)


# ====================================================================
# cylinder/combustion
# ====================================================================

def capture_combustion():
    from cylinder.combustion import (
        WiebeParams, wiebe_xb, wiebe_burn_rate, is_combusting,
    )
    wp = WiebeParams()
    theta_start = wp.theta_start
    duration = wp.duration_deg
    # Local crank angles spanning before / during / after burn, including
    # wrap behaviour around 720°. Mix of explicit special points.
    thetas = sorted(set(
        list(np.linspace(0.0, 720.0, 145).tolist()) +
        [theta_start - 1.0, theta_start, theta_start + duration,
         theta_start + duration + 1.0, 360.0, 360.0 - 1e-9, 720.0,
         theta_start + 0.5 * duration]
    ))
    xb = [wiebe_xb(t, wp.a, wp.m, theta_start, duration) for t in thetas]
    dr = [wiebe_burn_rate(t, wp.a, wp.m, theta_start, duration) for t in thetas]
    ic = [bool(is_combusting(t, theta_start, duration)) for t in thetas]
    cases = [{
        "name": "wiebe_sweep_default",
        "inputs": {
            "a": wp.a, "m": wp.m, "duration": duration,
            "theta_start": theta_start, "thetas": thetas,
        },
        "outputs": {"xb": xb, "burn_rate": dr, "is_combusting": ic},
    }]
    # RPM-dependent eta sweep
    rpms = [2000.0, 3500.0, 4500.0, 6000.0, 8000.0, 10500.0, 12000.0]
    etas = [wp.eta_comb_at_rpm(r) for r in rpms]
    cases.append({
        "name": "eta_comb_at_rpm_default",
        "inputs": {"rpms": rpms, "base_eta": wp.eta_comb},
        "outputs": {"etas": etas},
    })
    _write("combustion", cases, KERNEL_TOLERANCE)


# ====================================================================
# cylinder/heat_transfer
# ====================================================================

def capture_heat_transfer():
    from cylinder.heat_transfer import (
        WoschniParams, woschni_h, woschni_dQdt, mean_piston_speed,
        motored_pressure,
    )
    B, S = 0.067, 0.0425
    wp = WoschniParams(bore=B, stroke=S)
    rpms = [3000.0, 6000.0, 10000.0, 14000.0]
    Sps = [mean_piston_speed(S, r) for r in rpms]
    cases = [{
        "name": "mean_piston_speed",
        "inputs": {"stroke": S, "rpms": rpms},
        "outputs": {"Sp": Sps},
    }]
    Vs = [3e-5, 5e-5, 8e-5]
    p_ref, T_ref, V_ref = 2.5e5, 380.0, 5e-5
    pm_cases = []
    for V in Vs:
        pm_cases.append({"V": V, "p_mot": motored_pressure(V, p_ref, V_ref)})
    cases.append({
        "name": "motored_pressure",
        "inputs": {"p_ref": p_ref, "V_ref": V_ref, "Vs": Vs},
        "outputs": {"items": pm_cases},
    })
    V_d = 0.25 * np.pi * B * B * S
    # Grid of woschni states
    h_cases = []
    for phase in (0, 1, 2):
        for (p, T, V) in [(1.0e5, 400.0, 6e-5), (3.0e6, 1800.0, 5e-5), (1.5e6, 1200.0, 4.5e-5)]:
            h = woschni_h(
                p, T, 8000.0, V, V_d, phase, p_ref, T_ref, V_ref,
                B, S, wp.C1_gas_exchange, wp.C1_compression,
                wp.C1_combustion, wp.C2_combustion,
            )
            dQ = woschni_dQdt(
                p, T, 8000.0, V, V_d, A_surface=0.005, T_wall=wp.T_wall,
                phase=phase, p_ref=p_ref, T_ref=T_ref, V_ref=V_ref,
                bore=B, stroke=S,
                C1_gx=wp.C1_gas_exchange, C1_co=wp.C1_compression,
                C1_cb=wp.C1_combustion, C2_cb=wp.C2_combustion,
            )
            h_cases.append({"phase": phase, "p": p, "T": T, "V": V, "h": h, "dQ": dQ})
    cases.append({
        "name": "woschni_grid",
        "inputs": {
            "p_ref": p_ref, "T_ref": T_ref, "V_ref": V_ref, "V_d": V_d,
            "bore": B, "stroke": S, "rpm": 8000.0,
            "C1_gx": wp.C1_gas_exchange, "C1_co": wp.C1_compression,
            "C1_cb": wp.C1_combustion, "C2_cb": wp.C2_combustion,
            "T_wall": wp.T_wall, "A_surface": 0.005,
        },
        "outputs": {"items": h_cases},
    })
    _write("heat_transfer", cases, KERNEL_TOLERANCE)


# ====================================================================
# cylinder/valve  (the cylinder-side lift / Cd / effective area)
# ====================================================================

def capture_valve_cyl():
    from cylinder.valve import (
        valve_lift, valve_Cd, valve_reference_area, valve_effective_area,
        INTAKE_LD_TABLE, INTAKE_CD_TABLE, EXHAUST_LD_TABLE, EXHAUST_CD_TABLE,
    )
    cases = []
    intake = dict(
        diameter=0.0275, max_lift=0.00856,
        open_angle=350.0, close_angle=585.0, seat_angle_rad=float(np.radians(45.0)),
        n_valves=2, ld_table=list(INTAKE_LD_TABLE), cd_table=list(INTAKE_CD_TABLE),
    )
    exhaust = dict(
        diameter=0.023, max_lift=0.00735,
        open_angle=140.0, close_angle=365.0, seat_angle_rad=float(np.radians(45.0)),
        n_valves=2, ld_table=list(EXHAUST_LD_TABLE), cd_table=list(EXHAUST_CD_TABLE),
    )
    thetas = list(np.linspace(0.0, 720.0, 145))
    for name, v in [("intake", intake), ("exhaust", exhaust)]:
        L = [valve_lift(t, v["open_angle"], v["close_angle"], v["max_lift"]) for t in thetas]
        Cd = [
            valve_Cd(L_i, v["diameter"],
                     np.asarray(v["ld_table"]), np.asarray(v["cd_table"]))
            for L_i in L
        ]
        A_ref = [valve_reference_area(L_i, v["diameter"], v["seat_angle_rad"]) for L_i in L]
        A_eff = [
            valve_effective_area(
                t, v["open_angle"], v["close_angle"], v["max_lift"],
                v["diameter"], v["seat_angle_rad"], v["n_valves"],
                np.asarray(v["ld_table"]), np.asarray(v["cd_table"]),
            )
            for t in thetas
        ]
        cases.append({
            "name": f"{name}_valve_sweep",
            "inputs": {"params": v, "thetas": thetas},
            "outputs": {"L": L, "Cd": Cd, "A_ref": A_ref, "A_eff": A_eff},
        })
    _write("valve_cyl", cases, KERNEL_TOLERANCE)


# ====================================================================
# solver/state
# ====================================================================

def capture_state():
    from solver.state import (
        make_pipe_state, set_uniform, set_left_right,
        primitives_array, total_mass, total_energy,
    )
    L = 0.245
    # Tapered pipe for taper coverage
    def area_fn(x):
        D = 0.038 + (0.040 - 0.038) * (x / L) if x >= 0 else 0.038
        if x >= L:
            D = 0.040
        if x < 0:
            D = 0.038
        return 0.25 * np.pi * D * D
    s = make_pipe_state(20, L, area_fn=area_fn, gamma=1.4, R_gas=287.0, wall_T=325.0)
    cases = [{
        "name": "make_pipe_state_taper",
        "inputs": {"n_cells": 20, "length": L, "D_in": 0.038, "D_out": 0.040,
                   "gamma": 1.4, "R_gas": 287.0, "wall_T": 325.0, "n_ghost": 2},
        "outputs": {"area": s.area.tolist(), "area_f": s.area_f.tolist(),
                    "dx": s.dx, "hydraulic_D": s.hydraulic_D.tolist()},
    }]
    set_uniform(s, rho=1.184, u=12.3, p=101325.0, Y=0.05)
    prim = primitives_array(s)
    cases.append({
        "name": "set_uniform_then_primitives",
        "inputs": {"rho": 1.184, "u": 12.3, "p": 101325.0, "Y": 0.05},
        "outputs": {
            "q": s.q.tolist(),
            "primitives": prim.tolist(),
            "total_mass": total_mass(s),
            "total_energy": total_energy(s),
        },
    })
    # set_left_right
    s2 = make_pipe_state(20, 1.0, area_fn=lambda x: 1.0, gamma=1.4)
    set_left_right(s2, x0=0.5,
                   rhoL=1.0, uL=0.0, pL=1.0, YL=0.0,
                   rhoR=0.125, uR=0.0, pR=0.1, YR=0.0)
    cases.append({
        "name": "set_left_right_sod",
        "inputs": {"x0": 0.5,
                   "L": [1.0, 0.0, 1.0, 0.0],
                   "R": [0.125, 0.0, 0.1, 0.0]},
        "outputs": {"q": s2.q.tolist()},
    })
    _write("state", cases, ARRAY_TOLERANCE)


# ====================================================================
# solver/hllc
# ====================================================================

def capture_hllc():
    from solver.hllc import hllc_flux, prim_to_cons, cons_to_prim, euler_flux
    cases = []
    # prim/cons round-trips
    rt = [
        (1.0, 0.0, 1.0, 0.0, 1.4),
        (1.184, 35.0, 101325.0, 0.0, 1.4),
        (0.3, -120.0, 50000.0, 0.5, 1.35),
        (5.0, 200.0, 1.0e6, 1.0, 1.3),
    ]
    for (rho, u, p, Y, g) in rt:
        c = prim_to_cons(rho, u, p, Y, g)
        b = cons_to_prim(*c, gamma=g) if False else cons_to_prim(c[0], c[1], c[2], c[3], g)
        f = euler_flux(rho, u, p, Y, g)
        cases.append({
            "name": f"prim_cons@rho={rho}",
            "inputs": {"rho": rho, "u": u, "p": p, "Y": Y, "gamma": g},
            "outputs": {"cons": list(c), "round_trip": list(b), "euler_flux": list(f)},
        })
    # HLLC Riemann problems (deterministic, hand-picked + grid)
    states = [
        # name,  L=(rho,u,p,Y), R=(rho,u,p,Y), gamma
        ("sod",        (1.0, 0.0, 1.0, 0.0),     (0.125, 0.0, 0.1, 0.0),    1.4),
        ("123",        (1.0, -2.0, 0.4, 0.0),    (1.0, 2.0, 0.4, 0.0),      1.4),
        ("strong_L",   (5.0, 100.0, 5.0e5, 0.0), (1.0, 0.0, 1.0e5, 0.0),    1.4),
        ("strong_R",   (1.0, 0.0, 1.0e5, 0.0),   (5.0, -100.0, 5.0e5, 1.0), 1.4),
        ("supersonic_R",(1.0, 800.0, 1.0e5, 0.0),(0.5, 50.0, 5.0e4, 0.0),   1.4),
        ("supersonic_L",(0.5, -50.0, 5.0e4, 0.0),(1.0, -800.0, 1.0e5, 0.0), 1.4),
        ("near_vac_R", (1.0, 0.0, 1.0e5, 0.0),   (1e-5, 0.0, 1e-2, 0.0),    1.4),
        ("contact",    (1.5, 50.0, 1.0e5, 0.0),  (0.8, 50.0, 1.0e5, 1.0),   1.4),
        ("gam135",     (1.184, 0.0, 101325.0, 0.0),(0.5,200.0,50000.0,0.5), 1.35),
    ]
    for name, L, R, g in states:
        f = hllc_flux(L[0], L[1], L[2], L[3], R[0], R[1], R[2], R[3], g)
        cases.append({
            "name": f"hllc_{name}",
            "inputs": {"L": list(L), "R": list(R), "gamma": g},
            "outputs": {"flux": list(f)},
        })
    _write("hllc", cases, KERNEL_TOLERANCE)


# ====================================================================
# solver/muscl
# ====================================================================

def capture_muscl():
    from solver.state import make_pipe_state, set_left_right
    from solver.muscl import (
        muscl_hancock_step, cfl_dt,
        LIMITER_MINMOD, LIMITER_VAN_LEER, LIMITER_SUPERBEE,
    )
    cases = []
    # Sod 1D: 100 cells, 1 step + 50 steps
    def run(n_steps, limiter, name):
        s = make_pipe_state(100, 1.0, area_fn=lambda x: 1.0, gamma=1.4)
        set_left_right(s, 0.5, 1.0, 0.0, 1.0, 0.0, 0.125, 0.0, 0.1, 0.0)
        ng = s.n_ghost
        n = s.n_total
        w = np.zeros((n, 4))
        slopes = np.zeros((n, 4))
        wL = np.zeros((n, 4))
        wR = np.zeros((n, 4))
        flux = np.zeros((n + 1, 4))
        # Set ghosts transmissive for the test.
        from bcs.simple import fill_transmissive_left, fill_transmissive_right
        for _ in range(n_steps):
            dt = cfl_dt(s.q, s.area, s.dx, 1.4, 0.85, ng)
            if dt <= 0:
                break
            fill_transmissive_left(s)
            fill_transmissive_right(s)
            muscl_hancock_step(
                s.q, s.area, s.area_f, s.dx, dt, 1.4, ng, limiter,
                w, slopes, wL, wR, flux,
            )
        cases.append({
            "name": name,
            "inputs": {
                "n_cells": 100, "length": 1.0, "n_steps": n_steps,
                "limiter": int(limiter),
                "L": [1.0, 0.0, 1.0, 0.0], "R": [0.125, 0.0, 0.1, 0.0],
            },
            "outputs": {
                "q_final": s.q.tolist(),
                "flux_final": flux.tolist(),
            },
        })
    run(1, LIMITER_MINMOD, "sod_1step_minmod")
    run(50, LIMITER_MINMOD, "sod_50step_minmod")
    run(50, LIMITER_VAN_LEER, "sod_50step_vanleer")
    run(50, LIMITER_SUPERBEE, "sod_50step_superbee")
    _write("muscl", cases, ARRAY_TOLERANCE)


# ====================================================================
# solver/sources
# ====================================================================

def capture_sources():
    from solver.state import make_pipe_state, set_uniform
    from solver.sources import apply_sources
    cases = []
    s = make_pipe_state(30, 0.5, area_fn=lambda x: 0.001, gamma=1.4,
                        R_gas=287.0, wall_T=350.0)
    set_uniform(s, rho=2.0, u=80.0, p=200000.0, Y=0.0)
    q0 = s.q.copy()
    apply_sources(s.q, s.area, s.hydraulic_D, 1e-5, 1.4, 287.0,
                  350.0, s.n_ghost, True, True)
    cases.append({
        "name": "apply_sources_uniform",
        "inputs": {
            "rho": 2.0, "u": 80.0, "p": 200000.0,
            "dt": 1e-5, "gamma": 1.4, "R_gas": 287.0, "wall_T": 350.0,
        },
        "outputs": {"q_after": s.q.tolist(), "q_before": q0.tolist()},
    })
    # Friction-only
    s2 = make_pipe_state(30, 0.5, area_fn=lambda x: 0.001, gamma=1.4)
    set_uniform(s2, 2.0, 80.0, 200000.0, 0.0)
    apply_sources(s2.q, s2.area, s2.hydraulic_D, 1e-5, 1.4, 287.0,
                  350.0, s2.n_ghost, True, False)
    cases.append({
        "name": "apply_sources_friction_only",
        "inputs": {"apply_heat": False, "dt": 1e-5},
        "outputs": {"q_after": s2.q.tolist()},
    })
    # Heat-only
    s3 = make_pipe_state(30, 0.5, area_fn=lambda x: 0.001, gamma=1.4)
    set_uniform(s3, 2.0, 80.0, 200000.0, 0.0)
    apply_sources(s3.q, s3.area, s3.hydraulic_D, 1e-5, 1.4, 287.0,
                  350.0, s3.n_ghost, False, True)
    cases.append({
        "name": "apply_sources_heat_only",
        "inputs": {"apply_friction": False, "dt": 1e-5},
        "outputs": {"q_after": s3.q.tolist()},
    })
    _write("sources", cases, ARRAY_TOLERANCE)


# ====================================================================
# bcs/simple
# ====================================================================

def capture_bcs_simple():
    from solver.state import make_pipe_state, set_uniform
    from bcs.simple import (
        fill_transmissive_left, fill_transmissive_right,
        fill_reflective_left, fill_reflective_right,
    )
    cases = []
    for fn, name in [
        (fill_transmissive_left, "trans_left"),
        (fill_transmissive_right, "trans_right"),
        (fill_reflective_left, "refl_left"),
        (fill_reflective_right, "refl_right"),
    ]:
        s = make_pipe_state(10, 0.2, area_fn=lambda x: 0.001, gamma=1.4)
        set_uniform(s, 1.2, 35.0, 110000.0, 0.1)
        fn(s)
        cases.append({
            "name": name,
            "inputs": {"rho": 1.2, "u": 35.0, "p": 110000.0, "Y": 0.1},
            "outputs": {"q": s.q.tolist()},
        })
    _write("bcs_simple", cases, ARRAY_TOLERANCE)


# ====================================================================
# bcs/restrictor
# ====================================================================

def capture_bcs_restrictor():
    from solver.state import make_pipe_state, set_uniform
    from bcs.restrictor import fill_choked_restrictor_left, restrictor_mdot
    cases = []
    A_t = 0.25 * np.pi * 0.020 ** 2
    Cd = 0.967
    R_gas = 287.0
    g = 1.4
    p_0, T_0 = 101325.0, 300.0
    for p_down in [20000.0, 53528.0, 80000.0, 95000.0, 101300.0]:
        m = restrictor_mdot(p_down, p_0, T_0, A_t, Cd, g, R_gas)
        cases.append({
            "name": f"mdot@p_down={p_down}",
            "inputs": {"p_down": p_down, "p_0": p_0, "T_0": T_0,
                       "A_t": A_t, "Cd": Cd, "gamma": g, "R_gas": R_gas},
            "outputs": {"mdot": m},
        })
    s = make_pipe_state(20, 0.3, area_fn=lambda x: 0.005, gamma=1.4,
                        R_gas=287.0, wall_T=320.0)
    set_uniform(s, 1.0, 0.0, 90000.0, 0.0)
    m = fill_choked_restrictor_left(s, p_0, T_0, A_t, Cd, loss_coef=0.0)
    cases.append({
        "name": "fill_choked_subsonic",
        "inputs": {"interior_p": 90000.0, "p_0": p_0, "T_0": T_0,
                   "A_t": A_t, "Cd": Cd, "loss_coef": 0.0},
        "outputs": {"mdot": m, "q_after": s.q.tolist()},
    })
    s2 = make_pipe_state(20, 0.3, area_fn=lambda x: 0.005, gamma=1.4,
                         R_gas=287.0, wall_T=320.0)
    set_uniform(s2, 0.4, 0.0, 30000.0, 0.0)
    m2 = fill_choked_restrictor_left(s2, p_0, T_0, A_t, Cd, loss_coef=0.0)
    cases.append({
        "name": "fill_choked_choked",
        "inputs": {"interior_p": 30000.0, "p_0": p_0, "T_0": T_0,
                   "A_t": A_t, "Cd": Cd, "loss_coef": 0.0},
        "outputs": {"mdot": m2, "q_after": s2.q.tolist()},
    })
    _write("bcs_restrictor", cases, ARRAY_TOLERANCE)


# ====================================================================
# bcs/subsonic
# ====================================================================

def capture_bcs_subsonic():
    from solver.state import make_pipe_state, set_uniform
    from bcs.subsonic import (
        fill_subsonic_inflow_left, fill_subsonic_inflow_left_characteristic,
        fill_subsonic_outflow_right,
    )
    cases = []
    s = make_pipe_state(20, 0.2, area_fn=lambda x: 0.001, gamma=1.4,
                        R_gas=287.0, wall_T=320.0)
    set_uniform(s, 1.184, 10.0, 100000.0, 0.0)
    fill_subsonic_inflow_left(s, rho=1.184, u=5.0, p=101325.0, Y=0.0)
    cases.append({
        "name": "subsonic_inflow_left_legacy",
        "inputs": {"rho": 1.184, "u": 5.0, "p": 101325.0, "Y": 0.0,
                   "interior_rho": 1.184, "interior_u": 10.0, "interior_p": 100000.0},
        "outputs": {"q": s.q.tolist()},
    })
    s2 = make_pipe_state(20, 0.2, area_fn=lambda x: 0.001, gamma=1.4,
                         R_gas=287.0, wall_T=320.0)
    set_uniform(s2, 1.184, 10.0, 100000.0, 0.0)
    fill_subsonic_inflow_left_characteristic(
        s2, rho=1.184, u=0.0, p=101325.0, Y=0.0,
    )
    cases.append({
        "name": "subsonic_inflow_left_characteristic",
        "inputs": {"rho_res": 1.184, "p_res": 101325.0, "Y_res": 0.0,
                   "interior_rho": 1.184, "interior_u": 10.0, "interior_p": 100000.0},
        "outputs": {"q": s2.q.tolist()},
    })
    s3 = make_pipe_state(20, 0.2, area_fn=lambda x: 0.001, gamma=1.4,
                         R_gas=287.0, wall_T=320.0)
    set_uniform(s3, 1.184, 10.0, 100000.0, 0.0)
    fill_subsonic_outflow_right(s3, p_back=99000.0)
    cases.append({
        "name": "subsonic_outflow_right",
        "inputs": {"p_back": 99000.0},
        "outputs": {"q": s3.q.tolist()},
    })
    _write("bcs_subsonic", cases, ARRAY_TOLERANCE)


# ====================================================================
# bcs/junction_cv
# ====================================================================

def capture_bcs_junction_cv():
    from solver.state import make_pipe_state, set_uniform
    from bcs.junction_cv import JunctionCV, JunctionCVLeg, LEFT, RIGHT
    cases = []
    # Three-leg junction: pipe A right + pipe B right + pipe C left
    a = make_pipe_state(10, 0.3, area_fn=lambda x: 0.002, gamma=1.4)
    set_uniform(a, 1.2, 30.0, 110000.0, 0.0)
    b = make_pipe_state(10, 0.3, area_fn=lambda x: 0.002, gamma=1.4)
    set_uniform(b, 1.1, 25.0, 105000.0, 0.0)
    c = make_pipe_state(10, 0.3, area_fn=lambda x: 0.004, gamma=1.4)
    set_uniform(c, 1.0, 0.0, 101325.0, 0.0)
    legs = [JunctionCVLeg(a, RIGHT), JunctionCVLeg(b, RIGHT), JunctionCVLeg(c, LEFT)]
    cv = JunctionCV.from_legs(legs, p_init=101325.0, T_init=300.0, Y_init=0.0)
    cv.fill_ghosts(dt=0.0)
    snap_after_fill = {
        "a_q": a.q.tolist(), "b_q": b.q.tolist(), "c_q": c.q.tolist(),
        "M": cv.M, "E": cv.E, "M_Y": cv.M_Y, "V": cv.V,
        "last_p": cv.last_p, "last_T": cv.last_T,
    }
    # Inject a small known flux via the _scratch attribute (mimicking what
    # the engine's MUSCL step would set), then absorb_fluxes.
    for pipe in (a, b, c):
        n = pipe.n_total
        pipe._scratch = {"flux": np.zeros((n + 1, 4))}
    # leg a (RIGHT) face at index ng+nc = 12
    a._scratch["flux"][a.n_ghost + a.n_cells] = np.array([0.1, 0.0, 200.0, 0.0])
    b._scratch["flux"][b.n_ghost + b.n_cells] = np.array([0.05, 0.0, 100.0, 0.0])
    c._scratch["flux"][c.n_ghost] = np.array([-0.15, 0.0, -300.0, 0.0])
    cv.absorb_fluxes(dt=1e-5)
    cases.append({
        "name": "junction_cv_3leg_lifecycle",
        "inputs": {
            "a": [1.2, 30.0, 110000.0, 0.0, 0.002],
            "b": [1.1, 25.0, 105000.0, 0.0, 0.002],
            "c": [1.0, 0.0, 101325.0, 0.0, 0.004],
        },
        "outputs": {
            "after_fill_ghosts": snap_after_fill,
            "after_absorb": {
                "M": cv.M, "E": cv.E, "M_Y": cv.M_Y,
            },
        },
    })
    _write("bcs_junction_cv", cases, ARRAY_TOLERANCE)


# ====================================================================
# bcs/junction_characteristic
# ====================================================================

def capture_bcs_junction_characteristic():
    from solver.state import make_pipe_state, set_uniform
    from bcs.junction_characteristic import CharacteristicJunction, JunctionLeg
    from bcs.junction_cv import LEFT, RIGHT
    cases = []
    a = make_pipe_state(20, 0.3, area_fn=lambda x: 0.002, gamma=1.4)
    set_uniform(a, 1.2, 30.0, 110000.0, 0.0)
    b = make_pipe_state(20, 0.3, area_fn=lambda x: 0.002, gamma=1.4)
    set_uniform(b, 1.1, 25.0, 105000.0, 0.0)
    c = make_pipe_state(20, 0.3, area_fn=lambda x: 0.004, gamma=1.4)
    set_uniform(c, 1.0, 0.0, 101325.0, 0.0)
    legs = [JunctionLeg(a, RIGHT), JunctionLeg(b, RIGHT), JunctionLeg(c, LEFT)]
    cj = CharacteristicJunction(legs=legs, gamma=1.4, R_gas=287.0)
    cj.fill_ghosts(dt=1e-5)
    cases.append({
        "name": "char_junction_3leg_subsonic",
        "inputs": {
            "a": [1.2, 30.0, 110000.0, 0.0, 0.002],
            "b": [1.1, 25.0, 105000.0, 0.0, 0.002],
            "c": [1.0, 0.0, 101325.0, 0.0, 0.004],
            "dt": 1e-5,
        },
        "outputs": {
            "a_q": a.q.tolist(), "b_q": b.q.tolist(), "c_q": c.q.tolist(),
            "p_junction": cj.last_p_junction,
            "mass_residual": cj.last_mass_residual,
            "energy_residual": cj.last_energy_residual,
            "niter": cj.last_niter,
            "regime": cj.last_regime,
            "y_mixed": cj.last_y_mixed,
        },
    })
    _write("bcs_junction_characteristic", cases, ARRAY_TOLERANCE)


# ====================================================================
# bcs/valve (production: fill_valve_ghost_characteristic)
# ====================================================================

def capture_bcs_valve():
    from solver.state import make_pipe_state, set_uniform
    from cylinder.valve import (
        ValveParams,
        INTAKE_LD_TABLE, INTAKE_CD_TABLE, EXHAUST_LD_TABLE, EXHAUST_CD_TABLE,
    )
    from bcs.valve import (
        fill_valve_ghost, fill_valve_ghost_characteristic,
        enable_regime_logging, get_regime_log,
    )
    cases = []
    intake_vp = ValveParams(
        diameter=0.0275, max_lift=0.00856,
        open_angle_deg=350.0, close_angle_deg=585.0,
        seat_angle_deg=45.0, n_valves=2,
        ld_table=np.array(INTAKE_LD_TABLE), cd_table=np.array(INTAKE_CD_TABLE),
    )
    exhaust_vp = ValveParams(
        diameter=0.023, max_lift=0.00735,
        open_angle_deg=140.0, close_angle_deg=365.0,
        seat_angle_deg=45.0, n_valves=2,
        ld_table=np.array(EXHAUST_LD_TABLE), cd_table=np.array(EXHAUST_CD_TABLE),
    )
    # Scenarios chosen to exercise each regime in fill_valve_ghost_characteristic.
    scenarios = [
        # (label, valve, pipe_end, theta_local, p_cyl, T_cyl, xb_cyl,
        #         interior (rho, u, p, Y))
        ("intake_startup", intake_vp, "right", 450.0,
            101325.0, 300.0, 0.0, (1.184, 0.0, 101325.0, 0.0)),
        ("intake_subsonic_inflow", intake_vp, "right", 480.0,
            180000.0, 800.0, 0.95, (1.184, 0.0, 101325.0, 0.0)),
        ("intake_choked_inflow", intake_vp, "right", 480.0,
            500000.0, 1500.0, 1.0, (1.184, 0.0, 101325.0, 0.0)),
        ("intake_subsonic_outflow", intake_vp, "right", 480.0,
            90000.0, 320.0, 0.0, (1.2, 50.0, 110000.0, 0.0)),
        ("exhaust_startup", exhaust_vp, "left", 50.0,
            101325.0, 1000.0, 1.0, (0.35, 0.0, 101325.0, 1.0)),
        ("exhaust_choked_outflow", exhaust_vp, "left", 200.0,
            800000.0, 2200.0, 1.0, (0.35, 0.0, 101325.0, 1.0)),
        ("exhaust_subsonic_outflow", exhaust_vp, "left", 250.0,
            150000.0, 1300.0, 1.0, (0.35, 0.0, 101325.0, 1.0)),
    ]
    for label, vp, pe, theta, p_cyl, T_cyl, xb, interior in scenarios:
        s = make_pipe_state(20, 0.3,
                            area_fn=lambda x, vp=vp: 0.25 * np.pi * vp.diameter ** 2,
                            gamma=1.4, R_gas=287.0, wall_T=350.0)
        set_uniform(s, *interior)
        enable_regime_logging(True)
        m_legacy = fill_valve_ghost(
            s, pe, "intake" if vp is intake_vp else "exhaust",
            vp, theta, p_cyl, T_cyl, xb,
        )
        q_legacy = s.q.copy()

        s2 = make_pipe_state(20, 0.3,
                             area_fn=lambda x, vp=vp: 0.25 * np.pi * vp.diameter ** 2,
                             gamma=1.4, R_gas=287.0, wall_T=350.0)
        set_uniform(s2, *interior)
        enable_regime_logging(True)
        m_char = fill_valve_ghost_characteristic(
            s2, pe, "intake" if vp is intake_vp else "exhaust",
            vp, theta, p_cyl, T_cyl, xb,
        )
        log = get_regime_log()
        cases.append({
            "name": label,
            "inputs": {
                "valve_type": "intake" if vp is intake_vp else "exhaust",
                "pipe_end": pe, "theta_local": theta,
                "p_cyl": p_cyl, "T_cyl": T_cyl, "xb_cyl": xb,
                "interior": list(interior),
            },
            "outputs": {
                "mdot_legacy": m_legacy,
                "q_legacy": q_legacy.tolist(),
                "mdot_characteristic": m_char,
                "q_characteristic": s2.q.tolist(),
                "last_regime": log[-1]["regime"] if log else "NONE",
            },
        })
    _write("bcs_valve", cases, ARRAY_TOLERANCE)


# ====================================================================
# cylinder advance (one full step in each branch)
# ====================================================================

def capture_cylinder_advance():
    from cylinder.combustion import WiebeParams
    from cylinder.cylinder import CylinderModel
    from cylinder.heat_transfer import WoschniParams
    from cylinder.valve import (
        ValveParams,
        INTAKE_LD_TABLE, INTAKE_CD_TABLE, EXHAUST_LD_TABLE, EXHAUST_CD_TABLE,
    )
    cases = []
    geom_args = dict(bore=0.067, stroke=0.0425, con_rod=0.0963, CR=12.2,
                     n_intake_valves=2, n_exhaust_valves=2)
    from cylinder.cylinder import CylinderGeom
    geom = CylinderGeom(**geom_args)
    wiebe = WiebeParams()
    woschni = WoschniParams(bore=0.067, stroke=0.0425, T_wall=450.0)
    intake_vp = ValveParams(
        diameter=0.0275, max_lift=0.00856,
        open_angle_deg=350.0, close_angle_deg=585.0,
        seat_angle_deg=45.0, n_valves=2,
        ld_table=np.array(INTAKE_LD_TABLE), cd_table=np.array(INTAKE_CD_TABLE),
    )
    exhaust_vp = ValveParams(
        diameter=0.023, max_lift=0.00735,
        open_angle_deg=140.0, close_angle_deg=365.0,
        seat_angle_deg=45.0, n_valves=2,
        ld_table=np.array(EXHAUST_LD_TABLE), cd_table=np.array(EXHAUST_CD_TABLE),
    )
    # Closed-cycle advance: at θ ≈ 700° (just past TDC firing in some
    # configurations, but with this setup ivc=585 we're in compression).
    cyl = CylinderModel(geom, wiebe, woschni, intake_vp, exhaust_vp,
                        phase_offset_deg=0.0)
    init_theta_cc = 585.0
    cyl.initialize(p=101325.0, T=300.0, theta_global_deg=init_theta_cc)
    # Run 5 steps through compression / combustion / expansion
    rpm = 6000.0
    dt = 1e-5
    omega = 2 * np.pi * rpm / 60.0
    dtheta = dt * 180.0 / np.pi * omega
    snapshots = []
    theta = 585.0
    for i in range(20):
        cyl.advance(theta, dtheta, rpm, dt)
        theta += dtheta
        snapshots.append({
            "step": i,
            "theta": theta,
            "p": cyl.state.p, "T": cyl.state.T,
            "m": cyl.state.m, "x_b": cyl.state.x_b,
            "work_cycle": cyl.state.work_cycle,
        })
    cases.append({
        "name": "closed_cycle_compression_combustion",
        "inputs": {"rpm": rpm, "dt": dt, "theta_start": 585.0, "n_steps": 20,
                   "init_p": 101325.0, "init_T": 300.0,
                   "init_theta_global_deg": init_theta_cc},
        "outputs": {"snapshots": snapshots},
    })
    # Gas-exchange advance: at θ during intake open (~400-500)
    cyl2 = CylinderModel(geom, wiebe, woschni, intake_vp, exhaust_vp,
                         phase_offset_deg=0.0)
    init_theta_gx = 0.0
    cyl2.initialize(p=101325.0, T=300.0, theta_global_deg=init_theta_gx)
    # Cheat: set the cylinder a bit into the intake stroke
    cyl2.state.mdot_intake = 0.03
    cyl2.state.T_intake = 320.0
    cyl2.state.mdot_exhaust = 0.0
    theta = 400.0
    snap2 = []
    for i in range(20):
        cyl2.advance(theta, dtheta, rpm, dt)
        theta += dtheta
        snap2.append({
            "step": i, "theta": theta,
            "p": cyl2.state.p, "T": cyl2.state.T, "m": cyl2.state.m,
        })
    cases.append({
        "name": "gas_exchange_intake",
        "inputs": {"rpm": rpm, "dt": dt, "theta_start": 400.0, "n_steps": 20,
                   "mdot_intake": 0.03, "T_intake": 320.0,
                   "init_p": 101325.0, "init_T": 300.0,
                   "init_theta_global_deg": init_theta_gx},
        "outputs": {"snapshots": snap2},
    })
    _write("cylinder_advance", cases, ARRAY_TOLERANCE)


# ====================================================================
# Engine-level: 5-cycle SDM26 sweep, 6000 RPM (small enough to be
# tractable for parity tests)
# ====================================================================

def capture_engine_5cycle():
    from models.sdm26 import SDM26Config, SDM26Engine
    cfg = SDM26Config()
    eng = SDM26Engine(cfg, junction_type="stagnation")
    result = eng.run_single_rpm(6000.0, n_cycles=3, verbose=False)
    cases = [{
        "name": "sdm26_default_6000rpm_3cycles_stagnation",
        "inputs": {"rpm": 6000.0, "n_cycles": 3, "junction_type": "stagnation"},
        "outputs": {
            "cycle_stats": result["cycle_stats"],
            "step_count": result["step_count"],
            "n_cycles_run": result["n_cycles_run"],
        },
    }]
    _write("engine_5cycle", cases, ENGINE_TOLERANCE)


# ====================================================================
# Phase 1 CFD parity broadening
# ====================================================================

PHASE1_MATRIX_CONFIGS = ["sdm25", "sdm26"]
PHASE1_MATRIX_JUNCTIONS = ["stagnation", "characteristic"]
PHASE1_MATRIX_RPMS = [4000.0, 6000.0, 8000.0, 10000.0, 12000.0]


def _load_config(name: str):
    from configs.config_loader import load_v1_json
    return load_v1_json(REF_ROOT / "configs" / f"{name}.json")


def capture_engine_matrix():
    """Capture 2 configs * 2 junctions * 5 RPMs = 20 engine-level fixtures.

    Each fixture is a 5-cycle run with stop_at_convergence=False, dumping
    every cycle's stats. Tolerance is ENGINE_TOLERANCE (rtol=1e-6).
    """
    from models.sdm26 import SDM26Engine

    total = (
        len(PHASE1_MATRIX_CONFIGS)
        * len(PHASE1_MATRIX_JUNCTIONS)
        * len(PHASE1_MATRIX_RPMS)
    )
    idx = 0
    t_all = time.time()
    for cfg_name in PHASE1_MATRIX_CONFIGS:
        cfg = _load_config(cfg_name)
        for junction in PHASE1_MATRIX_JUNCTIONS:
            for rpm in PHASE1_MATRIX_RPMS:
                idx += 1
                t0 = time.time()
                eng = SDM26Engine(cfg, junction_type=junction)
                result = eng.run_single_rpm(
                    rpm,
                    n_cycles=5,
                    stop_at_convergence=False,
                    verbose=False,
                )
                wall = time.time() - t0
                rpm_label = f"{int(rpm)}"
                case = {
                    "name": f"{cfg_name}_{junction}_{rpm_label}_5cyc",
                    "inputs": {
                        "config": cfg_name,
                        "junction_type": junction,
                        "rpm": rpm,
                        "n_cycles": 5,
                        "stop_at_convergence": False,
                    },
                    "outputs": {
                        "cycle_stats": result["cycle_stats"],
                        "step_count": result["step_count"],
                        "n_cycles_run": result["n_cycles_run"],
                    },
                }
                fixture_name = f"engine_matrix_{cfg_name}_{junction}_{rpm_label}_5cyc"
                _write(fixture_name, [case], ENGINE_TOLERANCE)
                print(
                    f"    [{idx}/{total}] {cfg_name} {junction} {rpm_label}rpm "
                    f"5cyc wall={wall:5.1f}s"
                )
    print(f"  capture_engine_matrix total wall={time.time() - t_all:.1f}s")


def capture_engine_convergence():
    """Two long-run convergence fixtures: SDM25 + SDM26 at 6000 RPM,
    Stagnation junctions, n_cycles_max=25, stop_at_convergence=True.

    Verifies: long-run cycle-stats drift + Python's converged-cycle pick.
    """
    from models.sdm26 import SDM26Engine

    for cfg_name in PHASE1_MATRIX_CONFIGS:
        t0 = time.time()
        cfg = _load_config(cfg_name)
        eng = SDM26Engine(cfg, junction_type="stagnation")
        result = eng.run_single_rpm(
            6000.0,
            n_cycles=25,
            stop_at_convergence=True,
            convergence_tol_imep=1e-3,
            convergence_min_cycles=5,
            verbose=False,
        )
        wall = time.time() - t0
        case = {
            "name": f"{cfg_name}_6000rpm_25cyc_stagnation_converged",
            "inputs": {
                "config": cfg_name,
                "junction_type": "stagnation",
                "rpm": 6000.0,
                "n_cycles_max": 25,
                "convergence_tol_imep": 1e-3,
                "convergence_min_cycles": 5,
                "stop_at_convergence": True,
            },
            "outputs": {
                "cycle_stats": result["cycle_stats"],
                "step_count": result["step_count"],
                "n_cycles_run": result["n_cycles_run"],
                "converged_cycle": result.get("converged_cycle", -1),
            },
        }
        fixture_name = f"engine_convergence_{cfg_name}_25cyc"
        _write(fixture_name, [case], ENGINE_TOLERANCE)
        print(f"    {cfg_name} 25cyc wall={wall:5.1f}s")


def _muscl_run(L, R, gamma, n_cells, length, n_steps, limiter, name):
    """Helper: replicates capture_muscl's per-case logic for arbitrary L/R/gamma."""
    from solver.state import make_pipe_state, set_left_right
    from solver.muscl import muscl_hancock_step, cfl_dt
    from bcs.simple import fill_transmissive_left, fill_transmissive_right

    s = make_pipe_state(n_cells, length, area_fn=lambda x: 1.0, gamma=gamma)
    set_left_right(s, length / 2.0, L[0], L[1], L[2], L[3], R[0], R[1], R[2], R[3])
    ng = s.n_ghost
    n = s.n_total
    w = np.zeros((n, 4))
    slopes = np.zeros((n, 4))
    wL = np.zeros((n, 4))
    wR = np.zeros((n, 4))
    flux = np.zeros((n + 1, 4))
    for _ in range(n_steps):
        dt = cfl_dt(s.q, s.area, s.dx, gamma, 0.85, ng)
        if dt <= 0:
            break
        fill_transmissive_left(s)
        fill_transmissive_right(s)
        muscl_hancock_step(
            s.q, s.area, s.area_f, s.dx, dt, gamma, ng, limiter,
            w, slopes, wL, wR, flux,
        )
    return {
        "name": name,
        "inputs": {
            "n_cells": n_cells, "length": length, "n_steps": n_steps,
            "limiter": int(limiter), "gamma": gamma,
            "L": list(L), "R": list(R),
        },
        "outputs": {
            "q_final": s.q.tolist(),
            "flux_final": flux.tolist(),
        },
    }


def capture_muscl_extras():
    """Four additional MUSCL cases beyond the existing Sod variants.

    Cases:
      - contact: pure contact discontinuity (no shock, no rarefaction)
      - left_rarefaction: outward flow producing left-going rarefaction
      - supersonic_shock: strong right-running shock with Mach > 1
      - mixed_gamma: same pressure jump as Sod but with gamma=1.30
    """
    from solver.muscl import LIMITER_MINMOD
    cases = [
        # contact discontinuity: same p, same u, different rho + Y
        _muscl_run(
            L=(1.5, 50.0, 1.0e5, 0.0),
            R=(0.8, 50.0, 1.0e5, 1.0),
            gamma=1.4, n_cells=100, length=1.0,
            n_steps=50, limiter=LIMITER_MINMOD,
            name="contact_50step_minmod",
        ),
        # left rarefaction: outward-moving (diverging) initial flow
        _muscl_run(
            L=(1.0, -200.0, 1.0e5, 0.0),
            R=(1.0,  200.0, 1.0e5, 0.0),
            gamma=1.4, n_cells=100, length=1.0,
            n_steps=50, limiter=LIMITER_MINMOD,
            name="left_rarefaction_50step_minmod",
        ),
        # supersonic shock: very strong right-running shock
        _muscl_run(
            L=(5.0, 800.0, 5.0e5, 0.0),
            R=(0.5,   0.0, 5.0e4, 0.0),
            gamma=1.4, n_cells=200, length=1.0,
            n_steps=50, limiter=LIMITER_MINMOD,
            name="supersonic_shock_50step_minmod",
        ),
        # mixed-gamma Sod (matches base gas-property choice in engine work)
        _muscl_run(
            L=(1.0, 0.0, 1.0, 0.0),
            R=(0.125, 0.0, 0.1, 0.0),
            gamma=1.3, n_cells=100, length=1.0,
            n_steps=50, limiter=LIMITER_MINMOD,
            name="sod_50step_gamma13_minmod",
        ),
    ]
    for case in cases:
        # write each as its own fixture so per-case Rust test reporting is clean
        _write(f"muscl_{case['name']}", [case], ARRAY_TOLERANCE)


def capture_hllc_extras():
    """500 random Riemann problems (different seed than `hllc.json`)
    plus 8 Toro textbook shock-tube cases.

    Tolerance: KERNEL_TOLERANCE (rtol=1e-12, atol=1e-14). HLLC is a pure
    flux function, no time-stepping, so machine precision is achievable.
    """
    from solver.hllc import hllc_flux

    rng = np.random.default_rng(seed=20260521)
    cases = []

    # 500 random Riemann problems
    for i in range(500):
        rho_l = float(rng.uniform(0.05, 5.0))
        u_l   = float(rng.uniform(-400.0, 400.0))
        p_l   = float(rng.uniform(1.0e3, 5.0e5))
        Y_l   = float(rng.uniform(0.0, 1.0))
        rho_r = float(rng.uniform(0.05, 5.0))
        u_r   = float(rng.uniform(-400.0, 400.0))
        p_r   = float(rng.uniform(1.0e3, 5.0e5))
        Y_r   = float(rng.uniform(0.0, 1.0))
        gamma = float(rng.choice([1.3, 1.35, 1.4]))
        f = hllc_flux(rho_l, u_l, p_l, Y_l, rho_r, u_r, p_r, Y_r, gamma)
        cases.append({
            "name": f"random_{i:03d}",
            "inputs": {
                "L": [rho_l, u_l, p_l, Y_l],
                "R": [rho_r, u_r, p_r, Y_r],
                "gamma": gamma,
            },
            "outputs": {"flux": list(f)},
        })

    # 8 Toro textbook + edge cases
    toro_cases = [
        # name,              L=(rho,u,p,Y),                R=(rho,u,p,Y),                gamma
        ("toro_A",            (1.0, 0.75, 1.0, 0.0),       (0.125, 0.0, 0.1, 0.0),       1.4),
        ("toro_B",            (1.0, -2.0, 0.4, 0.0),       (1.0, 2.0, 0.4, 0.0),         1.4),
        ("toro_C",            (1.0, 0.0, 1000.0, 0.0),     (1.0, 0.0, 0.01, 0.0),        1.4),
        ("toro_D",            (5.99924, 19.5975, 460.894, 0.0), (5.99242, -6.19633, 46.0950, 0.0), 1.4),
        ("toro_E",            (1.0, -19.59745, 1000.0, 0.0),(1.0, -19.59745, 0.01, 0.0), 1.4),
        ("low_density",       (1e-3, 0.0, 1e2, 0.0),       (1.0, 0.0, 1.0e5, 0.0),       1.4),
        ("slow_contact",      (1.2, 1.0, 1.0e5, 0.0),      (0.6, 1.0, 1.0e5, 1.0),       1.4),
        ("near_vacuum",       (1.0, 0.0, 1.0e5, 0.0),      (1e-6, 0.0, 1e-3, 0.0),       1.4),
    ]
    for name, L, R, g in toro_cases:
        f = hllc_flux(L[0], L[1], L[2], L[3], R[0], R[1], R[2], R[3], g)
        cases.append({
            "name": name,
            "inputs": {"L": list(L), "R": list(R), "gamma": g},
            "outputs": {"flux": list(f)},
        })

    _write("hllc_extras", cases, KERNEL_TOLERANCE)


# ====================================================================
# main
# ====================================================================

ORIGINAL_CAPTURES = [
    capture_gas_properties,
    capture_geometry,
    capture_kinematics,
    capture_combustion,
    capture_heat_transfer,
    capture_valve_cyl,
    capture_state,
    capture_hllc,
    capture_muscl,
    capture_sources,
    capture_bcs_simple,
    capture_bcs_restrictor,
    capture_bcs_subsonic,
    capture_bcs_junction_cv,
    capture_bcs_junction_characteristic,
    capture_bcs_valve,
    capture_cylinder_advance,
    capture_engine_5cycle,
]

PHASE1_CAPTURES = {
    "matrix": capture_engine_matrix,
    "convergence": capture_engine_convergence,
    "muscl-extras": capture_muscl_extras,
    "hllc-extras": capture_hllc_extras,
}


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Capture deterministic kernel + engine outputs as parity fixtures."
    )
    parser.add_argument(
        "--all", action="store_true",
        help="Run every capture (original 18 + Phase 1).",
    )
    parser.add_argument(
        "--original", action="store_true",
        help="Run only the original 18 capture functions (pre-Phase-1).",
    )
    parser.add_argument(
        "--matrix", action="store_true",
        help="Engine-level RPM/config/junction matrix (20 fixtures).",
    )
    parser.add_argument(
        "--convergence", action="store_true",
        help="Long-run convergence fixtures (2 fixtures).",
    )
    parser.add_argument(
        "--muscl-extras", action="store_true",
        help="Additional MUSCL initial conditions (4 fixtures).",
    )
    parser.add_argument(
        "--hllc-extras", action="store_true",
        help="Extra HLLC Riemann problems (1 consolidated fixture).",
    )
    args = parser.parse_args(argv)

    print(f"Pinned SHA: {PINNED_SHA}")
    print(f"Writing fixtures to: {FIXTURES_DIR}")

    # If no flags given, default to running all four Phase-1 captures.
    selected_phase1 = [
        ("matrix", args.matrix),
        ("convergence", args.convergence),
        ("muscl-extras", args.muscl_extras),
        ("hllc-extras", args.hllc_extras),
    ]
    any_phase1_flag = any(v for _, v in selected_phase1)
    if args.all:
        for fn in ORIGINAL_CAPTURES:
            fn()
        for fn in PHASE1_CAPTURES.values():
            fn()
    elif args.original:
        for fn in ORIGINAL_CAPTURES:
            fn()
    elif any_phase1_flag:
        for name, on in selected_phase1:
            if on:
                PHASE1_CAPTURES[name]()
    else:
        # default: run all Phase 1 captures
        for fn in PHASE1_CAPTURES.values():
            fn()

    print("\nAll requested fixtures captured.")


if __name__ == "__main__":
    main()
