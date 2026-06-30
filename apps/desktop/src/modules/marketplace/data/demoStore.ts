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
    id: "vehicle-dynamics.lap-sim",
    name: "Lap Sim",
    subteam: "Vehicle Dynamics",
    version: "1.0.0",
    permissions: ["file.write"],
    recommended: true,
    description:
      "FSAE quasi-steady-state lap-time simulator over the 2026 autocross & endurance tracks. Ships with a default engine sweep; import a dyno CSV or pull a sweep from CFD. (The real plugin — launches for real in the sandbox.)",
    publishedAt: "2026-06-30T00:00:00Z",
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
  ["vehicle-dynamics.lap-sim", "1.0.0"],
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

/** Local URLs the demo can actually launch for real, by plugin id. The Lap Sim
 *  ships a real, openable single-file bundle under public/plugins/; everything
 *  else shows a friendly preview note. */
const DEMO_LAUNCHABLE: Record<string, string> = {
  "vehicle-dynamics.lap-sim": "/plugins/lap-sim",
};

export function demoLaunchUrl(id: string): string | null {
  return DEMO_LAUNCHABLE[id] ?? null;
}
