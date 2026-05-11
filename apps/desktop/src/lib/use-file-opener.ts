import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { parseBundle } from "./workspace-bundle";
import type { PerFileResult } from "./file-open-summary";

const EVENT_NAME = "helios://open-files";

export interface UseFileOpenerProps {
  onPending: (perFile: PerFileResult[]) => void;
}

/** Subscribes to OS-launched file opens (.helios files via the Tauri single-
 *  instance handler), reads + parses each, and surfaces the aggregated
 *  per-file result to the consumer. The consumer decides what to do (open a
 *  ConfirmDialog, run mergeImported on confirm, etc.).
 *
 *  Race mitigation: at mount, we ALSO call invoke("get_pending_open_files")
 *  to drain any first-launch paths that the on_page_load emit might have
 *  raced past us on. */
export function useFileOpener({ onPending }: UseFileOpenerProps) {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    async function processPaths(paths: string[]) {
      if (paths.length === 0) return;
      const perFile: PerFileResult[] = await Promise.all(
        paths.map(async (path): Promise<PerFileResult> => {
          const filename = basename(path);
          let text: string;
          try {
            text = await readTextFile(path);
          } catch {
            return { kind: "invalid", filename, reason: "Could not read file." };
          }
          const r = parseBundle(text);
          if (!r.ok) return { kind: "invalid", filename, reason: r.reason };
          return { kind: "valid", filename, workspaces: r.bundle.workspaces };
        }),
      );
      if (!cancelled) onPending(perFile);
    }

    listen<string[]>(EVENT_NAME, (event) => {
      void processPaths(event.payload);
    }).then((u) => {
      // If the effect was torn down before the listener handle came back,
      // detach immediately so we don't orphan the subscription.
      if (cancelled) { u(); return; }
      unlisten = u;
    });

    // Belt-and-suspenders: drain any pending paths the Rust side queued
    // before we attached the listener. Empty array is a no-op.
    invoke<string[]>("get_pending_open_files")
      .then((paths) => { if (!cancelled) void processPaths(paths); })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onPending]);
}

function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
