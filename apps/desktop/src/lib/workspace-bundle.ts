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

export type ParseResult =
  | { ok: true; bundle: WorkspaceBundle }
  | { ok: false; reason: string };

export function parseBundle(json: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "Not valid JSON." };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "Not a Helios workspace file." };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== BUNDLE_KIND) {
    return { ok: false, reason: "Not a Helios workspace file." };
  }
  if (obj.version !== BUNDLE_VERSION) {
    return { ok: false, reason: `Unsupported bundle version: ${String(obj.version)}.` };
  }
  if (!Array.isArray(obj.workspaces) || obj.workspaces.length === 0) {
    return { ok: false, reason: "Bundle contains no workspaces." };
  }
  for (const w of obj.workspaces) {
    if (
      !w || typeof w !== "object" ||
      typeof (w as Workspace).id !== "string" ||
      typeof (w as Workspace).label !== "string" ||
      typeof (w as Workspace).color !== "string" ||
      !Array.isArray((w as Workspace).tiles)
    ) {
      return { ok: false, reason: "Bundle contains a malformed workspace." };
    }
  }
  return { ok: true, bundle: obj as unknown as WorkspaceBundle };
}

/** Merge imported workspaces onto an existing list. Each imported workspace
 *  gets a fresh uuid (never preserve source ids — they could collide with
 *  built-ins or existing user state). Label collisions get suffixed with
 *  " (imported)", then "(imported 2)", etc., considering both the existing
 *  list AND any earlier-in-batch import that already grabbed the suffix. */
export function mergeImported(
  existing: Workspace[],
  imported: Workspace[],
): Workspace[] {
  const result = [...existing];
  for (const w of imported) {
    const newWorkspace: Workspace = {
      id: crypto.randomUUID(),
      label: dedupeLabel(w.label, result),
      color: w.color,
      tiles: JSON.parse(JSON.stringify(w.tiles)),
    };
    result.push(newWorkspace);
  }
  return result;
}

function dedupeLabel(label: string, existing: Workspace[]): string {
  const taken = new Set(existing.map((w) => w.label));
  if (!taken.has(label)) return label;
  let candidate = `${label} (imported)`;
  if (!taken.has(candidate)) return candidate;
  let n = 2;
  while (taken.has((candidate = `${label} (imported ${n})`))) n++;
  return candidate;
}
