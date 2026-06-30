// Tire load-sensitivity, expressed as a "%dropoff per load doubling" — the
// affordance the vehicle team thinks in, mapped exactly onto the grip model's
// stored exponent (`VehicleConfig.tireLoadSensitivity`).
//
// The grip model discounts μ for load as μ_eff = μ·(Fz/Fz_static)^(−sens)
// (lapSim.ts:261). At a DOUBLED vertical load (Fz = 2·Fz_static) that ratio is
// 2^(−sens), so the grip LOST is the fraction 1 − 2^(−sens). Multiplying by 100
// gives the percentage drop per load doubling — a single, physically grounded
// number for the UI chip and the sweep axis. `sens` stays the source of truth
// (stored, fed to makeGripModel); %dropoff is a pure display/input transform.
//
// This is NOT a new physics knob — it restates the existing exponent. Keep them
// in lockstep: dropoffPctFromSens and sensFromDropoffPct are exact inverses.

/** Grip lost per LOAD DOUBLING, as a percentage: (1 − 2^(−sens))·100.
 *  sens = 0 → 0% (load-independent μ); the Hoosier-slick default 0.15 → ~9.87%. */
export function dropoffPctFromSens(sens: number): number {
  const s = Math.max(0, sens);
  return (1 - Math.pow(2, -s)) * 100;
}

/** Inverse of dropoffPctFromSens: recover the stored exponent from a %dropoff.
 *  sens = −log2(1 − dropoffFrac). Clamped so a ≥100% input can't go infinite. */
export function sensFromDropoffPct(dropoffPct: number): number {
  const frac = Math.min(0.999999, Math.max(0, dropoffPct / 100));
  return -Math.log2(1 - frac);
}
