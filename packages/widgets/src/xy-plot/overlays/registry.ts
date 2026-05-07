import type { OverlayModule } from "../types";

/* Module registry. Each overlay file imports this and self-registers via
 * the helper below. The render orchestrator and config editor look up
 * overlays by `kind` here so they're agnostic to the available set. */

const REGISTRY = new Map<string, OverlayModule<unknown, unknown>>();

export function register<C, A>(mod: OverlayModule<C, A>): void {
  if (!mod.draw && !mod.Component) {
    throw new Error(`Overlay '${mod.kind}' must define draw or Component`);
  }
  // Idempotent: HMR re-executes overlay modules, which would otherwise
  // throw "already registered" on every save. Last write wins, which is
  // also what the user expects when they're hot-editing an overlay.
  REGISTRY.set(mod.kind, mod as unknown as OverlayModule<unknown, unknown>);
}

export function getOverlayModule(kind: string): OverlayModule<unknown, unknown> | undefined {
  return REGISTRY.get(kind);
}

export function listOverlayModules(): OverlayModule<unknown, unknown>[] {
  return [...REGISTRY.values()];
}
