# Exhaust-port boundary traces from the 1D engine model (for the Fluent 3D exhaust run)

Files: `exhaust_ports_{9000,6000,11500}rpm.csv` (the model as calibrated in 0036: primaries 424 mm, secondaries 467 mm) and `exhaust_allmeasured_{9000,6000,11500}rpm.csv` (the all-measured car, `cfg/ASMEASURED_all.json`: primaries 481 mm, secondaries 576 mm, real plenum and runners). Made by `exhaust_bc.py`.

Regenerated 2026-10-02: `mdot_valve` is the mean over each 1° interval. The earlier point samples flipped between two branches from step to step when cylinder and port pressure were within a few kPa (jumps over 30 g/s per degree on up to 35 samples per cylinder); the cycle mass was right, the instantaneous value was not. Each covers one 720° cycle at 1° of crank, the 20th cycle, WOT.

**Source run.** Config `sdm26_asbuilt_cal` with the logged AFR and spark maps, a 160-cell plenum and the venturi inertance on (400 1/m). Driver: `driver/src/bin/exhwave.rs`.

## Columns

`theta_deg` is the global crank angle and `t_s` the time. Then, for each cylinder i = 1..4:

| column | meaning |
|---|---|
| `phase{i}_deg` | that cylinder's own crank angle: 0 = firing TDC; exhaust valve opens at 140°, closes at 365° |
| `mdot_valve{i}_kg_s` | mass flow through the exhaust valves, mean over the 1° interval, positive out of the cylinder, negative = backflow |
| `T_valve{i}_K` | static temperature of the gas crossing the valve |
| `p_cyl{i}_Pa`, `T_cyl{i}_K` | cylinder pressure and temperature |
| `p_port{i}_Pa`, `T_port{i}_K`, `u_port{i}_m_s`, `mdot_port{i}_kg_s` | static pressure, static temperature, velocity and mass flow in the first cell of the primary (at the valve) |

Total temperature = T + u² / (2 cp), with cp = 1278 J/kg/K.

## Phasing

Firing order 1-2-4-3 at 180° intervals. At `theta_deg` = 0, cylinder 1 is at its firing TDC, and cylinders 3, 4 and 2 are at 180°, 360° and 540° of their own cycles. The columns are already phased.

## Model facts

- **Pairing:** primaries 1 & 4 and 2 & 3 join (360° apart), then the two secondaries join. This is unconfirmed from CAD.
- **Gas:** exhaust pipes use a constant gamma = 1.30 and R = 295 J/kg/K (cp 1278 J/kg/K). There is no cp(T).
- **Walls:** primaries 900 K, secondaries 750 K, final collector 650 K. Convective wall heat transfer and friction are on, with roughness 46 µm. The walls are not adiabatic.
- **Primary** (each): 423.9 mm in total.
  - 65 mm head port at 27.65 mm diameter (estimated)
  - 312.3 mm of 29.26 mm ID tube, with the last 10 mm stepping to 35.61 mm
  - 46.6 mm running side by side inside the first collector
- **Secondary** (each): 467.3 mm in total.
  - 59.7 mm merged cone (two 35.61 mm areas into one 35.61 mm)
  - 361 mm of 35.61 mm ID tube
  - 46.6 mm side by side in the second collector
- **Final pipe:** 664.7 mm in total.
  - 59.7 mm merged cone
  - about 100 mm at 41.96 mm ID
  - 48.31 mm ID to the end, including a 305 mm straight-through muffler modelled as plain pipe
- **Termination:** open end at 97.3 kPa with a frequency-dependent reflection (Levine-Schwinger) and a 0.6133 r end correction. No muffler volume, no bend losses.
- **Junctions:** characteristic junctions with momentum; merge half-angle is the config's `exhaust_merge_angle_deg`.

## Totals

| rpm | exhaust mass flow | peak valve flow | port pressure range | valve temperature at peak flow |
|---|---|---|---|---|
| 9000 | 51.1 g/s | 110 g/s | 30-245 kPa | 1296 K |
| 6000 | 30.1 g/s | 77 g/s | 44-161 kPa | 1119 K |
| 11500 | 51.5 g/s | 100 g/s | 46-223 kPa | 1199 K |

## Stations along the exhaust (added 2026-10-02)

`stations_allmeasured_9000rpm.csv` (driver `driver/src/bin/exhstations.rs`): static pressure, static temperature and velocity at the start, middle and end of every primary, secondary and the final pipe, one cycle at 1°. `theta_deg` is cylinder 1's own crank angle.

All-measured car, 9000 rpm, cylinder 1's path:

| station | T mean (K) | T range (K) | flow-weighted T (K) | steepest pressure rise (deg) |
|---|---|---|---|---|
| primary start (valve) | 986 | 779-1203 | | 170 |
| primary middle | 1026 | 864-1203 | 1085 | 181 |
| primary end | 1012 | 877-1157 | 1050 | 199 |
| secondary middle | 970 | 842-1048 | 985 | 226 |
| secondary end | 949 | 902-1011 | 951 | 251 |
| final middle | 940 | 894-1017 | 938 | 278 |
| final end | 908 | 892-936 | | 307 |

The blowdown front takes 137° (2.54 ms) from valve to open end over 1.722 m: 678 m/s.
