import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { useAddLocalFile, sha256Hex } from "./useAddLocalFile";
import { folderNamePath, folderPath, sanitizePathSegment } from "./folder-paths";
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
  /** Only register the drag-drop listeners while true (Browse mounted +
   *  editor). When false the hook is inert. */
  enabled: boolean;
  /** The element to listen on — the Browse screen's root. Listeners are
   *  scoped here (NOT window) because Shell keeps modules mounted-but-hidden:
   *  window-level listeners kept reacting to drags happening inside OTHER
   *  modules (PM board/sidebar), which is how the vault's drop layer ended up
   *  interfering with PM drag-and-drop (CROSS-MODULE-DRAG). A hidden element
   *  receives no drag events, so this goes inert with the module. */
  containerRef: RefObject<HTMLElement | null>;
  vaultId: VaultId | null;
  folders: Folder[];
  /** Currently-selected folder — the fallback drop target when the pointer is
   *  over no tagged tree row. */
  selectedFolder: FolderId | null;
  /** Local vault working folder (shared-root model: <root>/<vault name>).
   *  When set, dropped files are ALSO written here at their vault-relative
   *  path so the drop genuinely lands a copy at the file location — without
   *  it, only the vault add happens and the local copy arrives (auto mode) on
   *  the next sync pass, or never (manual mode). */
  vaultRoot: string | null;
  /** Fired after a batch finishes (regardless of per-item success) so the
   *  caller can refetch + rescan. */
  onComplete?: () => void;
}

/** A dropped file plus its path relative to the drop (directory drops keep
 *  their structure under the dropped directory's own name). */
interface DroppedItem {
  file: File;
  relativePath: string;
}

/**
 * Drag-and-drop import of OS files/folders onto the vault folder tree.
 *
 * Uses HTML5 drag events, NOT Tauri's onDragDropEvent: the window config sets
 * `dragDropEnabled: false` (required for internal HTML5 drag-reorder — PM
 * board, workspace tabs — to work on Windows WebView2), and with that flag off
 * the native event NEVER fires. The original implementation listened on it
 * anyway, which is why dropping files onto the vault did nothing (DROP-DEAD).
 * HTML5 events also report pointer coords in CSS pixels, so the old
 * physical-pixel/devicePixelRatio hit-test guesswork is gone.
 *
 * On `dragover` it hit-tests the pointer against the tree's `data-folder-id`
 * rows to expose a hover-highlight target; on `drop` it expands the
 * DataTransfer entries (walking directories via webkitGetAsEntry, preserving
 * structure under the dropped dir's name), writes each file into the local
 * vault folder (when configured), and runs them sequentially through
 * `useAddLocalFile` re-parented beneath the hovered folder.
 *
 * The import loop is abortable: the controller fires on unmount (or a fresh
 * drop superseding an in-flight one) and is polled between items, mirroring
 * BulkActionBar's pattern so we never keep adding files for a teardown'd screen.
 */
