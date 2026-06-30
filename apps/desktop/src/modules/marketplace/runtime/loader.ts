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

/** Where an installed plugin's verified bundle is served from at launch time.
 *  The Rust `plugin://` asset protocol (Sub-project B, Phase 0.1) serves the
 *  unpacked, signature-verified install cache under this origin.
 *
 *  GATE: mounting an *untrusted* installed bundle is still gated on the iframe
 *  nav-hardening work (Phase 0.2 — see
 *  docs/superpowers/specs/2026-06-26-plugin-nav-hardening-decision.md). Until
 *  that lands and is live-verified, only trusted/bundled examples should be
 *  launched, and PluginHost must NOT be flipped to `src=plugin://`. The exact
 *  authority form (`plugin://<id>` vs the Windows `plugin.localhost` shape) is
 *  normalized by the protocol handler and finalized during that live verify. */
export function installedBaseUrl(pluginId: string): string {
  // Tauri v2 surfaces a registered custom scheme differently per platform: Windows
  // WebView2 rewrites `plugin://` to `http://plugin.localhost/<path>` (id in the
  // PATH), while macOS/Linux serve `plugin://<id>/` (id as the AUTHORITY). The Rust
  // handler (plugin_host::uri::parse_request) accepts BOTH shapes — we just have to
  // emit whichever the current webview will actually route, or the raw `plugin://`
  // is an unknown scheme on Windows and fetch fails with "Failed to fetch".
  const isWindows =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  return isWindows ? `http://plugin.localhost/${pluginId}` : `plugin://${pluginId}`;
}

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
