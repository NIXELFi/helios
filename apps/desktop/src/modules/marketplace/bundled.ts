// Bundled plugins — sandboxed add-ons that SHIP WITH Helios. Their bundle lives in
// public/plugins/<id>/ and is served locally, so they're always available with no
// backend round-trip and no verified-install step. Unlike a first-party "Built-in"
// app (firstParty.tsx — native code, full access), a bundled plugin still runs in
// the SAME locked-down sandbox as a marketplace plugin; it just doesn't need
// downloading. Lap Sim is the first: an independently-versioned vehicle-dynamics
// tool that ships in every build.

export interface BundledPlugin {
  id: string;
  name: string;
  subteam: string;
  /** The plugin's OWN version (independent of the Helios app version). */
  version: string;
  description: string;
  /** Local, app-served base URL — manifest.json + the entry live under here. */
  baseUrl: string;
}

export const BUNDLED_PLUGINS: BundledPlugin[] = [
  {
    id: "vehicle-dynamics.lap-sim",
    name: "Lap Sim",
    subteam: "Vehicle Dynamics",
    version: "0.1.0",
    description:
      "Point-mass lap-time simulation over the 2026 FSAE event tracks — limit-state solver, sector splits, A/B compare and CSV export. Ships with Helios and runs fully sandboxed; takes a default engine sweep you can later feed from CFD.",
    baseUrl: "/plugins/lap-sim",
  },
];
