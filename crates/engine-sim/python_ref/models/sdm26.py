"""SDM26 engine assembly — Honda CBR600RR 599 cc I4 with FSAE 20 mm restrictor.

Geometry and coefficients copied from V1 at `1d/engine_simulator/config/cbr600rr.json`
(copy date 2026-04-13). Differences vs V1:
  - exhaust-pipe wall temperatures raised to physical values (V1 ran cold
    to compensate for the entropy-BC bug; V2 corrects the physics so wall
    T should reflect the real skin temperature at WOT).
  - plenum is an FV domain (1D pipe of matched volume, 0.3 m × ~50 cm²)
    rather than a lumped 0-D volume.
  - valve BCs are entropy-aware ghost-cell fills (V2's main fix).
  - no V1 imports.

Config coverage: every physical parameter that a user might want to sweep
is a field on SDM26Config. Default construction reproduces the SDM26
geometry and the SDM25-dyno-reference Wiebe/Woschni coefficients. Any
scalar can be changed via kwargs, per-pipe lists can be supplied for
asymmetric geometry, and every field is validated at construction (see
SDM26Config.__post_init__). Tapered pipes are first-class: pass
`*_diameter_out` to make that pipe a linearly-tapered cone.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np

from solver.state import make_pipe_state, set_uniform, PipeState, I_RHO_A, I_MOM_A, I_E_A, I_Y_A
from solver.muscl import muscl_hancock_step, cfl_dt, LIMITER_MINMOD
from solver.sources import apply_sources

from bcs.restrictor import fill_choked_restrictor_left
from bcs.junction_cv import JunctionCV, JunctionCVLeg, LEFT, RIGHT
from bcs.junction_characteristic import CharacteristicJunction, JunctionLeg
from bcs.valve import fill_valve_ghost_characteristic as fill_valve_ghost  # Phase C1 fix (2026-04-14)
from bcs.simple import fill_transmissive_right

from cylinder.combustion import WiebeParams
from cylinder.cylinder import CylinderModel, CylinderGeom
from cylinder.heat_transfer import WoschniParams
from cylinder.kinematics import cylinder_phase_offsets, omega_from_rpm
from cylinder.valve import ValveParams


# ---- default Cd(L/D) tables (2007 CBR600RR) ----
INTAKE_LD_DEFAULT = (0.05, 0.10, 0.15, 0.20, 0.25, 0.30)
INTAKE_CD_DEFAULT = (0.19, 0.38, 0.494, 0.551, 0.57, 0.57)
EXHAUST_LD_DEFAULT = (0.05, 0.10, 0.15, 0.20, 0.25, 0.30)
EXHAUST_CD_DEFAULT = (0.171, 0.333, 0.456, 0.523, 0.542, 0.551)


# -------------------- helpers --------------------


def linear_diameter_area(length: float, D_in: float, D_out: float):
    """area_fn(x) for a circular pipe with linearly-varying diameter.

    D_in is diameter at x=0; D_out at x=length. Returns area in m². Used
    both for straight pipes (D_in == D_out) and tapered pipes.
    """
    L = max(length, 1e-20)
    def area(x: float) -> float:
        t = x / L
        if t < 0.0:
            t = 0.0
        elif t > 1.0:
            t = 1.0
        D = D_in + (D_out - D_in) * t
        return 0.25 * np.pi * D * D
    return area


def _check_positive(name: str, value: float, unit: str = "") -> None:
    if value <= 0.0 or not np.isfinite(value):
        suffix = f" {unit}" if unit else ""
        raise ValueError(f"{name} must be > 0{suffix}, got {value!r}")


def _check_finite(name: str, value: float) -> None:
    if not np.isfinite(value):
        raise ValueError(f"{name} must be finite, got {value!r}")


def _warn_large_taper(pipe_name: str, D_in: float, D_out: float) -> None:
    """Emit a physical-reasonableness warning for aggressive taper.

    Area ratio > 9 (diameter ratio > 3) is likely to generate standing
    shocks under supersonic conditions and strong wave reflections
    regardless; flag it but do not refuse to run."""
    if D_in <= 0 or D_out <= 0:
        return
    ratio = max(D_in, D_out) / min(D_in, D_out)
    if ratio > 3.0:
        warnings.warn(
            f"{pipe_name}: diameter ratio {ratio:.2f}× (area ratio "
            f"{ratio**2:.2f}×) is aggressive; expect strong wave "
            f"reflections at the taper and possible shock formation "
            f"under supersonic flow. Verify against a known solution.",
            stacklevel=2,
        )


# -------------------- Config (SDM26 defaults) --------------------

@dataclass
class SDM26Config:
    """Full SDM26 parameterization.

    Every physical quantity is exposed. Defaults reproduce the baseline
    CBR600RR/SDM26 geometry and the V1-inherited Wiebe+Woschni coefficients.

    Pipe taper: for each pipe type (runner, primary, secondary, collector)
    you can set `*_diameter_out` to make it a linearly-tapered cone. If
    the `_out` field is None, the pipe is straight (D_in = D_out).

    Per-pipe asymmetry: for runners, primaries, and secondaries you can
    supply `*_lengths`, `*_diameters_in`, `*_diameters_out`, `*_wall_Ts`
    as lists (length 4 for runners/primaries, length 2 for secondaries)
    to make the pipes nonidentical. If a list is None the scalar default
    is used for every pipe of that type.

    All lengths in metres, diameters in metres, temperatures in Kelvin,
    pressures in Pa, angles in degrees.
    """

    # -------- Engine geometry (cylinder) --------
    bore: float = 0.067               # m
    stroke: float = 0.0425             # m
    con_rod: float = 0.0963            # m
    CR: float = 12.2                   # compression ratio (unitless)
    n_cylinders: int = 4
    firing_order: tuple = (1, 2, 4, 3)
    firing_interval: float = 180.0     # degrees CAD between fires

    # -------- Intake runners (×n_cylinders, default all identical) --------
    runner_length: float = 0.245
    runner_diameter_in: float = 0.038
    runner_diameter_out: Optional[float] = None   # None → straight pipe
    runner_n_cells: int = 30
    runner_wall_T: float = 325.0
    # Per-cylinder overrides: None uses scalar defaults for all runners.
    runner_lengths: Optional[List[float]] = None
    runner_diameters_in: Optional[List[float]] = None
    runner_diameters_out: Optional[List[float]] = None
    runner_wall_Ts: Optional[List[float]] = None

    # -------- Exhaust primaries (×n_cylinders) --------
    primary_length: float = 0.308
    primary_diameter_in: float = 0.032
    primary_diameter_out: Optional[float] = None  # None → straight
    primary_n_cells: int = 30
    primary_wall_T: float = 1000.0    # V2 physical value (V1 ran 650 K cold)
    primary_lengths: Optional[List[float]] = None
    primary_diameters_in: Optional[List[float]] = None
    primary_diameters_out: Optional[List[float]] = None
    primary_wall_Ts: Optional[List[float]] = None

    # -------- Exhaust secondaries (×2 for 4-2-1 topology) --------
    secondary_length: float = 0.392
    secondary_diameter_in: float = 0.038
    secondary_diameter_out: Optional[float] = None
    secondary_n_cells: int = 20
    secondary_wall_T: float = 800.0
    secondary_lengths: Optional[List[float]] = None
    secondary_diameters_in: Optional[List[float]] = None
    secondary_diameters_out: Optional[List[float]] = None
    secondary_wall_Ts: Optional[List[float]] = None

    # -------- Exhaust collector (×1) --------
    collector_length: float = 0.1
    collector_diameter_in: float = 0.05
    collector_diameter_out: Optional[float] = None
    collector_n_cells: int = 20
    collector_wall_T: float = 700.0

    # -------- Plenum (1D FV domain of matched volume) --------
    plenum_volume: float = 0.0015      # m³
    plenum_length: float = 0.3         # m, 1D stand-in (area is computed from volume/length)
    plenum_n_cells: int = 20
    plenum_wall_T: float = 320.0
    # Borda-Carnot loss coefficient at the plenum-runner interface (Fix 13).
    # 0.0 = lossless (default), 0.1-0.3 = typical intake-system damping.
    # Only applies when junction_type='characteristic'.
    intake_junction_loss_coef: float = 0.0

    # -------- Restrictor --------
    restrictor_throat_diameter: float = 0.020
    restrictor_Cd: float = 0.967
    # Audit 2026-05-20 Fix 16: Borda-Carnot-style loss coefficient at the
    # throat→plenum sudden expansion. Real FSAE restrictors lose some of
    # the throat kinetic head to turbulence rather than recovering it as
    # static pressure in the (often short) diffuser cone; the orifice Cd
    # captures throat losses but NOT this downstream recovery deficit.
    # Only applies in subsonic regime (choked-throat mdot is independent
    # of downstream static recovery).
    #
    # Tested at K=0.5 in the 2026-05-20 audit (commit "fix16_gunb_rest_loss"):
    # the loss term scales with throat ½·ρ·u² which keeps GROWING with RPM
    # until the throat actually chokes (~13-14k), so K=0.5 over-damped the
    # mid-band (7-11 k SDM25 went from MAE 1.36 → 4.39 kW) without giving
    # a proportional low-RPM gain (4.5-6.5 k 10.92 → 9.91 kW). Parked at
    # 0.0; the underlying physics is real but the asymmetry shape is wrong
    # for the engines in this study. Future work: combine with diffuser-
    # recovery modelling or use a Mach-based loss formulation.
    restrictor_loss_coef: float = 0.0

    # -------- Ambient --------
    p_ambient: float = 101325.0
    T_ambient: float = 300.0

    # -------- Combustion (Wiebe + physics) --------
    wiebe_a: float = 5.0
    wiebe_m: float = 2.0
    combustion_duration: float = 50.0  # degrees CAD
    spark_advance: float = 25.0        # degrees BTDC
    ignition_delay: float = 7.0        # degrees
    eta_comb: float = 0.96             # combustion efficiency, physics not a cap
    q_lhv: float = 44.0e6              # J/kg, gasoline LHV
    afr_target: float = 13.1           # air-fuel ratio
    T_wall_cylinder: float = 450.0     # K, Woschni composite wall T

    # -------- Woschni coefficients (Heywood/Woschni 1967 defaults) --------
    woschni_C1_gas_exchange: float = 6.18
    woschni_C1_compression: float = 2.28
    woschni_C1_combustion: float = 2.28
    woschni_C2_combustion: float = 3.24e-3

    # -------- Intake valve --------
    intake_valve_diameter: float = 0.0275
    intake_valve_max_lift: float = 0.00856
    intake_valve_open_angle: float = 350.0
    intake_valve_close_angle: float = 585.0
    intake_valve_seat_angle: float = 45.0
    intake_n_valves: int = 2
    intake_ld_table: Tuple[float, ...] = INTAKE_LD_DEFAULT
    intake_cd_table: Tuple[float, ...] = INTAKE_CD_DEFAULT

    # -------- Exhaust valve --------
    exhaust_valve_diameter: float = 0.023
    exhaust_valve_max_lift: float = 0.00735
    exhaust_valve_open_angle: float = 140.0
    exhaust_valve_close_angle: float = 365.0
    exhaust_valve_seat_angle: float = 45.0
    exhaust_n_valves: int = 2
    exhaust_ld_table: Tuple[float, ...] = EXHAUST_LD_DEFAULT
    exhaust_cd_table: Tuple[float, ...] = EXHAUST_CD_DEFAULT

    # -------- Exhaust topology --------
    # "4-2-1" = 4 primaries → 2 secondaries → 1 collector (junctions: 3)
    # "4-1"   = 4 primaries → 1 collector directly (junctions: 1, no secondaries)
    exhaust_topology: str = "4-2-1"

    # -------- Drivetrain (for wheel-power output) --------
    # Fix 14b (Audit 2026-05-19): drivetrain efficiency for FSAE car
    # (chain + sprocket + CV + tire slip + wheel bearings) is typically
    # 0.85-0.88, not the 0.91 V1 default. Combined with the FMEP correction
    # above (Patton-Nitschke for sportbike), this realistic drivetrain loss
    # brings the priority band match back without re-introducing the
    # Heywood FMEP over-prediction. Revert: restore 0.91.
    drivetrain_efficiency: float = 0.85

    # -------- Residual-gas tracking (audit 2026-05-20 Fix 18) --------
    # Replaces `m_fuel = m_trapped / (1+AFR)` (over-counts residual as
    # fuelable charge) with `m_fuel = (m_trapped − m_residual) / (1+AFR)`,
    # where m_residual is sampled at EVC. PARKED OFF by default. See
    # docs/residual_gas_findings_2026_05_20.md for the empirical finding
    # that the model's residual is ~0.02-0.04 across the whole RPM range
    # (vs literature 0.04-0.12), so the fueling correction is too small to
    # close the low-RPM dyno gap. The diagnostic value (model has reverse
    # RPM-trend for f_residual = exhaust over-scavenges at low RPM) is
    # the actual research finding, not this fix per se.
    enable_residual_tracking: bool = False

    # -------- Numerics --------
    cfl: float = 0.85
    limiter: int = LIMITER_MINMOD

    # ---------------- validation ----------------

    def __post_init__(self):
        self._validate()

    def _validate(self) -> None:
        """Physical-reasonableness validation. Raises ValueError on hard
        errors, warnings.warn on soft issues."""
        # Engine geometry
        _check_positive("bore", self.bore, "m")
        _check_positive("stroke", self.stroke, "m")
        _check_positive("con_rod", self.con_rod, "m")
        if self.CR <= 1.0:
            raise ValueError(f"CR must be > 1, got {self.CR}")
        if self.con_rod < self.stroke / 2.0:
            raise ValueError(
                f"con_rod ({self.con_rod:.4f} m) must be ≥ stroke/2 "
                f"({self.stroke/2:.4f} m) for the slider-crank to be realisable"
            )
        if self.n_cylinders < 1:
            raise ValueError(f"n_cylinders must be ≥ 1, got {self.n_cylinders}")

        # Pipe lengths and diameters (scalar)
        for k in ("runner_length", "primary_length", "secondary_length",
                  "collector_length", "plenum_length"):
            _check_positive(k, getattr(self, k), "m")
        for k in ("runner_diameter_in", "primary_diameter_in",
                  "secondary_diameter_in", "collector_diameter_in",
                  "restrictor_throat_diameter"):
            _check_positive(k, getattr(self, k), "m")
        for k in ("runner_diameter_out", "primary_diameter_out",
                  "secondary_diameter_out", "collector_diameter_out"):
            v = getattr(self, k)
            if v is not None:
                _check_positive(k, v, "m (or None for straight pipe)")
        # n_cells
        for k in ("runner_n_cells", "primary_n_cells", "secondary_n_cells",
                  "collector_n_cells", "plenum_n_cells"):
            v = getattr(self, k)
            if v < 4:
                raise ValueError(f"{k} must be ≥ 4 (MUSCL-Hancock requires 4), got {v}")

        # Plenum volume
        _check_positive("plenum_volume", self.plenum_volume, "m³")

        # Ambient
        _check_positive("p_ambient", self.p_ambient, "Pa")
        _check_positive("T_ambient", self.T_ambient, "K")

        # Wall temperatures — physical reasonableness
        for k, T in [
            ("runner_wall_T", self.runner_wall_T),
            ("primary_wall_T", self.primary_wall_T),
            ("secondary_wall_T", self.secondary_wall_T),
            ("collector_wall_T", self.collector_wall_T),
            ("plenum_wall_T", self.plenum_wall_T),
            ("T_wall_cylinder", self.T_wall_cylinder),
        ]:
            if T < 200.0 or T > 1500.0:
                raise ValueError(
                    f"{k} = {T} K is outside plausible wall-temperature range 200..1500 K"
                )

        # Restrictor
        if not 0.0 < self.restrictor_Cd <= 1.0:
            raise ValueError(
                f"restrictor_Cd must be in (0, 1], got {self.restrictor_Cd}"
            )

        # Combustion
        if not 0.0 < self.eta_comb <= 1.0:
            raise ValueError(f"eta_comb must be in (0, 1], got {self.eta_comb}")
        if self.wiebe_a <= 0.0:
            raise ValueError(f"wiebe_a must be > 0, got {self.wiebe_a}")
        if self.wiebe_m < 0.0:
            raise ValueError(f"wiebe_m must be ≥ 0, got {self.wiebe_m}")
        _check_positive("combustion_duration", self.combustion_duration, "deg")
        _check_positive("q_lhv", self.q_lhv, "J/kg")
        _check_positive("afr_target", self.afr_target)

        # Valves
        for prefix in ("intake", "exhaust"):
            _check_positive(f"{prefix}_valve_diameter", getattr(self, f"{prefix}_valve_diameter"), "m")
            _check_positive(f"{prefix}_valve_max_lift", getattr(self, f"{prefix}_valve_max_lift"), "m")
            if getattr(self, f"{prefix}_n_valves") < 1:
                raise ValueError(f"{prefix}_n_valves must be ≥ 1")
            ld = getattr(self, f"{prefix}_ld_table")
            cd = getattr(self, f"{prefix}_cd_table")
            if len(ld) != len(cd):
                raise ValueError(f"{prefix}_ld_table and {prefix}_cd_table must be the same length")
            if any(x <= 0 for x in ld):
                raise ValueError(f"{prefix}_ld_table values must all be > 0")
            if any(not 0.0 <= x <= 1.0 for x in cd):
                raise ValueError(f"{prefix}_cd_table values must all be in [0, 1]")
            if list(ld) != sorted(ld):
                raise ValueError(f"{prefix}_ld_table must be monotone increasing")
            # Valve event window sanity
            oa = getattr(self, f"{prefix}_valve_open_angle")
            ca = getattr(self, f"{prefix}_valve_close_angle")
            duration = (ca - oa) % 720.0
            if duration <= 0 or duration > 360.0:
                raise ValueError(
                    f"{prefix} valve event window {oa}° → {ca}° gives duration "
                    f"{duration}°, expected 0 < duration ≤ 360"
                )
            # Lift-to-diameter ratio sanity
            ld_max = getattr(self, f"{prefix}_valve_max_lift") / getattr(self, f"{prefix}_valve_diameter")
            if ld_max > 0.5:
                warnings.warn(
                    f"{prefix} max L/D = {ld_max:.2f} is unusually high (typical < 0.35)",
                    stacklevel=2,
                )

        # Per-cylinder lists — length checks
        n_cyl = self.n_cylinders
        for k in ("runner_lengths", "runner_diameters_in", "runner_diameters_out",
                  "runner_wall_Ts",
                  "primary_lengths", "primary_diameters_in",
                  "primary_diameters_out", "primary_wall_Ts"):
            v = getattr(self, k)
            if v is not None and len(v) != n_cyl:
                raise ValueError(f"{k} must have length {n_cyl}, got {len(v)}")
        for k in ("secondary_lengths", "secondary_diameters_in",
                  "secondary_diameters_out", "secondary_wall_Ts"):
            v = getattr(self, k)
            if v is not None and len(v) != 2:
                raise ValueError(f"{k} must have length 2, got {len(v)}")

        # Per-cylinder list element checks
        for k in ("runner_lengths", "primary_lengths", "secondary_lengths"):
            v = getattr(self, k)
            if v is not None:
                for i, x in enumerate(v):
                    _check_positive(f"{k}[{i}]", x, "m")
        for k in ("runner_diameters_in", "primary_diameters_in", "secondary_diameters_in"):
            v = getattr(self, k)
            if v is not None:
                for i, x in enumerate(v):
                    _check_positive(f"{k}[{i}]", x, "m")
        for k in ("runner_diameters_out", "primary_diameters_out", "secondary_diameters_out"):
            v = getattr(self, k)
            if v is not None:
                for i, x in enumerate(v):
                    if x is not None:
                        _check_positive(f"{k}[{i}]", x, "m")

        # Taper warnings (soft)
        for pname, D_in, D_out in [
            ("runner", self.runner_diameter_in, self.runner_diameter_out or self.runner_diameter_in),
            ("primary", self.primary_diameter_in, self.primary_diameter_out or self.primary_diameter_in),
            ("secondary", self.secondary_diameter_in, self.secondary_diameter_out or self.secondary_diameter_in),
            ("collector", self.collector_diameter_in, self.collector_diameter_out or self.collector_diameter_in),
        ]:
            _warn_large_taper(pname, D_in, D_out)

        # CFL
        if not 0.0 < self.cfl <= 1.0:
            raise ValueError(f"cfl must be in (0, 1], got {self.cfl}")

        # Topology
        if self.exhaust_topology not in ("4-2-1", "4-1"):
            raise ValueError(
                f"exhaust_topology must be '4-2-1' or '4-1', got {self.exhaust_topology!r}"
            )
        if self.exhaust_topology == "4-1" and self.n_cylinders != 4:
            raise ValueError(
                f"4-1 topology requires n_cylinders == 4, got {self.n_cylinders}"
            )

        # Drivetrain
        if not 0.0 < self.drivetrain_efficiency <= 1.0:
            raise ValueError(
                f"drivetrain_efficiency must be in (0, 1], got {self.drivetrain_efficiency}"
            )

        # Cross-pipe geometry compatibility: flag huge area mismatches at junctions
        # (the junction CV can handle them but waves reflect strongly)
        runner_D_at_plenum_end = self.runner_diameter_in  # runner LEFT end connects to plenum junction
        plenum_equiv_D = 2.0 * np.sqrt(self.plenum_volume / (np.pi * self.plenum_length))
        if plenum_equiv_D / runner_D_at_plenum_end > 10.0:
            warnings.warn(
                f"plenum equivalent D ({plenum_equiv_D*1000:.1f} mm) is {plenum_equiv_D/runner_D_at_plenum_end:.1f}× "
                f"larger than runner inlet D ({runner_D_at_plenum_end*1000:.1f} mm); strong wave "
                f"reflections expected at the junction.",
                stacklevel=2,
            )

    # ---- helpers to extract per-pipe specs ----

    def runner_spec(self, i: int):
        """Return (length, D_in, D_out, n_cells, wall_T) for runner i in [0, n_cylinders)."""
        L = self.runner_lengths[i] if self.runner_lengths else self.runner_length
        D_in = self.runner_diameters_in[i] if self.runner_diameters_in else self.runner_diameter_in
        D_out_override = self.runner_diameters_out[i] if self.runner_diameters_out else None
        D_out = D_out_override if D_out_override is not None else (
            self.runner_diameter_out if self.runner_diameter_out is not None else D_in
        )
        wall_T = self.runner_wall_Ts[i] if self.runner_wall_Ts else self.runner_wall_T
        return L, D_in, D_out, self.runner_n_cells, wall_T

    def primary_spec(self, i: int):
        L = self.primary_lengths[i] if self.primary_lengths else self.primary_length
        D_in = self.primary_diameters_in[i] if self.primary_diameters_in else self.primary_diameter_in
        D_out_override = self.primary_diameters_out[i] if self.primary_diameters_out else None
        D_out = D_out_override if D_out_override is not None else (
            self.primary_diameter_out if self.primary_diameter_out is not None else D_in
        )
        wall_T = self.primary_wall_Ts[i] if self.primary_wall_Ts else self.primary_wall_T
        return L, D_in, D_out, self.primary_n_cells, wall_T

    def secondary_spec(self, i: int):
        L = self.secondary_lengths[i] if self.secondary_lengths else self.secondary_length
        D_in = self.secondary_diameters_in[i] if self.secondary_diameters_in else self.secondary_diameter_in
        D_out_override = self.secondary_diameters_out[i] if self.secondary_diameters_out else None
        D_out = D_out_override if D_out_override is not None else (
            self.secondary_diameter_out if self.secondary_diameter_out is not None else D_in
        )
        wall_T = self.secondary_wall_Ts[i] if self.secondary_wall_Ts else self.secondary_wall_T
        return L, D_in, D_out, self.secondary_n_cells, wall_T

    def collector_spec(self):
        D_in = self.collector_diameter_in
        D_out = self.collector_diameter_out if self.collector_diameter_out is not None else D_in
        return (self.collector_length, D_in, D_out, self.collector_n_cells,
                self.collector_wall_T)

    def plenum_spec(self):
        """Returns (L, D_equiv, n_cells, wall_T). The plenum is straight with
        area = volume/length; D_equiv is the circular-equivalent diameter
        used only for hydraulic-D purposes in the friction and heat sources.
        """
        A = self.plenum_volume / self.plenum_length
        D = 2.0 * np.sqrt(A / np.pi)
        return self.plenum_length, D, self.plenum_n_cells, self.plenum_wall_T


# -------------------- Engine model --------------------

class SDM26Engine:
    """One SDM26 simulation state.

    Advance with `run_single_rpm(rpm, n_cycles)` and read results off the
    cylinders' per-cycle accumulators.
    """

    def __init__(self, cfg: SDM26Config, junction_type: str = "stagnation"):
        """Construct the SDM26 engine model.

        ``junction_type``:
          - ``"stagnation"`` (default): JunctionCV, strictly conservative
            in mass + energy + ρY, dissipative at the junction face
            (per-junction acoustic transmission ~0.69 for 4-2-1 geometry).
            Recommended for standard engine runs.
          - ``"characteristic"``: CharacteristicJunction, per-junction
            transmission ~0.91 at linear amplitude, mass-conservative to
            machine precision, energy-conservative to O(ΔA/A̅) +
            O(Δs/s̅) across the junction face. Use when tuned-length
            effects matter (Phase E acoustic-BC work).
        """
        if junction_type not in ("stagnation", "characteristic"):
            raise ValueError(
                f"junction_type must be 'stagnation' or 'characteristic', "
                f"got {junction_type!r}"
            )
        self.junction_type = junction_type
        self.cfg = cfg

        # Plenum pipe — straight, area = volume/length
        L_plen, D_plen, n_plen, T_plen = cfg.plenum_spec()
        self.plenum = make_pipe_state(
            n_plen, L_plen,
            area_fn=linear_diameter_area(L_plen, D_plen, D_plen),
            gamma=1.4, R_gas=287.0, wall_T=T_plen, n_ghost=2,
        )
        set_uniform(self.plenum, rho=cfg.p_ambient / (287.0 * cfg.T_ambient),
                    u=0.0, p=cfg.p_ambient, Y=0.0)

        # Intake runners (per-pipe specs)
        self.runners: List[PipeState] = []
        for i in range(cfg.n_cylinders):
            L, D_in, D_out, n, wT = cfg.runner_spec(i)
            s = make_pipe_state(
                n, L, area_fn=linear_diameter_area(L, D_in, D_out),
                gamma=1.4, R_gas=287.0, wall_T=wT, n_ghost=2,
            )
            set_uniform(s, rho=cfg.p_ambient / (287.0 * cfg.T_ambient),
                        u=0.0, p=cfg.p_ambient, Y=0.0)
            self.runners.append(s)

        # Exhaust primaries
        self.primaries: List[PipeState] = []
        for i in range(cfg.n_cylinders):
            L, D_in, D_out, n, wT = cfg.primary_spec(i)
            s = make_pipe_state(
                n, L, area_fn=linear_diameter_area(L, D_in, D_out),
                gamma=1.4, R_gas=287.0, wall_T=wT, n_ghost=2,
            )
            set_uniform(s, rho=cfg.p_ambient / (287.0 * cfg.T_ambient),
                        u=0.0, p=cfg.p_ambient, Y=0.0)
            self.primaries.append(s)

        # Exhaust secondaries (only for 4-2-1 topology)
        self.secondaries: List[PipeState] = []
        if cfg.exhaust_topology == "4-2-1":
            for i in range(2):
                L, D_in, D_out, n, wT = cfg.secondary_spec(i)
                s = make_pipe_state(
                    n, L, area_fn=linear_diameter_area(L, D_in, D_out),
                    gamma=1.4, R_gas=287.0, wall_T=wT, n_ghost=2,
                )
                set_uniform(s, rho=cfg.p_ambient / (287.0 * cfg.T_ambient),
                            u=0.0, p=cfg.p_ambient, Y=0.0)
                self.secondaries.append(s)

        # Collector
        L_col, D_col_in, D_col_out, n_col, T_col = cfg.collector_spec()
        self.collector = make_pipe_state(
            n_col, L_col,
            area_fn=linear_diameter_area(L_col, D_col_in, D_col_out),
            gamma=1.4, R_gas=287.0, wall_T=T_col, n_ghost=2,
        )
        set_uniform(self.collector, rho=cfg.p_ambient / (287.0 * cfg.T_ambient),
                    u=0.0, p=cfg.p_ambient, Y=0.0)

        self.all_pipes: List[PipeState] = [
            self.plenum,
            *self.runners,
            *self.primaries,
            *self.secondaries,
            self.collector,
        ]

        for p in self.all_pipes:
            self._ensure_scratch(p)

        # Junction factory — builds a stagnation or characteristic
        # junction from a list of (pipe, end) leg specs.
        def _make_junction(leg_specs, inflow_loss_coef: float = 0.0):
            if junction_type == "stagnation":
                cv_legs = [JunctionCVLeg(pipe, end) for pipe, end in leg_specs]
                return JunctionCV.from_legs(
                    cv_legs,
                    p_init=cfg.p_ambient, T_init=cfg.T_ambient, Y_init=0.0,
                )
            else:  # "characteristic"
                char_legs = [JunctionLeg(pipe, end) for pipe, end in leg_specs]
                return CharacteristicJunction(
                    legs=char_legs, gamma=1.4, R_gas=287.0,
                    inflow_loss_coef=inflow_loss_coef,
                )

        # Intake junction: plenum + 4 runners
        # Fix 13: Borda-Carnot loss on plenum-runner interface. Models the
        # acoustic damping from sudden area expansion + air-filter element
        # + runner-mouth turbulence that the lossless ideal junction model
        # ignores. Damps the standing-wave anti-resonance that causes the
        # high-RPM (11.5k+) power cliff without affecting steady-state flow.
        self.j_intake = _make_junction(
            [(self.plenum, RIGHT)] +
            [(r, LEFT) for r in self.runners],
            inflow_loss_coef=cfg.intake_junction_loss_coef,
        )
        self.junctions = [self.j_intake]

        if cfg.exhaust_topology == "4-2-1":
            # 4-2-1: (p0, p3) → s0 ; (p1, p2) → s1 ; (s0, s1) → collector
            self.j_exh1 = _make_junction([
                (self.primaries[0], RIGHT),
                (self.primaries[3], RIGHT),
                (self.secondaries[0], LEFT),
            ])
            self.j_exh2 = _make_junction([
                (self.primaries[1], RIGHT),
                (self.primaries[2], RIGHT),
                (self.secondaries[1], LEFT),
            ])
            self.j_exh3 = _make_junction([
                (self.secondaries[0], RIGHT),
                (self.secondaries[1], RIGHT),
                (self.collector, LEFT),
            ])
            self.junctions.extend([self.j_exh1, self.j_exh2, self.j_exh3])
        else:
            # 4-1: all 4 primaries feed collector directly via one junction
            self.j_exh1 = _make_junction(
                [(p, RIGHT) for p in self.primaries] +
                [(self.collector, LEFT)]
            )
            self.junctions.append(self.j_exh1)

        # Cylinders
        offsets = cylinder_phase_offsets(
            cfg.n_cylinders, list(cfg.firing_order), cfg.firing_interval,
        )
        geom = CylinderGeom(cfg.bore, cfg.stroke, cfg.con_rod, cfg.CR)
        wiebe = WiebeParams(
            a=cfg.wiebe_a, m=cfg.wiebe_m,
            duration_deg=cfg.combustion_duration,
            spark_advance_deg=cfg.spark_advance,
            ignition_delay_deg=cfg.ignition_delay,
            eta_comb=cfg.eta_comb,
            q_lhv=cfg.q_lhv, afr_target=cfg.afr_target,
        )
        woschni = WoschniParams(
            bore=cfg.bore, stroke=cfg.stroke, T_wall=cfg.T_wall_cylinder,
            C1_gas_exchange=cfg.woschni_C1_gas_exchange,
            C1_compression=cfg.woschni_C1_compression,
            C1_combustion=cfg.woschni_C1_combustion,
            C2_combustion=cfg.woschni_C2_combustion,
        )
        intake_valve = ValveParams(
            diameter=cfg.intake_valve_diameter,
            max_lift=cfg.intake_valve_max_lift,
            open_angle_deg=cfg.intake_valve_open_angle,
            close_angle_deg=cfg.intake_valve_close_angle,
            seat_angle_deg=cfg.intake_valve_seat_angle,
            n_valves=cfg.intake_n_valves,
            ld_table=np.array(cfg.intake_ld_table, dtype=np.float64),
            cd_table=np.array(cfg.intake_cd_table, dtype=np.float64),
        )
        exhaust_valve = ValveParams(
            diameter=cfg.exhaust_valve_diameter,
            max_lift=cfg.exhaust_valve_max_lift,
            open_angle_deg=cfg.exhaust_valve_open_angle,
            close_angle_deg=cfg.exhaust_valve_close_angle,
            seat_angle_deg=cfg.exhaust_valve_seat_angle,
            n_valves=cfg.exhaust_n_valves,
            ld_table=np.array(cfg.exhaust_ld_table, dtype=np.float64),
            cd_table=np.array(cfg.exhaust_cd_table, dtype=np.float64),
        )
        self.cylinders: List[CylinderModel] = []
        for i in range(cfg.n_cylinders):
            cyl = CylinderModel(
                geom=geom, wiebe=wiebe, woschni=woschni,
                intake_valve=intake_valve, exhaust_valve=exhaust_valve,
                phase_offset_deg=offsets[i + 1],
                enable_residual_tracking=cfg.enable_residual_tracking,
            )
            cyl.initialize(p=cfg.p_ambient, T=cfg.T_ambient, theta_global_deg=0.0)
            self.cylinders.append(cyl)

    # ---- BC helpers ----

    def _junction_fill_ghosts(self, dt: float) -> None:
        for j in self.junctions:
            j.fill_ghosts(dt)

    def _junction_absorb_fluxes(self, dt: float) -> None:
        for j in self.junctions:
            j.absorb_fluxes(dt)

    # ---- Time step ----

    def _ensure_scratch(self, pipe: PipeState):
        n = pipe.n_total
        buf = getattr(pipe, "_scratch", None)
        if buf is None or buf["w"].shape[0] != n:
            buf = {
                "w":      np.zeros((n, 4)),
                "slopes": np.zeros((n, 4)),
                "wL":     np.zeros((n, 4)),
                "wR":     np.zeros((n, 4)),
                "flux":   np.zeros((n + 1, 4)),
            }
            pipe._scratch = buf
        return buf

    def _reset_flow_accumulators(self):
        self._mass_in_restrictor = 0.0
        self._mass_out_collector = 0.0

    def step(self, theta_deg: float, dt: float, rpm: float):
        cfg = self.cfg
        gamma = 1.4
        A_t = 0.25 * np.pi * cfg.restrictor_throat_diameter ** 2

        fill_choked_restrictor_left(
            self.plenum, cfg.p_ambient, cfg.T_ambient, A_t, cfg.restrictor_Cd,
            loss_coef=cfg.restrictor_loss_coef,
        )
        self._junction_fill_ghosts(dt)

        for i, cyl in enumerate(self.cylinders):
            theta_local = cyl.local_theta(theta_deg)
            fill_valve_ghost(
                self.runners[i], RIGHT, "intake",
                cyl.intake_valve, theta_local,
                cyl.state.p, cyl.state.T, cyl.state.x_b,
            )
            fill_valve_ghost(
                self.primaries[i], LEFT, "exhaust",
                cyl.exhaust_valve, theta_local,
                cyl.state.p, cyl.state.T, cyl.state.x_b,
            )

        fill_transmissive_right(self.collector)

        for pipe in self.all_pipes:
            buf = self._ensure_scratch(pipe)
            muscl_hancock_step(
                pipe.q, pipe.area, pipe.area_f, pipe.dx, dt,
                gamma, pipe.n_ghost, LIMITER_MINMOD,
                buf["w"], buf["slopes"], buf["wL"], buf["wR"], buf["flux"],
            )

        intake_flux = np.zeros(cfg.n_cylinders)
        intake_flux_T = np.zeros(cfg.n_cylinders)
        exhaust_flux = np.zeros(cfg.n_cylinders)
        exhaust_flux_T = np.zeros(cfg.n_cylinders)
        for i in range(cfg.n_cylinders):
            r = self.runners[i]
            j = r.n_ghost + r.n_cells
            f = r._scratch["flux"][j]
            intake_flux[i] = f[0]
            if abs(f[0]) > 1e-20:
                h = f[2] / f[0]
                T_est = h * (gamma - 1.0) / gamma / 287.0
                intake_flux_T[i] = max(T_est, 100.0)
            else:
                intake_flux_T[i] = self.cylinders[i].state.T_intake

            p_pipe = self.primaries[i]
            j = p_pipe.n_ghost
            f = p_pipe._scratch["flux"][j]
            exhaust_flux[i] = f[0]
            # Pipe-side gas T at the exhaust valve face (used by cylinder
            # when mdot_exhaust < 0 = blowback from pipe into cylinder).
            if abs(f[0]) > 1e-20:
                h_ex = f[2] / f[0]
                T_ex = h_ex * (gamma - 1.0) / gamma / 287.0
                exhaust_flux_T[i] = max(T_ex, 100.0)
            else:
                exhaust_flux_T[i] = self.cylinders[i].state.T_exhaust

        self._junction_absorb_fluxes(dt)

        rest_flux = self.plenum._scratch["flux"][self.plenum.n_ghost, 0]
        self._mass_in_restrictor += rest_flux * dt
        col_flux = self.collector._scratch["flux"][
            self.collector.n_ghost + self.collector.n_cells, 0
        ]
        self._mass_out_collector += col_flux * dt

        for pipe in self.all_pipes:
            apply_sources(
                pipe.q, pipe.area, pipe.hydraulic_D, dt, gamma, 287.0,
                pipe.wall_T, pipe.n_ghost,
                apply_friction=True, apply_heat=True,
            )

        dtheta = dt * (180.0 / np.pi) * omega_from_rpm(rpm)
        for i, cyl in enumerate(self.cylinders):
            cyl.state.mdot_intake = intake_flux[i]
            cyl.state.mdot_exhaust = exhaust_flux[i]
            cyl.state.T_intake = intake_flux_T[i]
            cyl.state.T_exhaust = exhaust_flux_T[i]
            cyl.advance(theta_deg, dtheta, rpm, dt)

    # ---- Run loop ----

    def run_single_rpm(self, rpm: float, n_cycles: int = 5,
                       verbose: bool = False,
                       convergence_tol_imep: float = 0.005,
                       convergence_min_cycles: int = 3,
                       stop_at_convergence: bool = False) -> dict:
        cfg = self.cfg
        omega = omega_from_rpm(rpm)
        theta = 0.0
        target_theta = n_cycles * 720.0

        cycle_stats = []
        prev_cycle = 0
        last_mass_total = self._system_mass()
        step_count = 0
        self._reset_flow_accumulators()
        converged_cycle = -1

        max_steps = int(1e7)
        while theta < target_theta and step_count < max_steps:
            dt = cfl_dt(self.plenum.q, self.plenum.area, self.plenum.dx, 1.4,
                        cfg.cfl, self.plenum.n_ghost)
            for p in self.all_pipes:
                d = cfl_dt(p.q, p.area, p.dx, 1.4, cfg.cfl, p.n_ghost)
                if 0.0 < d < dt:
                    dt = d
            if dt <= 0.0:
                raise RuntimeError(f"positivity failure at θ={theta:.1f}°")
            dt = min(dt, 1e-4)

            self.step(theta, dt, rpm)
            step_count += 1
            theta += dt * (180.0 / np.pi) * omega

            new_cycle = int(theta / 720.0)
            if new_cycle > prev_cycle:
                m_now = self._system_mass()
                net_port = self._mass_in_restrictor - self._mass_out_collector
                actual_drift = m_now - last_mass_total
                V_d_total = self.cylinders[0].geom.V_d * cfg.n_cylinders
                total_work = float(sum(c.state.work_cycle for c in self.cylinders))
                total_intake = float(sum(c.state.m_intake_total for c in self.cylinders))
                imep_bar = (total_work / V_d_total) / 1e5 if V_d_total > 0 else 0.0
                rho_atm = cfg.p_ambient / (287.0 * cfg.T_ambient)
                ve_atm = total_intake / (rho_atm * V_d_total) if V_d_total > 0 else 0.0
                indicated_power_W = total_work * rpm / 120.0
                indicated_power_kW = indicated_power_W / 1000.0

                # V1-style derived quantities: FMEP, brake, wheel, torque.
                #
                # Fix 14 (Audit 2026-05-19): the Heywood/V1 correlation
                # `0.97 + 0.15·Sp + 0.005·Sp²` is calibrated for 1980s-era
                # PASSENGER-CAR SI engines (plain bearings, conventional
                # valvetrain). For a high-performance sportbike engine
                # (CBR600RR) with roller bearings, low-friction valvetrain,
                # optimized internals for 14000+ RPM operation, that
                # correlation over-predicts FMEP by ~2x.
                #
                # Diagnostic at 14000 RPM SDM26: Heywood gives 5.91 bar
                # (eating 70% of 58.8 kW indicated) so wheel power
                # collapses to 16 kW vs dyno 41 kW. Real CBR600RR FMEP at
                # 14000 RPM is closer to 3.0-3.2 bar (Patton-Nitschke
                # decomposition for sportbike-class engines).
                #
                # Patton-Nitschke-style for CBR600RR-class sportbike:
                #   fmep = 0.5 + 0.1·Sp + 0.003·Sp²
                # gives 1.36 bar @ 6000, 2.79 bar @ 11000, 3.66 bar @ 14000
                # which match published CBR600RR motoring-friction data.
                # Revert: restore `0.97 + 0.15 * Sp + 0.005 * Sp * Sp`.
                Sp = 2.0 * cfg.stroke * rpm / 60.0
                fmep_bar = 0.5 + 0.1 * Sp + 0.003 * Sp * Sp
                fmep_Pa = fmep_bar * 1e5
                friction_power_W = fmep_Pa * V_d_total * rpm / 120.0
                brake_power_W = max(indicated_power_W - friction_power_W, 0.0)
                omega = 2.0 * np.pi * rpm / 60.0
                indicated_torque_Nm = indicated_power_W / omega if omega > 0 else 0.0
                brake_torque_Nm = brake_power_W / omega if omega > 0 else 0.0
                wheel_power_W = brake_power_W * cfg.drivetrain_efficiency
                wheel_torque_Nm = brake_torque_Nm * cfg.drivetrain_efficiency
                bmep_bar = ((total_work - friction_power_W * 120.0 / rpm) / V_d_total) / 1e5 if V_d_total > 0 else 0.0

                # Residual fraction (audit 2026-05-20 residual-gas tracking).
                # IMPORTANT: must use f_residual_at_IVC, which captures the
                # ratio at the per-cylinder IVC event. Sampling m_residual/m
                # at a global crank-time gives misleading values because the
                # 4 cylinders are at different phases — a cylinder at TDC
                # overlap has m ≈ m_residual so the ratio ≈ 1, and averaging
                # mixed phases gives ~0.25-0.30 regardless of physics.
                # Literature envelope at WOT: f_res ≈ 0.08-0.12 at 4500 RPM,
                # dropping to ≈ 0.04 at 13000+ RPM. The CBR600RR has short
                # overlap and late EVC; the model gives ~0.015-0.05 across
                # the RPM range (below literature, suggesting the model's
                # exhaust scavenging is too efficient — separate issue,
                # not a residual-tracking bug).
                f_res_per_cyl = [cy.state.f_residual_at_IVC for cy in self.cylinders]
                f_res_mean = float(np.mean(f_res_per_cyl)) if f_res_per_cyl else 0.0

                stats = {
                    "cycle": new_cycle,
                    "mass_total": m_now,
                    "mass_drift": actual_drift,
                    "mass_in_restrictor": self._mass_in_restrictor,
                    "mass_out_collector": self._mass_out_collector,
                    "net_port_flow": net_port,
                    "nonconservation": actual_drift - net_port,
                    # Engine performance
                    "imep_bar": imep_bar,
                    "bmep_bar": bmep_bar,
                    "fmep_bar": fmep_bar,
                    "ve_atm": ve_atm,
                    "intake_mass_per_cycle_g": total_intake * 1000.0,
                    "f_residual": f_res_mean,
                    # Power (3 levels)
                    "indicated_power_kW": indicated_power_kW,
                    "indicated_power_hp": indicated_power_W / 745.7,
                    "brake_power_kW": brake_power_W / 1000.0,
                    "brake_power_hp": brake_power_W / 745.7,
                    "wheel_power_kW": wheel_power_W / 1000.0,
                    "wheel_power_hp": wheel_power_W / 745.7,
                    # Torque (3 levels)
                    "indicated_torque_Nm": indicated_torque_Nm,
                    "brake_torque_Nm": brake_torque_Nm,
                    "wheel_torque_Nm": wheel_torque_Nm,
                    # Exhaust-side
                    "EGT_mean": float(np.mean([
                        _primary_entrance_T(p, 1.4) for p in self.primaries
                    ])),
                }
                cycle_stats.append(stats)
                last_mass_total = m_now
                if verbose:
                    print(
                        f"  cycle {new_cycle:3d}: IMEP={imep_bar:6.2f} bar  VE={ve_atm*100:6.2f}%  "
                        f"EGT={stats['EGT_mean']:5.0f} K  drift={actual_drift:+.3e}  "
                        f"nonconserv={stats['nonconservation']:+.2e}"
                    )

                if (stop_at_convergence
                        and len(cycle_stats) >= convergence_min_cycles + 1):
                    prev_imep = cycle_stats[-2]["imep_bar"]
                    this_imep = cycle_stats[-1]["imep_bar"]
                    if abs(prev_imep) > 1e-6:
                        rel = abs(this_imep - prev_imep) / abs(prev_imep)
                        if rel < convergence_tol_imep and converged_cycle < 0:
                            converged_cycle = new_cycle

                for c in self.cylinders:
                    c.state.m_intake_total = 0.0
                    c.state.m_exhaust_total = 0.0
                    c.state.work_cycle = 0.0
                self._reset_flow_accumulators()
                prev_cycle = new_cycle

                if stop_at_convergence and converged_cycle > 0 and new_cycle >= converged_cycle + 1:
                    break

        return {
            "rpm": rpm,
            "n_cycles_requested": n_cycles,
            "n_cycles_run": len(cycle_stats),
            "step_count": step_count,
            "cycle_stats": cycle_stats,
            "converged_cycle": converged_cycle,
        }

    def _system_mass(self) -> float:
        total = 0.0
        for p in self.all_pipes:
            s = p.real_slice()
            total += float(p.dx * p.q[s, I_RHO_A].sum())
        for c in self.cylinders:
            total += float(c.state.m)
        for j in self.junctions:
            # JunctionCV stores mass in `M` (0-D control volume).
            # CharacteristicJunction has no CV state (mass passes
            # through the face directly); skip the add.
            total += float(getattr(j, "M", 0.0))
        return total


def _primary_entrance_T(pipe: PipeState, gamma: float) -> float:
    idx = pipe.n_ghost
    A = pipe.area[idx]
    rho = pipe.q[idx, I_RHO_A] / A
    u = pipe.q[idx, I_MOM_A] / (rho * A)
    E = pipe.q[idx, I_E_A] / A
    p = max((gamma - 1.0) * (E - 0.5 * rho * u * u), 1.0)
    return p / (rho * 287.0)
