/* Webview drag-drop listener — fires the consumer's callbacks with the dropped
 * paths whenever the user releases files anywhere over the app window.
 * Data files (non-.helios) are routed to `onDrop`; workspace bundle files
 * (.helios) are routed to the optional `onDropBundles` callback so they reach
 * the same import flow as OS-launched file opens.
 *
 * Tauri 2 surfaces drag/drop via getCurrentWebview().onDragDropEvent. We only
 * care about the "drop" event; "enter" / "over" / "leave" are useful for hover
 * feedback but the SessionPanel currently doesn't show a drop overlay so we
 * skip them. Add when needed. */

import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface UseFileDropProps {
  onDrop: (paths: string[]) => void;
  /** Called with any .helios workspace bundle paths dropped onto the window.
   *  When omitted, .helios drops are silently discarded. */
  onDropBundles?: (paths: string[]) => void;
}

export function useFileDrop({ onDrop, onDropBundles }: UseFileDropProps) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        if (event.payload.type !== "drop") return;
        const bundlePaths = event.payload.paths.filter(
          (p) => p.toLowerCase().endsWith(".helios"),
        );
        const dataPaths = event.payload.paths.filter(
          (p) => !p.toLowerCase().endsWith(".helios"),
        );
        // Route .helios bundles through the bundle-import handler so a
        // drag-dropped workspace file reaches the same flow as an OS-launched
        // file open. Without this, .helios drops were silently discarded.
        if (bundlePaths.length > 0 && onDropBundles) onDropBundles(bundlePaths);
        if (dataPaths.length > 0) onDrop(dataPaths);
      })
      .then((u) => {
        // If the effect was torn down before the listener handle came back,
        // detach immediately so we don't orphan the subscription.
        if (cancelled) { u(); return; }
        unlisten = u;
      })
      .catch((e) => { console.error("[helios] failed to attach drag-drop listener:", e); });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onDrop, onDropBundles]);
}
