// Vehicle model + FSAE competition-scoring types (frontend-only). The optimizer
// samples server-side with a space-filling LHS/random sampler, and every trial
// already carries its full torque curve (OptimizationTrial.sweepPoints) — so all
// scoring lives here in the frontend: it re-scores stored trials to the same
// winner a backend objective would pick, and works on already-completed studies.

export interface VehicleConfig {
  name: string;
  /** Running mass incl. driver (and any fuel load), kg. */
  massKg: number;
  /** Fraction of static weight on the front axle (0..1). */
  weightDistFront: number;
  cgHeightM: number;
  wheelbaseM: number;
  trackWidthM: number;
  /** Loaded/rolling tire radius (m) — converts wheel speed ↔ engine rpm. */
  tireRadiusM: number;
  muLong: number;
  muLat: number;
  /** Drag area Cd·A (m²). */
  cdaM2: number;
  /** Downforce area Cl·A (m², positive = downforce). Used from P2 on. */
  claM2: number;
  airDensityKgM3: number;
  /** Rolling-resistance coefficient. */
  crr: number;
  /** Driveline mechanical efficiency (0..1). */
  drivetrainEff: number;
  /** Gearbox ratios, index 0 = 1st gear (stock CBR600RR by default). */
  gearRatios: number[];
  /** Primary reduction (crankshaft → gearbox input shaft). */
  primaryReduction: number;
  /** Final-drive (sprocket) ratio = rear teeth / front teeth. */
  finalDrive: number;
  shiftRpm: number;
  revLimitRpm: number;
  /** Lost-drive time per gearshift (s) — clutchless / quickshift. */
  shiftTimeS: number;
}

/** Per-event reference (from last year's published results) for projecting FSAE
 *  points. P1 uses only `accelTMin`; autocross/endurance/efficiency land in P2. */
export interface ReferenceBaseline {
  accelTMin: number | null;
  /** Fastest autocross corrected time (s). */
  autocrossTMin: number | null;
  /** Fastest endurance time, per lap (s). */
  enduranceTMin: number | null;
  /** Lowest CO₂ per lap in the field (kg) — for the efficiency factor. */
  co2MinPerLap: number | null;
  /** Eligibility-cap CO₂ per lap (kg) — sets the efficiency-score floor. */
  co2MaxPerLap: number | null;
}
