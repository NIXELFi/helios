import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readDir, stat } from "@tauri-apps/plugin-fs";
import { useAddLocalFile } from "./useAddLocalFile";
import { folderNamePath } from "./folder-paths";
import { resolveDropFolder } from "./drop-target";
import type { Folder, FolderId, VaultId } from "./types";
import type { LocalFile } from "./useLocalFolderScan";

/** Per-item outcome of a drag-drop import batch. */
export interface DropImportResult {
  name: string;
  ok: boolean;
  error?: string;
}

interface Options {
  /** Only register the OS drag-drop listener while true (Browse mounted +
   *  editor). When false the hook is inert. */
  enabled: boolean;
  vaultId: VaultId | null;
  folders: Folder[];
  /** Currently-selected folder — the fallback drop target when the pointer is
   *  over no tagged tree row. */
  selectedFolder: FolderId | null;
  /** Fired after a batch finishes (regardless of per-item success) so the
   *  caller can refetch + rescan. */
  onComplete?: () => void;
}

/**
 * Drag-and-drop import of OS files/folders onto the vault folder tree.
 *
 * Registers `getCurrentWebview().onDragDropEvent` while `enabled`. On `over`
 * it hit-tests the pointer against the tree's `data-folder-id` rows to expose a
 * hover-highlight target; on `drop` it stat's each dropped path, walks
 * directories recursively (preserving structure under the dropped dir's name),
 * synthesizes minimal `LocalFile`s, and runs them sequentially through
 * `useAddLocalFile` re-parented beneath the hovered folder.
 *
 * The import loop is abortable: the controller fires on unmount (or a fresh
 * drop superseding an in-flight one) and is polled between items, mirroring
 * BulkActionBar's pattern so we never keep adding files for a teardown'd screen.
 */
export function useVaultDropImport({
  enabled,
  vaultId,
  folders,
  selectedFolder,
  onComplete,
}: Options) {
  const addLocal = useAddLocalFile();
  const [hoverFolderId, setHoverFolderId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<DropImportResult[]>([]);

  // Latest-value refs so the long-lived OS event handler (registered once per
  // `enabled` flip) always reads current props without re-subscribing on every
  // folder/selection change.
  const foldersRef = useRef(folders);
  const selectedFolderRef = useRef(selectedFolder);
  const vaultIdRef = useRef(vaultId);
  const onCompleteRef = useRef(onComplete);
  const addRunRef = useRef(addLocal.run);
  useEffect(() => { foldersRef.current = folders; }, [folders]);
  useEffect(() => { selectedFolderRef.current = selectedFolder; }, [selectedFolder]);
  useEffect(() => { vaultIdRef.current = vaultId; }, [vaultId]);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { addRunRef.current = addLocal.run; }, [addLocal.run]);

  const abortRef = useRef<AbortController | null>(null);

  const clearResults = useCallback(() => setResults([]), []);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    (async () => {
      const un = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over") {
          // The OS reports the pointer in PHYSICAL pixels; elementFromPoint
          // expects CSS pixels. Divide by devicePixelRatio to convert.
          // NOTE: verify at runtime — on a 1.0 DPR display this is a no-op, but
          // on a HiDPI/scaled monitor the wrong space would highlight the wrong
          // row (or none). Adjust here if hit-testing is offset in practice.
          const dpr = window.devicePixelRatio || 1;
          const x = payload.position.x / dpr;
          const y = payload.position.y / dpr;
          setHoverFolderId(resolveDropFolder(x, y, selectedFolderRef.current));
        } else if (payload.type === "leave") {
          setHoverFolderId(null);
        } else if (payload.type === "drop") {
          const dpr = window.devicePixelRatio || 1;
          const target = resolveDropFolder(
            payload.position.x / dpr,
            payload.position.y / dpr,
            selectedFolderRef.current,
          );
          setHoverFolderId(null);
          void runImport(payload.paths, target);
        }
      });
      if (disposed) un();
      else unlisten = un;
    })();

    return () => {
      disposed = true;
      if (unlisten) unlisten();
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  /**
   * Expand a list of dropped absolute paths into flat {absolutePath,
   * relativePath} entries: a file becomes one entry keyed by its basename, a
   * directory is walked recursively with its contents preserved UNDER the
   * dropped directory's own name (so dropping `C:\work\frame` yields
   * `frame/...`).
   */
  async function expandPaths(
    paths: string[],
  ): Promise<Array<{ absolutePath: string; relativePath: string; sizeBytes: number }>> {
    const out: Array<{ absolutePath: string; relativePath: string; sizeBytes: number }> = [];
    for (const p of paths) {
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(p);
      } catch {
        continue; // unreadable path — skip
      }
      const base = basename(p);
      if (info.isDirectory) {
        await walkDir(p, base, out);
      } else if (info.isFile) {
        out.push({ absolutePath: p, relativePath: base, sizeBytes: info.size });
      }
    }
    return out;
  }

  async function walkDir(
    dir: string,
    relPrefix: string,
    out: Array<{ absolutePath: string; relativePath: string; sizeBytes: number }>,
  ): Promise<void> {
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
      if (e.isSymlink) continue;
      const abs = `${dir}/${e.name}`;
      const rel = `${relPrefix}/${e.name}`;
      if (e.isDirectory) {
        await walkDir(abs, rel, out);
      } else if (e.isFile) {
        let size = 0;
        try { size = (await stat(abs)).size; } catch { /* keep 0 */ }
        out.push({ absolutePath: abs, relativePath: rel, sizeBytes: size });
      }
    }
  }

  async function runImport(paths: string[], targetFolderId: string | null) {
    const vid = vaultIdRef.current;
    if (!vid || paths.length === 0) return;

    // Supersede any in-flight import and start a fresh abort scope.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;

    setImporting(true);
    setResults([]);

    const prefix = folderNamePath(targetFolderId, foldersRef.current);
    const items = await expandPaths(paths);
    if (signal.aborted) return;

    const collected: DropImportResult[] = [];
    for (const item of items) {
      if (signal.aborted) return;
      // Minimal LocalFile — no sha256 so useAddLocalFile reads + hashes lazily.
      const lf: LocalFile = {
        basename: basename(item.relativePath),
        relativePath: item.relativePath,
        absolutePath: item.absolutePath,
        sha256: "",
        sizeBytes: item.sizeBytes,
      };
      const name = item.relativePath;
      try {
        const r = await addRunRef.current(vid, lf, prefix || undefined);
        if (signal.aborted) return;
        collected.push(r.ok ? { name, ok: true } : { name, ok: false, error: r.error });
      } catch (e) {
        if (signal.aborted) return;
        collected.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      // Publish incrementally so the strip fills in as files land.
      setResults([...collected]);
    }

    if (signal.aborted) return;
    setImporting(false);
    onCompleteRef.current?.();
  }

  return { hoverFolderId, importing, results, clearResults };
}

/** basename of a slash- OR backslash-separated path. */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
