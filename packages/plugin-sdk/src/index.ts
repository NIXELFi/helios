// @helios/plugin-sdk — the API a Helios add-on (plugin) is written against.
//
// A plugin is a self-contained web app that runs in a locked-down sandbox inside
// Helios. It can render whatever UI it likes and compute freely; the ONLY way it
// can reach the outside world is through the functions below, each of which is a
// brokered call the Helios host re-checks against the plugin's declared
// `permissions`. Calling a capability the manifest didn't declare rejects with
// `PermissionNotDeclared`.
//
// Typical usage:
//
//   import { ready, storage, save, log } from "@helios/plugin-sdk";
//   const ctx = await ready();                 // wait for the host handshake
//   const last = await storage.get("inputs");  // needs "storage" permission
//   // ...render UI, compute...
//   await save(csvBytes, "result.csv");        // needs "file.write" permission

import { HeliosPluginClient } from "./client";
import type { PluginContext } from "./protocol";

let _client: HeliosPluginClient | null = null;
function client(): HeliosPluginClient {
  if (!_client) _client = new HeliosPluginClient();
  return _client;
}

/** Resolves once the host has handed over context. Await this before using the
 *  rest of the API so you know the channel is live. */
export function ready(): Promise<PluginContext> {
  return client().ready();
}

/** The context handed over at init (theme, locale, your own id/version), or null
 *  before the handshake completes. */
export function getContext(): PluginContext | null {
  return client().context;
}

// ── Tier 0 — always available, no permission required ────────────────────────

/** Write to the plugin's host-side console (visible to the user/reviewer). */
export function log(...args: unknown[]): void {
  void client().call("host.log", { args: args.map((a) => safeString(a)) });
}

/** Surface a transient toast in the Helios chrome. */
export function notify(message: string, level: "info" | "warn" | "error" = "info"): void {
  void client().call("host.notify", { message, level });
}

// ── Tier 1 — low-trust (user-mediated or sandbox-scoped) ─────────────────────

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/** Ask the user to pick a file (host-rendered picker). Requires the `file.read`
 *  permission. Resolves to the chosen file's bytes + name, or null if cancelled.
 *  The plugin never sees a directory listing — only what the user hands it. */
export function openFile(opts?: { accept?: string }): Promise<PickedFile | null> {
  return client().call("file.read", opts ?? {});
}

/** Save bytes to a user-confirmed location (host-rendered save dialog). Requires
 *  the `file.write` permission. Resolves true if saved, false if cancelled. */
export function save(bytes: Uint8Array | string, suggestedName: string): Promise<boolean> {
  return client().call("file.write", { bytes, suggestedName });
}

/** Private, plugin-scoped key-value storage. Requires the `storage` permission.
 *  Isolated from other plugins and from Helios data. */
export const storage = {
  get<T = unknown>(key: string): Promise<T | null> {
    return client().call("storage.get", { key });
  },
  set(key: string, value: unknown): Promise<void> {
    return client().call("storage.set", { key, value });
  },
  keys(): Promise<string[]> {
    return client().call("storage.keys", {});
  },
  delete(key: string): Promise<void> {
    return client().call("storage.delete", { key });
  },
};

// ── Tier 2 — high-trust curated engine bridges (declared + consent + review) ──

/** Curated external-engine bridges. Each requires its own high-trust permission
 *  (e.g. `engine:matlab`) plus install-time user consent and human review. The
 *  MATLAB bridge implementation lands in Sub-project E; the API surface is
 *  defined here so plugins and docs can target it. */
export const engine = {
  matlab: {
    run(script: string, inputs?: Record<string, unknown>): Promise<unknown> {
      return client().call("engine.matlab.run", { script, inputs: inputs ?? {} });
    },
  },
};

function safeString(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// Re-export the contract so authors and tooling get the types + catalog.
export * from "./protocol";
export * from "./manifest";
export * from "./capabilities";
export { HeliosPluginClient } from "./client";
