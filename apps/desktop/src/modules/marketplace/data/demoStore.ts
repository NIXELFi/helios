// DEV-ONLY demo data for previewing the Marketplace UI WITHOUT the marketplace
// backend (the `marketplace` Supabase schema isn't applied to prod yet, so the
// real hooks would land on an empty/error state). Gated behind
// VITE_MARKETPLACE_DEMO=1 (or localStorage "helios.mpDemo"="1") — OFF by default,
// so it has ZERO effect on the real app. The fixtures are CFD-themed on purpose:
// this doubles as a preview of where v5 is heading (the CFD tab → plugins, with a
// shared plugin data vault feeding the Lap Sim its tire model / aero map / engine
// sweep).

import type { AvailablePlugin } from "./useMarketplace";
import type { PluginManifest } from "@helios/plugin-sdk";

/** True when the dev demo fixture should stand in for the real backend. */
export function isMarketplaceDemo(): boolean {
  try {
    if (import.meta.env.VITE_MARKETPLACE_DEMO === "1") return true;
    return typeof localStorage !== "undefined" && localStorage.getItem("helios.mpDemo") === "1";
  } catch {
    return false;
  }
}

interface Seed {
  id: string;
  name: string;
  subteam: string;
  version: string;
  permissions: string[];
  recommended: boolean;
  description: string;
  publishedAt: string;
}

const SEEDS: Seed[] = [
  {
    id: "cfd.lap-sim",
    name: "CFD Lap Sim",
    subteam: "Vehicle Dynamics",
    version: "1.0.0",
    permissions: ["storage", "file.read"],
    recommended: true,
    description:
      "Lap-time simulator — channels, limit-state analysis, A/B compare, CSV export. Pulls its tire model, aero map, and engine sweep from the shared plugin vault.",
    publishedAt: "2026-06-29T00:00:00Z",
  },
  {
    id: "vd.tire-model-builder",
    name: "Tire Model Builder",
    subteam: "Vehicle Dynamics",
    version: "1.0.0",
    permissions: ["storage", "file.read", "file.write"],
    recommended: false,
    description: "Fit and publish Pacejka tire models for the Lap Sim and other tools to consume.",
    publishedAt: "2026-06-20T00:00:00Z",
  },
  {
    id: "aero.map-studio",
    name: "Aero Map Studio",
    subteam: "Aero",
    version: "1.2.0",
    permissions: ["storage", "file.write"],
    recommended: true,
    description: "Build and share aero maps (CL/CD vs ride height and yaw) as artifacts other plugins can read.",
    publishedAt: "2026-06-18T00:00:00Z",
  },
  {
    id: "pwt.engine-sweep",
    name: "Engine Sweep Runner",
    subteam: "Powertrain",
    version: "2.1.0",
    permissions: ["engine:matlab", "storage"],
    recommended: false,
    description: "Run engine torque/power sweeps through the curated MATLAB bridge and publish the result.",
    publishedAt: "2026-06-26T00:00:00Z",
  },
  {
    id: "susp.spring-rate",
    name: "Spring Rate & Ride Frequency",
    subteam: "Suspension",
    version: "1.0.0",
    permissions: ["storage", "file.write"],
    recommended: false,
    description: "Spring rate to ride-frequency calculator. The bundled example add-on — launches for real.",
    publishedAt: "2026-06-25T00:00:00Z",
  },
  {
    id: "pwt.gear-ratio",
    name: "Gear Ratio Calculator",
    subteam: "Powertrain",
    version: "1.3.0",
    permissions: [],
    recommended: false,
    description: "Final-drive and gear-ratio sweep. Pure sandbox — no permissions at all.",
    publishedAt: "2026-06-12T00:00:00Z",
  },
];

function toPlugin(s: Seed): AvailablePlugin {
  const manifest: PluginManifest = {
    format: 1,
    id: s.id,
    name: s.name,
    version: s.version,
    description: s.description,
    subteam: s.subteam,
    entry: "dist/index.html",
    sdk: "^1.0.0",
    permissions: s.permissions as PluginManifest["permissions"],
  };
  return {
    id: s.id,
    name: s.name,
    subteam: s.subteam,
    isRecommended: s.recommended,
    version: s.version,
    manifest,
    permissions: s.permissions,
    installedVersion: null,
    publishedAt: s.publishedAt,
  };
}

const PLUGINS = SEEDS.map(toPlugin);

// Seed a couple as already-installed so the Installed tab is populated and one
// has an update available (installed 0.9.0 < approved 1.0.0).
const installed = new Map<string, string>([
  ["vd.tire-model-builder", "0.9.0"],
  ["aero.map-studio", "1.2.0"],
]);

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

export function demoSubscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function demoList(): AvailablePlugin[] {
  return PLUGINS.map((p) => ({ ...p, installedVersion: installed.get(p.id) ?? null }));
}

export function demoInstall(id: string, version: string): void {
  installed.set(id, version);
  notify();
}

export function demoUninstall(id: string): void {
  installed.delete(id);
  notify();
}

/** A local URL the demo can actually launch, or null to show a friendly preview
 *  note. Only the bundled example ships a real, openable bundle. */
export function demoLaunchUrl(id: string): string | null {
  return id === "susp.spring-rate" ? "/plugins/spring-rate" : null;
}
