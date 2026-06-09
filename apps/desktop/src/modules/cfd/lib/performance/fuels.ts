// FSAE-approved competition fuels (Sunoco) and their properties for the energy
// → fuel → CO₂ chain in the lap sim. Octane's PERFORMANCE effect (knock-limited
// spark/boost → more torque) lives in the engine config / torque curve, NOT
// here; these props only drive the efficiency-event fuel + CO₂ accounting:
//   fuel mass = propulsive work / (thermalEff · LHV); CO₂ = (mass / density)·CO₂/L.
//
// CO₂ factors are the FSAE §D.13.4.1 values (gasoline 2.31, E85 1.65 kg/L).

export interface Fuel {
  key: string;
  label: string;
  /** Lower heating value, MJ/kg. */
  lhvMJkg: number;
  /** Density, kg/L. */
  densityKgL: number;
  /** CO₂ emitted per litre burned, kg/L (§D.13.4.1). */
  co2PerL: number;
  /** Stoichiometric air/fuel ratio. */
  afrStoich: number;
  /** Engine-sim lower heating value, J/kg — what the config's `q_lhv` is set
   *  to when this fuel is selected. (Distinct from `lhvMJkg`, which is the
   *  Sunoco-datasheet scoring value; the engine default for gasoline is the
   *  generic 44.0e6 so picking Sunoco 93 is a no-op on a stock config.) */
  qLhvJkg: number;
  /** Rich-of-stoich run AFR (config `afr_target`) chosen to hold the same
   *  equivalence ratio φ ≈ 1.12 across fuels (E85 burns much richer by mass). */
  afrTarget: number;
}

export const FUELS: Record<string, Fuel> = {
  // Sunoco 93-octane unleaded (what SDM runs in Arizona) — the gasoline default.
  sunoco93: { key: "sunoco93", label: "Sunoco 93", lhvMJkg: 43.0, densityKgL: 0.745, co2PerL: 2.31, afrStoich: 14.7, qLhvJkg: 44.0e6, afrTarget: 13.1 },
  // Sunoco 260 GTX 100-octane unleaded — gasoline-class CO₂; octane buys knock margin in the engine model.
  sunoco100: { key: "sunoco100", label: "Sunoco 260 GTX (100)", lhvMJkg: 43.0, densityKgL: 0.751, co2PerL: 2.31, afrStoich: 14.7, qLhvJkg: 44.0e6, afrTarget: 13.1 },
  // Sunoco E85-R — far lower CO₂/L + energy density; richer by mass (afr_stoich
  // 9.76) so afr_target drops to hold φ. Net energy/charge ≈ gasoline.
  e85: { key: "e85", label: "Sunoco E85-R", lhvMJkg: 29.2, densityKgL: 0.785, co2PerL: 1.65, afrStoich: 9.76, qLhvJkg: 29.2e6, afrTarget: 8.70 },
};

/** Gasoline default (Sunoco 93) used when no fuel is specified. */
export const DEFAULT_FUEL: Fuel = FUELS.sunoco93!;
