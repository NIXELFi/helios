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
  /** Tire load-sensitivity exponent (0..~0.3). Grip μ falls as vertical load
   *  rises: μ_eff = μ · (Fz/Fz_static)^(−sens). 0 = load-independent (flat μ).
   *  For racing slicks ~0.1–0.2 — this is why aero downforce buys less grip than
   *  the naive μ·Fz, and why a fast corner doesn't pull μ·(1+downforce) g. */
  tireLoadSensitivity: number;
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
  /** Optional measured tire model distilled from an imported .tir file
   *  (Pacejka MF6.x peak friction vs load). When present it REPLACES
   *  muLat/muLong + tireLoadSensitivity with the fitted μ(Fz) law; the
   *  surface scale inside is the one calibration knob. Loaded at runtime —
   *  tire fit data is proprietary and never ships in the repo. */
  tire?: import("./tir").TirGrip;
  /** Optional roll-balance model (from the team's ARB/RSD calculators).
   *  When present, the cornering limit is computed PER AXLE: lateral load
   *  transfer splits by roll-stiffness distribution + roll-center geometry,
   *  each axle saturates on its own μ(Fz), and the car's limit is whichever
   *  axle gives up first (understeer/oversteer balance). Absent → the
   *  legacy lumped-axle χ model. */
  roll?: RollConfig;
}

/** Roll-balance parameters. Source: ARB calculator / RSD test sheet. */
export interface RollConfig {
  /** Front share of total roll stiffness (0..1) — the ARB setting knob. */
  rsdFront: number;
  /** CG-to-roll-axis moment arm (m). */
  hRollArmM: number;
  /** Front / rear roll-center heights (m). */
  rcFrontM: number;
  rcRearM: number;
  /** Front share of total aero downforce (0..1). */
  aeroFrontFrac: number;
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
  /** Field min/max efficiency FACTOR (EF) — the efficiency-score anchors
   *  (§D.13.4.6). When both are present the score uses them directly; otherwise
   *  it approximates EFmin from the CO₂ ratio and takes EFmax = 1. */
  effMin?: number | null;
  effMax?: number | null;
}
