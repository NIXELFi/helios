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
// opaque origin for cross-realm isolation.
//
// FRAME SELF-NAVIGATION (audit P2). The sandbox does not stop the frame from
// navigating ITSELF (location.assign) to an external URL, and `contentWindow` is
// the SAME WindowProxy afterwards — so a naive host would keep delivering RPC
// results (e.g. the bytes of a file the user just approved) into a now-external
// document, doing for it the crossing its `connect-src 'none'` CSP forbids, and
// would keep accepting capability calls FROM that document (its postMessage still
// satisfies `ev.source === frame.contentWindow`).
//
// The opaque origin means we cannot read the frame's `location` back to check.
// What IS observable is the iframe element's `load` event, which fires once per
// completed navigation. So: the FIRST load is our mount; any further load means
// the frame went somewhere else, and we permanently disconnect that mount — no
// more posts out, no more calls accepted. NOTE this narrows the window rather than
// closing it: `load` fires when the new document commits, so a result resolved in
// the same turn as a navigation can still race ahead of the flag. The complete fix
// is a `plugin://` navigation handler on the Rust side that refuses the navigation
// outright; that lives in lib.rs and is tracked separately.

export interface PluginHostProps {
  plugin: LoadedPlugin;
  theme: "light" | "dark";
  locale: string;
  /** Signed-in member id — scopes the plugin's storage namespace. */
  userId: string | null;
  onLog: (line: string) => void;
  onNotify: (message: string, level: "info" | "warn" | "error") => void;
  onCall?: (obs: CallObservation) => void;
}

export function PluginHost({ plugin, theme, locale, userId, onLog, onNotify, onCall }: PluginHostProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Navigation tracking for THIS mount: how many documents the frame has loaded,
  // and whether it has left the one we mounted. Refs (not state) so the message
  // listener reads the live value without being re-created.
  const loadsRef = useRef(0);
  const navigatedAwayRef = useRef(false);
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
        userId,
      }),
      onCall: (obs) => cbRef.current.onCall?.(obs),
    });

    async function onMessage(ev: MessageEvent) {
      // Authenticate the sender: only OUR frame's window may talk to this host —
      // and only while it is still showing the document we mounted. `ev.source`
      // alone cannot tell those apart (same WindowProxy across navigations).
      if (!frame || ev.source !== frame.contentWindow) return;
      if (navigatedAwayRef.current) return;
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
        post(init);
      } else if (msg.kind === "helios:rpc") {
        const res = await broker.handle(msg);
        // Re-check AFTER the await: the call may have been resolving (a file the
        // user just approved) while the frame navigated itself elsewhere.
        post(res);
      }
    }

    // The single exit for anything leaving the host. `targetOrigin` stays "*"
    // because an opaque-origin frame has no origin to name; the navigation flag is
    // what keeps the payload from landing in a foreign document.
    function post(payload: unknown) {
      if (navigatedAwayRef.current || !frame) return;
      frame.contentWindow?.postMessage(payload, "*");
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [plugin, theme, locale, userId]);

  // Reset the per-mount navigation state when the mounted plugin changes.
  useEffect(() => {
    loadsRef.current = 0;
    navigatedAwayRef.current = false;
  }, [plugin]);

  return (
    <iframe
      ref={frameRef}
      title={plugin.manifest.name}
      sandbox="allow-scripts"
      onLoad={() => {
        loadsRef.current += 1;
        if (loadsRef.current > 1 && !navigatedAwayRef.current) {
          navigatedAwayRef.current = true;
          cbRef.current.onNotify(
            "This add-on navigated away from its own page. It has been disconnected from Helios — close and reopen it.",
            "error",
          );
        }
      }}
      src={`${plugin.baseUrl}/${plugin.manifest.entry.replace(/^\/+/, "")}`}
      className="h-full w-full border-0 bg-white"
    />
  );
}
