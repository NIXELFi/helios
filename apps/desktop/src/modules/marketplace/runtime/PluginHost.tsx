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

// The plugin loads from its OWN `plugin://<id>` origin, served by the plugin-host
// Rust crate which sets the sandbox CSP (network wall + DOM-escape lockdown) as a
// RESPONSE HEADER — the single source of truth is `PLUGIN_CSP` in
// crates/plugin-host/src/lib.rs. We use `src=` rather than `srcDoc` on purpose: a
// `srcdoc` document has URL `about:srcdoc` (a local scheme) and INHERITS the host
// window's CSP, whose `script-src 'self'` (no 'unsafe-inline') then blocks the
// plugin's self-contained inline bundle from executing (blank frame). A real
// `plugin://` URL does not inherit — it applies only the plugin-host response
// header (which allows 'unsafe-inline'), so the bundle actually runs.
// `sandbox="allow-scripts"` (no allow-same-origin) still pins the frame to an
// opaque origin for cross-realm isolation. Known residual: frame self-navigation
// to an external URL (location.assign) — tracked for the plugin:// nav handler.

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
      src={`${plugin.baseUrl}/${plugin.manifest.entry.replace(/^\/+/, "")}`}
      className="h-full w-full border-0 bg-white"
    />
  );
}
