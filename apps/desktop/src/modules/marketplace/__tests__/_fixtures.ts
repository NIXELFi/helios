// Shared test fixture: build an AvailablePlugin with sensible defaults that any
// field can override. Mirrors the snake_case→camelCase shape produced by
// `useAvailablePlugins`.

import type { PermissionKey } from "@helios/plugin-sdk";
import type { AvailablePlugin } from "../data/useMarketplace";

export function makePlugin(over: Partial<AvailablePlugin> = {}): AvailablePlugin {
  const id = over.id ?? "aero.downforce";
  const name = over.name ?? "Downforce Calculator";
  const version = over.version ?? "1.0.0";
  const permissions = over.permissions ?? [];
  return {
    id,
    name,
    version,
    permissions,
    subteam: over.subteam ?? "Aero",
    isRecommended: over.isRecommended ?? false,
    installedVersion: over.installedVersion ?? null,
    publishedAt: over.publishedAt ?? "2026-06-26T00:00:00Z",
    manifest: over.manifest ?? {
      format: 1,
      id,
      name,
      version,
      description: "Computes downforce from a velocity sweep.",
      entry: "dist/index.html",
      sdk: "^1.0.0",
      permissions: permissions as PermissionKey[],
    },
  };
}
