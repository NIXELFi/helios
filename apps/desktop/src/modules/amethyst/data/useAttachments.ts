import { useCallback, useEffect, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import type { KbVault } from "../types";

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
      avif: "image/avif",
    }[ext] ?? "application/octet-stream"
  );
}

/**
 * Lazily turns a vault attachment filename into a blob: URL the webview can
 * render. Embeds are resolved on demand (a note references only a handful),
 * cached for the vault's lifetime, and revoked when the root changes.
 */
export function useAttachments(vault: KbVault | null) {
  const cache = useRef<Map<string, string>>(new Map());
  const inflight = useRef<Set<string>>(new Set());
  const [version, bump] = useState(0);

  // Revoke + clear whenever the vault root changes.
  useEffect(() => {
    return () => {
      for (const url of cache.current.values()) URL.revokeObjectURL(url);
      cache.current.clear();
      inflight.current.clear();
    };
  }, [vault?.root]);

  const resolve = useCallback((name: string): string | null => {
    return cache.current.get(name.toLowerCase()) ?? null;
  }, []);

  const ensure = useCallback(
    (names: string[]) => {
      if (!vault) return;
      for (const raw of names) {
        const key = raw.toLowerCase();
        if (cache.current.has(key) || inflight.current.has(key)) continue;
        const abs = vault.attachments.get(key);
        if (!abs) continue;
        inflight.current.add(key);
        readFile(abs)
          .then((bytes) => {
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(key) }));
            cache.current.set(key, url);
            inflight.current.delete(key);
            bump((n) => n + 1);
          })
          .catch(() => {
            inflight.current.delete(key);
          });
      }
    },
    [vault],
  );

  return { resolve, ensure, version };
}

export type Attachments = ReturnType<typeof useAttachments>;
