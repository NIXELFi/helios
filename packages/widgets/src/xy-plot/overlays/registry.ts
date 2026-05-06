import type { OverlayModule } from "../types";

/* Module registry. Each overlay file imports this and self-registers via
 * the helper below. The render orchestrator and config editor look up
 * overlays by `kind` here so they're agnostic to the available set. */

const REGISTRY = new Map<string, OverlayModule<unknown, unknown>>();

export function register<C, A>(mod: OverlayModule<C, A>): void {
  if (REGISTRY.has(mod.kind)) {
    throw new Error(`Overlay '${mod.kind}' is already registered`);
  }
  if (!mod.draw && !mod.Component) {
    throw new Error(`Overlay '${mod.kind}' must define draw or Component`);
  }
  REGISTRY.set(mod.kind, mod as unknown as OverlayModule<unknown, unknown>);
}

export function getOverlayModule(kind: string): OverlayModule<unknown, unknown> | undefined {
  return REGISTRY.get(kind);
}

export function listOverlayModules(): OverlayModule<unknown, unknown>[] {
  return [...REGISTRY.values()];
}
