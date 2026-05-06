import type { Workspace } from "../workspaces/types";

export const BUNDLE_KIND = "helios-workspace-bundle";
export const BUNDLE_VERSION = 1 as const;

export interface WorkspaceBundle {
  kind: typeof BUNDLE_KIND;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;     // ISO timestamp
  exportedFrom: string;   // "Helios <semver>"
  workspaces: Workspace[];
}

export function slugifyForFilename(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "workspace";
}

export function serializeBundle(workspaces: Workspace[], appVersion: string): string {
  const bundle: WorkspaceBundle = {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    exportedFrom: `Helios ${appVersion}`,
    workspaces: JSON.parse(JSON.stringify(workspaces)),
  };
  return JSON.stringify(bundle, null, 2);
}
