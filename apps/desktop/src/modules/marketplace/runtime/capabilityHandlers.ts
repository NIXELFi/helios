// Host implementations behind each SDK capability. The broker only invokes one
// of these AFTER confirming the plugin declared the matching permission, so each
// handler can assume it is authorised — its job is just to do the real work
// (open a picker, save a blob, read/write namespaced storage).

import type { PluginManifest } from "@helios/plugin-sdk";
import type { CapabilityHandler } from "./broker";
import {
  migrateLegacyPluginStorage,
  pluginStorageKeys,
  pluginStorageNamespace,
} from "./pluginStorage";

export interface HostServices {
  /** Append a line to the plugin's host-side log console. */
  log: (line: string) => void;
  /** Surface a transient toast in the Helios chrome. */
  notify: (message: string, level: "info" | "warn" | "error") => void;
  /** The signed-in member's id — the storage namespace's outer scope. `null`
   *  only while signed out, which disables storage entirely (see below). */
  userId: string | null;
}

const STORAGE_QUOTA_BYTES = 1_000_000; // 1 MB per plugin (MVP soft cap)

/** Build the capability handlers bound to one plugin. Storage is namespaced by
 *  USER id AND plugin id, so one plugin can never read another's keys and one
 *  member can never read another's — see pluginStorage.ts. */
export function makeHandlers(manifest: PluginManifest, services: HostServices): Record<string, CapabilityHandler> {
  // No signed-in member means there is no namespace to write into. Rather than
  // fall back to a shared bucket (the exact cross-member leak we're closing), the
  // storage capability simply fails closed.
  const ns = services.userId ? pluginStorageNamespace(services.userId, manifest.id) : null;
  if (services.userId) {
    // Adopt anything this plugin stored before keys were per-user, so namespacing
    // doesn't read as "the add-on forgot all my settings" after an update.
    migrateLegacyPluginStorage(services.userId, manifest.id);
  }
  const requireNs = (): string => {
    if (!ns) throw new Error("plugin storage is unavailable while signed out");
    return ns;
  };

  return {
    // ── Tier 0 ──
    "host.log": (params) => {
      const args = (params as { args?: unknown[] })?.args ?? [];
      services.log(args.map((a) => String(a)).join(" "));
      return undefined;
    },
    "host.notify": (params) => {
      const p = (params as { message?: string; level?: "info" | "warn" | "error" }) ?? {};
      services.notify(String(p.message ?? ""), p.level ?? "info");
      return undefined;
    },
    // Context is delivered at the init handshake; this is just a fallback.
    "host.getContext": () => null,

    // ── Tier 1: file.read — user-mediated picker ──
    "file.read": async (params) => {
      const accept = (params as { accept?: string })?.accept;
      return pickFile(accept);
    },

    // ── Tier 1: file.write — user-confirmed save ──
    "file.write": (params) => {
      const p = (params as { bytes?: Uint8Array | string; suggestedName?: string }) ?? {};
      return saveFile(p.bytes ?? new Uint8Array(), p.suggestedName ?? "download.bin");
    },

    // ── Tier 1: storage — namespaced + quota'd ──
    "storage.get": (params) => {
      const prefix = requireNs();
      const key = (params as { key?: string })?.key ?? "";
      const raw = localStorage.getItem(prefix + key);
      return raw === null ? null : JSON.parse(raw);
    },
    "storage.set": (params) => {
      const prefix = requireNs();
      const p = (params as { key?: string; value?: unknown }) ?? {};
      const key = String(p.key ?? "");
      const serialized = JSON.stringify(p.value ?? null);
      // Enforce a CUMULATIVE per-plugin quota, not just per-value, so a plugin
      // can't exhaust the host's shared localStorage by writing many small keys.
      let total = serialized.length;
      for (const k of pluginStorageKeys(prefix)) {
        if (k !== prefix + key) total += (localStorage.getItem(k) ?? "").length;
      }
      if (total > STORAGE_QUOTA_BYTES) {
        throw new Error("plugin storage quota (1 MB) exceeded");
      }
      localStorage.setItem(prefix + key, serialized);
      return undefined;
    },
    "storage.keys": () => {
      const prefix = requireNs();
      return pluginStorageKeys(prefix).map((k) => k.slice(prefix.length));
    },
    "storage.delete": (params) => {
      const prefix = requireNs();
      const key = (params as { key?: string })?.key ?? "";
      localStorage.removeItem(prefix + key);
      return undefined;
    },

    // ── Tier 2: engine bridges — declared-gated, not wired in the MVP. A plugin
    // that declared engine:matlab passes the broker's permission gate and lands
    // here; one that did NOT declare it never reaches this point. ──
    "engine.matlab.run": () => {
      throw new Error("the MATLAB bridge is not available in this build (arrives in Sub-project E)");
    },
  };
}

async function pickFile(accept?: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const finish = (value: { name: string; bytes: Uint8Array } | null) => {
      if (settled) return;
      settled = true;
      if (input.parentNode) input.parentNode.removeChild(input);
      resolve(value);
    };
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      const bytes = new Uint8Array(await file.arrayBuffer());
      finish({ name: file.name, bytes });
    });
    // Modern browsers (incl. the WebView2 the desktop app uses) fire `cancel` on
    // the file input when the dialog is dismissed — a reliable signal that does
    // NOT risk clobbering a genuine selection the way a focus/timer heuristic did.
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

function saveFile(bytes: Uint8Array | string, suggestedName: string): boolean {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer the revoke a tick — revoking synchronously after click can cancel the
  // download of larger blobs in some engines before the fetch begins.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
