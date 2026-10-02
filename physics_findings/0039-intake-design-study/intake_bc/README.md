# Intake boundary traces from the 1D engine model (for the Fluent 3D whole-intake runs)

Files: `intake_{asbuilt,big}_{9000,6000,11500}rpm.csv`, one 720° cycle (the 20th) at 1° of crank, WOT. `summary_1d.csv` holds the 1D result for each case. Made by `intake_bc.py` with `driver/src/bin/intakewave.rs`.

**Source run.** The all-measured car (`cfg/ASMEASURED_all.json`): runners 252 mm on cylinders 1 and 4, 230 mm on cylinders 2 and 3 (mouth to head flange) plus an 80 mm head port, real exhaust lengths, logged AFR and spark maps, 160-cell plenum, venturi inertance 400 1/m, runner entry K 0.2.

| case | plenum volume | plenum height | 1D shape |
|---|---|---|---|
| `asbuilt` | 1.825 L | 140.9 mm | dome, 38 mm at the restrictor to 173.5 mm at the floor |
| `big` | 4.025 L | 233.9 mm | the same dome plus a 93 mm straight section at 173.5 mm |

The 1D plenum is one duct along the restrictor axis, restrictor at one end and all four runners at the other. Its base diameter (173.5 mm) is larger than the CAD's 167 mm because the dome is scaled to the measured volume; the big case is therefore 4.03 L where the CAD version is about 3.86 L.

## Columns

`theta_deg` is the global crank angle and `t_s` the time.

| column | meaning |
|---|---|
| `mdot_restrictor_kg_s` | mass flow through the restrictor (lagged venturi flow) |
| `p_plenum_exit_Pa` | plenum static pressure at the restrictor exit plane |
| `p_plenum_map_Pa` | plenum static pressure 110 mm downstream of the restrictor exit (MAP port station) |
| `p_plenum_floor_Pa`, `T_plenum_floor_K` | plenum static pressure and temperature at the runner mouths |
| `p_plenum_mean_Pa` | volume mean of the plenum static pressure |

Then, for each cylinder i = 1..4:

| column | meaning |
|---|---|
| `phase{i}_deg` | that cylinder's own crank angle: 0 = firing TDC, gas-exchange TDC at 360°, BDC at 540° |
| `mdot_valve{i}_kg_s` | mass flow through the intake valves, mean over the 1° interval, positive into the cylinder, negative = backflow |
| `T_valve{i}_K` | temperature of the gas crossing the valve |
| `p_cyl{i}_Pa`, `T_cyl{i}_K` | cylinder pressure and temperature |
| `p_port{i}_Pa`, `T_port{i}_K`, `u_port{i}_m_s`, `mdot_port{i}_kg_s` | static pressure, static temperature, velocity and mass flow in the runner's last cell (at the valve) |
| `..._flange{i}_...` | the same in the cell at the head flange, 80 mm upstream of the valve |
| `..._mouth{i}_...` | the same in the runner's first cell (at the plenum) |

Velocity and mass flow are positive toward the cylinder.

## Phasing

Firing order 1-2-4-3 at 180° intervals. At `theta_deg` = 0, cylinder 1 is at its firing TDC. The columns are already phased.

## Engine data (not model results)

- Bore 67.0 mm, stroke 42.5 mm, connecting rod 96.3 mm, compression ratio 12.2, four cylinders, 599 cc.
- Two intake valves per cylinder, 27.5 mm head diameter, 8.56 mm maximum lift, 45° seat.
- Intake timing at 1 mm lift: opens 339°, closes 584° on the cylinder's own crank angle (21° before TDC, 44° after BDC).
- Lift curve used by the model: `L = 8.56 mm x sin^1.3(pi x tau)` over the seat-to-seat window 321.8° to 601.2°, which passes through 1 mm at the two quoted events.
- Valve discharge coefficient against lift / diameter: 0.05: 0.19, 0.10: 0.38, 0.15: 0.494, 0.20: 0.551, 0.25: 0.57, 0.30: 0.57 (reference area in `crates/engine-sim/src/cylinder/valve.rs`, `valve_reference_area`).
- Ambient 97.3 kPa, 305 K.

## What the 1D model says for this pair

| rpm | VE as-built | VE big | change | plenum swing at the mouths, as-built / big |
|---|---|---|---|---|
| 6000 | 0.932 | 0.940 | +0.9 % | 4.0 / 2.9 kPa |
| 9000 | 0.947 | 0.955 | +0.8 % | 11.2 / 6.6 kPa |
| 11500 | 0.826 | 0.819 | -0.8 % | 3.0 / 3.6 kPa |

VE is referenced to ambient density. At 9000 rpm the gain is on the inner cylinders (2 and 3: +2.0 % and +2.2 %); the outer ones lose 0.4 %.

Regenerated 2026-10-02: `mdot_valve` is now the mean over each 1° interval (from the cylinder's mass ledger). The earlier point samples chattered by 10-30 g/s between neighbouring degrees when cylinder and port pressure were close, which also put up to 0.6 % of error in the trapped-mass sums; the numbers above are the corrected ones.
