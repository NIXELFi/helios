// PluginHost — mounts a plugin inside a sandboxed, opaque-origin iframe and
// wires it to the broker over postMessage. This component IS the isolation
// boundary: `sandbox="allow-scripts"` with NO `allow-same-origin` means the
// frame runs in a null origin with no reference to the host realm (no host DOM,
// no Supabase client, no localStorage), and the injected CSP blocks all network.

import { useEffect, useRef } from "react";
import { PROTOCOL_VERSION, type InitMessage, type PluginToHostMessage } from "@helios/plugin-sdk";
import { PluginBroker, type CallObservation } from "./broker";
import { makeHandlers } from "./capabilityHandlers";
import type { LoadedPlugin } from "./loader";

// The network wall + DOM-escape lockdown applied to every plugin document.
// default-src 'none' denies anything not re-allowed; connect-src 'none' kills
// fetch/XHR/WebSocket (no exfiltration); scripts/styles are inline-only (the
// bundle is self-contained); images limited to data:/blob:.
//
// `worker-src blob:` + `'wasm-unsafe-eval'` deliberately re-allow the in-sandbox
// compute path the platform exists for (Web Workers off the main thread, and
// WebAssembly): both inherit this document's opaque origin + CSP, so they don't
// weaken network/DOM containment. NOTE: CSP does NOT prevent the frame from
// navigating ITSELF (e.g. location.assign to an external URL) — that egress gap
// is closed by the production `plugin://` navigation handler (deferred to
// Sub-project B); see the spec's hardening backlog.
//
// KEEP BYTE-IDENTICAL to `PLUGIN_CSP` in the `plugin-host` Rust crate
// (crates/plugin-host/src/lib.rs), which serves it as a response header on the
// `plugin://` production path. A pin test there fails CI if the two drift.
const PLUGIN_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "worker-src blob:",
  "child-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

function withCsp(html: string): string {
  // Prepend the CSP as the very first node so NOTHING the plugin authored can
  // precede the policy (a script the parser hoists ahead of a meta injected
  // mid-<head> would otherwise run before the policy applied). We strip any
  // leading doctype the bundle declared and supply our own.
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_CSP}">`;
  const body = html.replace(/^\s*<!doctype html>/i, "");
  return `<!doctype html>${meta}${body}`;
}

export interface PluginHostProps {
  plugin: LoadedPlugin;
  theme: "light" | "dark";
  locale: string;
  onLog: (line: string) => void;
  onNotify: (message: string, level: "info" | "warn" | "error") => void;
  onCall?: (obs: CallObservation) => void;
}

export function PluginHost({ plugin, theme, locale, onLog, onNotify, onCall }: PluginHostProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Keep the latest callbacks in a ref so the message listener isn't torn down
  // and re-attached on every parent re-render (which would miss the one-shot
  // ready handshake).
  const cbRef = useRef({ onLog, onNotify, onCall });
  cbRef.current = { onLog, onNotify, onCall };

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const broker = new PluginBroker({
      manifest: plugin.manifest,
      handlers: makeHandlers(plugin.manifest, {
        log: (l) => cbRef.current.onLog(l),
        notify: (m, lv) => cbRef.current.onNotify(m, lv),
      }),
      onCall: (obs) => cbRef.current.onCall?.(obs),
    });

    async function onMessage(ev: MessageEvent) {
      // Authenticate the sender: only OUR frame's window may talk to this host.
      if (!frame || ev.source !== frame.contentWindow) return;
      const msg = ev.data as PluginToHostMessage;
      if (!msg || typeof msg !== "object") {
        console.warn("[marketplace] dropped malformed message from plugin frame");
        return;
      }

      if (msg.kind === "helios:ready") {
        const init: InitMessage = {
          kind: "helios:init",
          protocol: PROTOCOL_VERSION,
          context: {
            pluginId: plugin.manifest.id,
            pluginVersion: plugin.manifest.version,
            theme,
            locale,
          },
        };
        frame.contentWindow?.postMessage(init, "*");
      } else if (msg.kind === "helios:rpc") {
        const res = await broker.handle(msg);
        frame.contentWindow?.postMessage(res, "*");
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [plugin, theme, locale]);

  return (
    <iframe
      ref={frameRef}
      title={plugin.manifest.name}
      sandbox="allow-scripts"
      srcDoc={withCsp(plugin.entryHtml)}
      className="h-full w-full border-0 bg-white"
    />
  );
}