export function useVaultDropImport({
  enabled,
  containerRef,
  vaultId,
  folders,
  selectedFolder,
  vaultRoot,
  onComplete,
}: Options) {
  const addLocal = useAddLocalFile();
  const [hoverFolderId, setHoverFolderId] = useState<string | null>(null);
  // True while an OS file drag is over the window — drives the full-pane
  // "Drop to add to …" overlay so the drop affordance is unmissable.
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<DropImportResult[]>([]);

  // Latest-value refs so the long-lived window event handlers (registered once
  // per `enabled` flip) always read current props without re-subscribing on
  // every folder/selection change.
  const foldersRef = useRef(folders);
  const selectedFolderRef = useRef(selectedFolder);
  const vaultIdRef = useRef(vaultId);
  const vaultRootRef = useRef(vaultRoot);
  const onCompleteRef = useRef(onComplete);
  const addRunRef = useRef(addLocal.run);
  useEffect(() => { foldersRef.current = folders; }, [folders]);
  useEffect(() => { selectedFolderRef.current = selectedFolder; }, [selectedFolder]);
  useEffect(() => { vaultIdRef.current = vaultId; }, [vaultId]);
  useEffect(() => { vaultRootRef.current = vaultRoot; }, [vaultRoot]);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { addRunRef.current = addLocal.run; }, [addLocal.run]);

  const abortRef = useRef<AbortController | null>(null);

  const clearResults = useCallback(() => setResults([]), []);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    // An OS file drag carries "Files" in dataTransfer.types; internal HTML5
    // drags (board cards, workspace tabs) don't — ignore those entirely so
    // this hook never interferes with in-app drag-and-drop. Arrow consts (not
    // hoisted function declarations) so TS narrows `container` inside them.
    const isFileDrag = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // preventDefault is what makes this a valid drop target — without it
      // the browser cancels the drop and shows the "not allowed" cursor.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragActive(true);
      setHoverFolderId(resolveDropFolder(e.clientX, e.clientY, selectedFolderRef.current));
    };

    const onDragLeave = (e: DragEvent) => {
      // Clear when the drag leaves the Browse container entirely
      // (relatedTarget is the element being entered; null = left the window).
      const next = e.relatedTarget as Node | null;
      if (next === null || !container.contains(next)) {
        setHoverFolderId(null);
        setDragActive(false);
      }
    };

    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const target = resolveDropFolder(e.clientX, e.clientY, selectedFolderRef.current);
      setHoverFolderId(null);
      setDragActive(false);
      // Snapshot entries SYNCHRONOUSLY — DataTransferItems are neutered once
      // the drop handler returns, so no awaiting before this point.
      const entries: FileSystemEntry[] = [];
      const plainFiles: File[] = [];
      for (const item of Array.from(e.dataTransfer?.items ?? [])) {
        if (item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
        else {
          const f = item.getAsFile();
          if (f) plainFiles.push(f);
        }
      }
      void runImport(entries, plainFiles, target);
    };

    container.addEventListener("dragover", onDragOver);
    container.addEventListener("dragleave", onDragLeave);
    container.addEventListener("drop", onDrop);
    return () => {
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("dragleave", onDragLeave);
      container.removeEventListener("drop", onDrop);
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  /** Junk-name filter shared with the old native walk: dotfiles and Office/SW
   *  owner-lock temp files never belong in the vault. */
  function isJunkName(name: string): boolean {
    return name.startsWith(".") || name.startsWith("~$");
  }

  /**
   * Expand FileSystemEntries into flat {file, relativePath} items: a file
   * entry becomes one item keyed by its name, a directory is walked
   * recursively with its contents preserved UNDER the dropped directory's own
   * name (so dropping `frame/` yields `frame/...`).
   */
  async function expandEntries(entries: FileSystemEntry[]): Promise<DroppedItem[]> {
    const out: DroppedItem[] = [];
    for (const entry of entries) {
      await walkEntry(entry, "", out);
    }
    return out;
  }

  async function walkEntry(entry: FileSystemEntry, prefix: string, out: DroppedItem[]): Promise<void> {
    if (isJunkName(entry.name)) return;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
      );
      if (file) {
        out.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name });
      }
      return;
    }
    if (entry.isDirectory) {
      const dirPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns results in batches (Chromium caps at 100); keep
      // reading until an empty batch or large directories get silently cut.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries(resolve, () => resolve([])),
        );
        if (batch.length === 0) return;
        for (const child of batch) {
          await walkEntry(child, dirPrefix, out);
        }
      }
    }
  }

  async function runImport(
    entries: FileSystemEntry[],
    plainFiles: File[],
    targetFolderId: string | null,
  ) {
    const vid = vaultIdRef.current;
    if (!vid) return;
    // Snapshot the vault context ONCE. The window drag handlers read these from
    // live refs; without snapshotting, switching the active vault mid-import
    // would route the remaining files' bytes to the NEW vault's local folder
    // while the DB add still targets the original vault (vid) — a silent split.
    // (abortRef only fires on a new DROP, not on a vault switch.)
    const foldersSnap = foldersRef.current;
    const rootSnap = vaultRootRef.current;

    // Supersede any in-flight import and start a fresh abort scope.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;

    const items = await expandEntries(entries);
    for (const f of plainFiles) {
      if (!isJunkName(f.name)) items.push({ file: f, relativePath: f.name });
    }
    if (signal.aborted || items.length === 0) return;

    setImporting(true);
    setResults([]);

    // Raw DB folder names for ensureFolderHierarchy matching; sanitized
    // segments for anything touching disk (path-traversal containment).
    const prefix = folderNamePath(targetFolderId, foldersSnap);
    const sanitizedPrefix = folderPath(targetFolderId, foldersSnap);

    const collected: DropImportResult[] = [];
    for (const item of items) {
      if (signal.aborted) return;
      const name = item.relativePath;
      try {
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        const sha = await sha256Hex(bytes);

        // Copy the bytes into the local vault folder at the vault-relative
        // path FIRST, so the file lands on disk even if the vault add fails
        // (the unmatched/auto-add flow can then pick it up). Segment-wise
        // sanitization matches how the sync ledger + auto-sync key paths.
        let absolutePath = "";
        const root = rootSnap;
        if (root) {
          const relSan = item.relativePath.split("/").map(sanitizePathSegment).join("/");
          const localRel = sanitizedPrefix ? `${sanitizedPrefix}/${relSan}` : relSan;
          absolutePath = `${root}/${localRel}`;
          const dir = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
          await mkdir(dir, { recursive: true }).catch(() => { /* may exist */ });
          await writeFile(absolutePath, bytes);
        }
        if (signal.aborted) return;

        const lf: LocalFile = {
          basename: basename(item.relativePath),
          relativePath: item.relativePath,
          absolutePath,
          sha256: sha,
          sizeBytes: bytes.length,
          bytes,
        };
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

  return { hoverFolderId, dragActive, importing, results, clearResults };
}

/** basename of a slash- OR backslash-separated path. */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
