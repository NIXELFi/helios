// Plugin loader — fetch + validate a plugin BEFORE any of its code runs.
//
// Validation (manifest shape + SDK compatibility) happens here, ahead of the
// sandbox frame ever being created. If anything is wrong the plugin is refused
// with a clear message and nothing is executed.

import { validateManifest, isSdkCompatible, type PluginManifest } from "@helios/plugin-sdk";

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Base URL the plugin was loaded from. */
  baseUrl: string;
  /** The entry HTML document text, injected into the sandbox via `srcdoc`. */
  entryHtml: string;
}

export class PluginLoadError extends Error {}

function trimSlash(s: string): string {
  return s.replace(/\/$/, "");
}

/** Fetch + validate a plugin from a base URL (a directory served with a
 *  manifest.json). The MVP loads bundled example plugins under /plugins/;
 *  Sub-project B swaps this for installed, marketplace-delivered bundles. */
export async function loadPlugin(baseUrl: string): Promise<LoadedPlugin> {
  const base = trimSlash(baseUrl);

  const manifestUrl = `${base}/manifest.json`;
  let manifestJson: unknown;
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifestJson = await res.json();
  } catch (e) {
    throw new PluginLoadError(
      `could not read manifest at ${manifestUrl}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const result = validateManifest(manifestJson);
  if (!result.ok) {
    throw new PluginLoadError(`invalid manifest:\n- ${result.errors.join("\n- ")}`);
  }
  const manifest = manifestJson as PluginManifest;

  if (!isSdkCompatible(manifest.sdk)) {
    throw new PluginLoadError(
      `plugin targets SDK "${manifest.sdk}", which is incompatible with this Helios build`,
    );
  }

  const entryUrl = `${base}/${manifest.entry.replace(/^\//, "")}`;
  let entryHtml: string;
  try {
    const res = await fetch(entryUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    entryHtml = await res.text();
  } catch (e) {
    throw new PluginLoadError(
      `could not read entry at ${entryUrl}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { manifest, baseUrl: base, entryHtml };
}
