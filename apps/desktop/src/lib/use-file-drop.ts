/* Webview drag-drop listener — fires the consumer's callback with the dropped
 * paths whenever the user releases files anywhere over the app window. Filters
 * out the .helios workspace-bundle drops that the existing useFileOpener
 * already handles, so a single drop only triggers one path.
 *
 * Tauri 2 surfaces drag/drop via getCurrentWebview().onDragDropEvent. We only
 * care about the "drop" event; "enter" / "over" / "leave" are useful for hover
 * feedback but the SessionPanel currently doesn't show a drop overlay so we
 * skip them. Add when needed. */

import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface UseFileDropProps {
  onDrop: (paths: string[]) => void;
}

export function useFileDrop({ onDrop }: UseFileDropProps) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        if (event.payload.type !== "drop") return;
        // .helios bundles are routed through useFileOpener; let that consumer
        // handle them so we don't double-process.
        const dataPaths = event.payload.paths.filter(
          (p) => !p.toLowerCase().endsWith(".helios"),
        );
        if (dataPaths.length === 0) return;
        onDrop(dataPaths);
      })
      .then((u) => { unlisten = u; })
      .catch((e) => { console.error("[helios] failed to attach drag-drop listener:", e); });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onDrop]);
}
