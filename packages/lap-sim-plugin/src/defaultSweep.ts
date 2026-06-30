import type { TorqueCurve } from "@helios/lapsim-core";

// PLACEHOLDER default engine sweep — brake torque (Nm) vs rpm, a representative
// restricted FSAE inline-4 (CBR600RR-class) WOT curve. It lets the Lap Sim run
// out of the box with no import. Swap for the team's reference sweep later, or
// override at runtime by importing a dyno CSV / pulling a sweep from CFD.
export const DEFAULT_CURVE: TorqueCurve = [
  { rpm: 4000, torqueNm: 36 },
  { rpm: 5000, torqueNm: 42 },
  { rpm: 6000, torqueNm: 47 },
  { rpm: 7000, torqueNm: 51 },
  { rpm: 8000, torqueNm: 55 },
  { rpm: 9000, torqueNm: 57 },
  { rpm: 10000, torqueNm: 58 },
  { rpm: 11000, torqueNm: 56 },
  { rpm: 12000, torqueNm: 52 },
  { rpm: 13000, torqueNm: 46 },
  { rpm: 13800, torqueNm: 40 },
];

export const DEFAULT_CURVE_LABEL = "Default sweep (CBR600RR-class placeholder)";
