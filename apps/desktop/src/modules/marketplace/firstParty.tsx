// First-party "built-in" apps surfaced in the Marketplace. Unlike a sandboxed
// plugin, a first-party app is trusted Helios code that mounts NATIVELY with full
// access (Tauri, the database client, the filesystem) — so it is launched as a
// React component, not in a sandboxed iframe, and its card is labelled
// "Built-in", NEVER "Sandboxed". This is how the team's flagship modules (CFD
// first) live in the marketplace alongside independently-versioned plugins.
//
// These ship and version WITH Helios (their version is the app version), which is
// exactly why they don't go through the verified-install pipeline — there's
// nothing to download or verify, the code is already in the build.

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export interface FirstPartyApp {
  id: string;
  name: string;
  subteam: string;
  description: string;
  /** Lazily-loaded native module component (own chunk; mounted under Suspense). */
  Component: LazyExoticComponent<ComponentType>;
}

export const FIRST_PARTY_APPS: FirstPartyApp[] = [
  {
    id: "cfd",
    name: "CFD",
    subteam: "Aerodynamics",
    description:
      "The team's flagship simulation suite — engine 1D-CFD sweeps, design optimization, and full vehicle performance. Ships with Helios and runs natively with full access (not sandboxed).",
    Component: lazy(() => import("../cfd").then((m) => ({ default: m.CfdModule }))),
  },
];
