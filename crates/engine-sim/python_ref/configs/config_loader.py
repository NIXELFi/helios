"""Load V1-compatible JSON configs into an SDM26Config.

V1's JSON format is the schema in `1d/engine_simulator/config/*.json`
(we've copied two of them to `1d_v2/configs/sdm25.json` and
`1d_v2/configs/sdm26.json`). This loader maps those fields onto
SDM26Config. V1 fields that V2 doesn't model (artificial_viscosity,
roughness) are ignored.

Auto-detects topology: if `exhaust_secondaries` is non-empty, 4-2-1;
otherwise 4-1. Asymmetric primaries and secondaries are captured via
the per-cylinder list fields.
"""

from __future__ import annotations

import json
from pathlib import Path

from models.sdm26 import SDM26Config


def load_v1_json(path: str | Path) -> SDM26Config:
    data = json.loads(Path(path).read_text())

    cyl = data["cylinder"]
    iv = data["intake_valve"]
    ev = data["exhaust_valve"]
    runners = data["intake_pipes"]
    primaries = data["exhaust_primaries"]
    secondaries = data.get("exhaust_secondaries", []) or []
    collector = data["exhaust_collector"]
    comb = data["combustion"]
    restr = data["restrictor"]
    plen = data["plenum"]

    topology = "4-2-1" if len(secondaries) == 2 else "4-1"

    # Convert Cd tables from V1 [[L/D, Cd], ...] format to separate tuples
    def _unpack_cd(rows):
        ld = tuple(float(r[0]) for r in rows)
        cd = tuple(float(r[1]) for r in rows)
        return ld, cd
    intake_ld, intake_cd = _unpack_cd(iv["cd_table"])
    exhaust_ld, exhaust_cd = _unpack_cd(ev["cd_table"])

    # Per-pipe overrides if runners/primaries/secondaries are non-uniform
    def _all_same(values):
        return all(abs(v - values[0]) < 1e-12 for v in values)

    runner_lengths = [p["length"] for p in runners]
    runner_diameters_in = [p["diameter"] for p in runners]
    runner_diameters_out = [p.get("diameter_out") for p in runners]
    runner_wall_Ts = [p["wall_temperature"] for p in runners]

    primary_lengths = [p["length"] for p in primaries]
    primary_diameters_in = [p["diameter"] for p in primaries]
    primary_diameters_out = [p.get("diameter_out") for p in primaries]
    primary_wall_Ts = [p["wall_temperature"] for p in primaries]

    secondary_lengths = [p["length"] for p in secondaries] if secondaries else None
    secondary_diameters_in = [p["diameter"] for p in secondaries] if secondaries else None
    secondary_diameters_out = [p.get("diameter_out") for p in secondaries] if secondaries else None
    secondary_wall_Ts = [p["wall_temperature"] for p in secondaries] if secondaries else None

    # Scalar defaults from first pipe; per-cylinder lists attached only if non-uniform
    kwargs = dict(
        # Engine geom
        bore=cyl["bore"], stroke=cyl["stroke"], con_rod=cyl["con_rod_length"],
        CR=cyl["compression_ratio"],
        n_cylinders=data["n_cylinders"],
        firing_order=tuple(data["firing_order"]),
        firing_interval=float(data["firing_interval"]),
        # Intake runners
        runner_length=runner_lengths[0],
        runner_diameter_in=runner_diameters_in[0],
        runner_diameter_out=runner_diameters_out[0],
        runner_n_cells=runners[0]["n_points"],
        runner_wall_T=runner_wall_Ts[0],
        # Exhaust primaries
        primary_length=primary_lengths[0],
        primary_diameter_in=primary_diameters_in[0],
        primary_diameter_out=primary_diameters_out[0],
        primary_n_cells=primaries[0]["n_points"],
        primary_wall_T=primary_wall_Ts[0],
        # Exhaust collector
        collector_length=collector["length"],
        collector_diameter_in=collector["diameter"],
        collector_diameter_out=collector.get("diameter_out"),
        collector_n_cells=collector["n_points"],
        collector_wall_T=collector["wall_temperature"],
        # Plenum
        plenum_volume=plen["volume"],
        # Restrictor
        restrictor_throat_diameter=restr["throat_diameter"],
        restrictor_Cd=restr["discharge_coefficient"],
        # Ambient
        p_ambient=data["p_ambient"],
        T_ambient=data["T_ambient"],
        # Combustion
        wiebe_a=comb["wiebe_a"],
        wiebe_m=comb["wiebe_m"],
        combustion_duration=comb["combustion_duration"],
        spark_advance=comb["spark_advance"],
        ignition_delay=comb["ignition_delay"],
        eta_comb=comb["combustion_efficiency"],
        q_lhv=comb["q_lhv"],
        afr_target=comb["afr_target"],
        # Valves
        intake_valve_diameter=iv["diameter"],
        intake_valve_max_lift=iv["max_lift"],
        intake_valve_open_angle=iv["open_angle"],
        intake_valve_close_angle=iv["close_angle"],
        intake_valve_seat_angle=iv["seat_angle"],
        intake_n_valves=cyl.get("n_intake_valves", 2),
        intake_ld_table=intake_ld,
        intake_cd_table=intake_cd,
        exhaust_valve_diameter=ev["diameter"],
        exhaust_valve_max_lift=ev["max_lift"],
        exhaust_valve_open_angle=ev["open_angle"],
        exhaust_valve_close_angle=ev["close_angle"],
        exhaust_valve_seat_angle=ev["seat_angle"],
        exhaust_n_valves=cyl.get("n_exhaust_valves", 2),
        exhaust_ld_table=exhaust_ld,
        exhaust_cd_table=exhaust_cd,
        # Topology + drivetrain
        exhaust_topology=topology,
        drivetrain_efficiency=data.get("drivetrain_efficiency", 0.91),
    )

    # Attach per-cylinder lists only if pipes are non-uniform (else let the
    # scalar default do the work)
    if not _all_same(runner_lengths):
        kwargs["runner_lengths"] = runner_lengths
    if not _all_same(runner_diameters_in):
        kwargs["runner_diameters_in"] = runner_diameters_in
    if not _all_same(primary_lengths):
        kwargs["primary_lengths"] = primary_lengths
    if not _all_same(primary_diameters_in):
        kwargs["primary_diameters_in"] = primary_diameters_in
    if topology == "4-2-1":
        kwargs["secondary_length"] = secondary_lengths[0]
        kwargs["secondary_diameter_in"] = secondary_diameters_in[0]
        kwargs["secondary_diameter_out"] = secondary_diameters_out[0]
        kwargs["secondary_n_cells"] = secondaries[0]["n_points"]
        kwargs["secondary_wall_T"] = secondary_wall_Ts[0]

    # V1 uses physically-cold exhaust wall T tuned against its entropy bug.
    # For an apples-to-apples comparison we use V1's numbers verbatim here
    # (the whole point of the comparison is "same config, different scheme").

    return SDM26Config(**kwargs)
