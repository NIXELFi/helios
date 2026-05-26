import { useEffect, useMemo, useRef, useState } from "react";
import type { FileId, Folder, FolderId, Lock, UserId, VaultFile } from "../data/types";

/**
 * Tree multi-selection covers BOTH files and folders. A selected folder
 * means "every file recursively under it" at action time, which is what
 * users want from drag/shift-select across mixed rows.
 */
export interface TreeSelection {
  files: Set<FileId>;
  folders: Set<FolderId>;
}

export function emptyTreeSelection(): TreeSelection {
  return { files: new Set(), folders: new Set() };
}

/**
 * Target of a right-click in the tree. Either a single folder (with all its
 * descendant files), or a set of files (the current multi-selection).
 */
export type TreeContextTarget =
  | { kind: "folder"; folder: Folder; descendantFiles: VaultFile[] }
  | { kind: "files"; files: VaultFile[] };

interface Props {
  folders: Folder[];
  selected: FolderId | null;
  onSelect: (id: FolderId | null) => void;
  // Optional: when provided, files appear as leaves under their parent folder
  // when that folder is expanded. Click a file → select its folder + the file.
  files?: VaultFile[];
  selectedFile?: FileId | null;
  onSelectFile?: (id: FileId) => void;
  // Optional: lock state used to color-code file leaves' status dots.
  locks?: Lock[];
  currentUserId?: UserId;
  /**
   * Multi-select state for the tree. Hold shift to range-select along the
   * visible row order; hold cmd/ctrl to toggle individual rows. Click-drag
   * on empty space draws a marquee that selects every row it crosses.
   * Folders included in the selection are expanded at action time to all
   * their descendant files.
   */
  treeSelection?: TreeSelection;
  onTreeSelectionChange?: (next: TreeSelection) => void;
  /**
   * Right-click handler — fires with screen coords + a structured target.
   * Parent renders a context menu (e.g. TreeContextMenu) at the coords.
   */
  onContextMenu?: (target: TreeContextTarget, x: number, y: number) => void;
}

interface FolderNode {
  folder: Folder;
  children: FolderNode[];
}

/**
 * Builds an O(N) tree from a flat folders array, using a pre-computed
 * parent->children index. Sorted alphabetically at each level.
 */
function buildTreeFromIndex(
  byParent: Map<string | null, Folder[]>,
): FolderNode[] {
  function nodesFor(parentId: string | null): FolderNode[] {
    return (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ folder: f, children: nodesFor(f.id) }));
  }
  return nodesFor(null);
}

/**
 * Walks parent_id pointers from leaf to root. O(depth) given an id->folder
 * map vs O(depth * N) with a flat-array `find` per step.
 */
function ancestorsOfFromIndex(
  folderId: FolderId,
  byId: Map<FolderId, Folder>,
): FolderId[] {
  const out: FolderId[] = [];
  let current = byId.get(folderId);
  while (current?.parent_id) {
    out.push(current.parent_id);
    current = byId.get(current.parent_id);
  }
  return out;
}

function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" fillOpacity="0.85" stroke="currentColor" strokeWidth="0.6" strokeLinejoin="round">
      <path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v.5H3.5a1 1 0 0 0-.97.76L2 8V4Z" />
      <path d="M2.5 13.5l1.2-5.05A1 1 0 0 1 4.67 7.7H14.3a.6.6 0 0 1 .58.74l-1.05 4.5a1 1 0 0 1-.97.76H2.5Z" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" fillOpacity="0.85" stroke="currentColor" strokeWidth="0.6" strokeLinejoin="round">
      <path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4Z" />
    </svg>
  );
}

function FileIcon({ name }: { name: string }) {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const tint =
    ext === "sldprt" ? "text-sky-400" :
    ext === "sldasm" ? "text-[#66BB6A]" :
    ext === "slddrw" ? "text-orange-400" :
    "text-helios-dim";
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      className={"shrink-0 " + tint}
      fill="currentColor"
      fillOpacity="0.7"
      stroke="currentColor"
      strokeOpacity="0.95"
      strokeWidth="0.6"
      strokeLinejoin="round"
    >
      <path d="M3 2.5a1 1 0 0 1 1-1h5L13 5.5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11Z" />
      <path d="M9 1.5V5h4" fill="none" stroke="currentColor" strokeWidth="0.8" />
    </svg>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      className={"transition-transform duration-150 " + (expanded ? "rotate-90" : "")}
    >
      <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Small dot indicating lock state of a file leaf. */
function LockDot({ kind }: { kind: "none" | "me" | "other" }) {
  const color =
    kind === "me" ? "bg-sky-400" :
    kind === "other" ? "bg-[#EF5350]" :
    "bg-transparent";
  if (kind === "none") return <span className="inline-block w-2" />;
  return <span className={"inline-block h-2 w-2 shrink-0 rounded-full " + color} />;
}

type RowItem =
  | { kind: "file"; id: FileId }
  | { kind: "folder"; id: FolderId };

export function FolderTree({
  folders,
  selected,
  onSelect,
  files = [],
  selectedFile,
  onSelectFile,
  locks = [],
  currentUserId,
  treeSelection,
  onTreeSelectionChange,
  onContextMenu,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Pre-compute O(1) indexes from the folders array. Without these the tree
  // recomputes O(N²) on every render — measurable on SDM26's ~500-folder
  // vault (full re-render on every tick of the auto-sync status interval).
  const foldersById = useMemo(() => {
    const m = new Map<FolderId, Folder>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);
  const foldersByParent = useMemo(() => {
    const m = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const arr = m.get(f.parent_id) ?? [];
      arr.push(f);
      m.set(f.parent_id, arr);
    }
    return m;
  }, [folders]);
  const tree = useMemo(() => buildTreeFromIndex(foldersByParent), [foldersByParent]);
  const anchorRef = useRef<RowItem | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Drag-marquee state: while running, all rows whose center falls inside
  // the rectangle (in container coords) get added to the selection on
  // mouseup. We capture mousedown on whitespace only, and require >4px move
  // before treating it as a marquee (so plain clicks still work).
  const [marquee, setMarquee] = useState<null | {
    x0: number; y0: number; x1: number; y1: number;
    /** Snapshot of selection at drag-start so the lasso operates additively
        when shift/cmd is held, or replaces it on a plain drag. */
    baseline: TreeSelection;
    additive: boolean;
  }>(null);

  // Pre-bucket files by folder_id for O(1) lookup during render.
  const filesByFolder = useMemo(() => {
    const m = new Map<string | null, VaultFile[]>();
    for (const f of files) {
      const key = f.folder_id;
      const arr = m.get(key) ?? [];
      arr.push(f);
      m.set(key, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    return m;
  }, [files]);

  // Active lock by file_id — O(1) replacement for the previous O(L) lookup
  // inside lockKindFor. Skips released locks so a stale row doesn't shadow
  // the current state.
  const lockByFile = useMemo(() => {
    const m = new Map<FileId, Lock>();
    for (const l of locks) {
      if (l.released_at === null) m.set(l.file_id, l);
    }
    return m;
  }, [locks]);

  // Files reachable under a folder (recursive). Used by right-click on a
  // folder to download "everything inside". Uses the parent index so the
  // descendant walk is O(N) instead of O(N²).
  function filesUnder(folderId: FolderId): VaultFile[] {
    const out: VaultFile[] = [];
    const stack: string[] = [folderId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      out.push(...(filesByFolder.get(id) ?? []));
      for (const child of foldersByParent.get(id) ?? []) stack.push(child.id);
    }
    return out;
  }

  useEffect(() => {
    if (!selected) return;
    const ancestors = ancestorsOfFromIndex(selected, foldersById);
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of ancestors) next.add(id);
      return next;
    });
  }, [selected, foldersById]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleRowClick(node: FolderNode) {
    onSelect(node.folder.id);
    // Selecting a folder also reveals its contents (subfolders + files);
    // subsequent clicks on the row don't collapse — use the chevron for that.
    const hasContents = node.children.length > 0 || (filesByFolder.get(node.folder.id)?.length ?? 0) > 0;
    if (hasContents && !expanded.has(node.folder.id)) {
      setExpanded((prev) => new Set(prev).add(node.folder.id));
    }
  }

  function lockKindFor(fileId: FileId): "none" | "me" | "other" {
    const lock = lockByFile.get(fileId);
    if (!lock) return "none";
    return lock.user_id === currentUserId ? "me" : "other";
  }

  // Build a stable visible-order list of EVERY row the user can see —
  // root files, then each folder + its expanded children (recursively).
  // Used by shift-range selection across mixed file/folder rows.
  function visibleItemsInOrder(): RowItem[] {
    const out: RowItem[] = [];
    for (const f of filesByFolder.get(null) ?? []) {
      out.push({ kind: "file", id: f.id });
    }
    function walk(parentId: string | null) {
      const here = (foldersByParent.get(parentId) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const folder of here) {
        out.push({ kind: "folder", id: folder.id });
        if (!expanded.has(folder.id)) continue;
        for (const f of filesByFolder.get(folder.id) ?? []) {
          out.push({ kind: "file", id: f.id });
        }
        walk(folder.id);
      }
    }
    walk(null);
    return out;
  }

  function cloneSelection(sel: TreeSelection): TreeSelection {
    return { files: new Set(sel.files), folders: new Set(sel.folders) };
  }

  function addItemToSelection(sel: TreeSelection, item: RowItem): void {
    if (item.kind === "file") sel.files.add(item.id);
    else sel.folders.add(item.id);
  }

  function toggleItemInSelection(sel: TreeSelection, item: RowItem): void {
    if (item.kind === "file") {
      if (sel.files.has(item.id)) sel.files.delete(item.id);
      else sel.files.add(item.id);
    } else {
      if (sel.folders.has(item.id)) sel.folders.delete(item.id);
      else sel.folders.add(item.id);
    }
  }

  function applyRowClick(item: RowItem, e: React.MouseEvent | React.KeyboardEvent) {
    const isShift = "shiftKey" in e && e.shiftKey;
    const isMeta = "metaKey" in e && (e.metaKey || (e as any).ctrlKey);

    if ((isShift || isMeta) && onTreeSelectionChange) {
      const next = cloneSelection(treeSelection ?? emptyTreeSelection());
      if (isShift && anchorRef.current) {
        const order = visibleItemsInOrder();
        const idOf = (it: RowItem) => `${it.kind}:${it.id}`;
        const a = order.findIndex((o) => idOf(o) === idOf(anchorRef.current!));
        const b = order.findIndex((o) => idOf(o) === idOf(item));
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) {
            const it = order[i];
            if (it) addItemToSelection(next, it);
          }
        } else {
          addItemToSelection(next, item);
        }
      } else {
        // cmd/ctrl: toggle this row; move the anchor here.
        toggleItemInSelection(next, item);
        anchorRef.current = item;
      }
      onTreeSelectionChange(next);
      return;
    }
    // Plain click: collapse multi-selection to just this row, and navigate.
    if (onTreeSelectionChange) {
      const next = emptyTreeSelection();
      addItemToSelection(next, item);
      onTreeSelectionChange(next);
    }
    anchorRef.current = item;
    if (item.kind === "file") {
      const file = files.find((f) => f.id === item.id);
      if (file) {
        onSelect(file.folder_id);
        onSelectFile?.(file.id);
      }
    }
    // Folder-click navigation is handled by handleRowClick (which also
    // expands the folder). We don't call onSelect here for folders so we
    // don't double-fire.
  }

  // Compatibility wrapper for the existing file-leaf click site.
  function applyFileClick(file: VaultFile, e: React.MouseEvent | React.KeyboardEvent) {
    applyRowClick({ kind: "file", id: file.id }, e);
  }

  // Flatten a selection (files + folders) into the concrete list of files
  // an action (download, etc.) should operate on. Folders contribute every
  // descendant file recursively; the union is de-duped so a file caught
  // both directly and via its parent folder counts once.
  function resolveSelectionToFiles(sel: TreeSelection): VaultFile[] {
    const out = new Map<FileId, VaultFile>();
    for (const fid of sel.files) {
      const f = files.find((x) => x.id === fid);
      if (f) out.set(fid, f);
    }
    for (const folderId of sel.folders) {
      for (const f of filesUnder(folderId)) out.set(f.id, f);
    }
    return Array.from(out.values());
  }

  function renderFileLeaf(file: VaultFile, depth: number): React.ReactNode {
    const isSelectedFile = selectedFile === file.id;
    const isMulti = treeSelection?.files.has(file.id) ?? false;
    const lockKind = lockKindFor(file.id);
    return (
      <div
        key={file.id}
        role="button"
        tabIndex={0}
        aria-current={isSelectedFile ? "page" : undefined}
        data-row-kind="file"
        data-row-id={file.id}
        onClick={(e) => { e.stopPropagation(); applyFileClick(file, e); }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // If the right-clicked file isn't in the current multi-set,
          // collapse to just this file.
          let working = treeSelection;
          if (!working || !working.files.has(file.id)) {
            working = { files: new Set([file.id]), folders: new Set() };
            onTreeSelectionChange?.(working);
          }
          const targetFiles = resolveSelectionToFiles(working);
          onContextMenu?.({ kind: "files", files: targetFiles }, e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            applyFileClick(file, e);
          }
        }}
        className={
          "flex cursor-pointer items-center gap-1.5 border-l-2 py-0.5 pr-2 text-[13px] outline-none transition-colors " +
          "focus-visible:ring-1 focus-visible:ring-asu-gold " +
          (isMulti
            ? "border-asu-gold/70 bg-asu-gold/10 text-helios-text"
            : isSelectedFile
              ? "border-asu-gold bg-helios-line/80 text-helios-text"
              : "border-transparent text-helios-dim hover:bg-helios-panel hover:text-helios-text")
        }
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <span className="inline-block w-4 shrink-0" />
        <FileIcon name={file.name} />
        <span className="truncate font-mono-num text-[12px]">{file.name}</span>
        <LockDot kind={lockKind} />
      </div>
    );
  }

  function renderFolderNode(node: FolderNode, depth: number): React.ReactNode {
    const isExpanded = expanded.has(node.folder.id);
    const isSelected = selected === node.folder.id;
    const hasChildren = node.children.length > 0;
    const folderFiles = filesByFolder.get(node.folder.id) ?? [];
    const hasContents = hasChildren || folderFiles.length > 0;

    const isMultiFolder = treeSelection?.folders.has(node.folder.id) ?? false;
    return (
      <div key={node.folder.id}>
        <div
          role="button"
          tabIndex={0}
          aria-current={isSelected ? "page" : undefined}
          data-row-kind="folder"
          data-row-id={node.folder.id}
          onClick={(e) => {
            const isShift = e.shiftKey;
            const isMeta = e.metaKey || e.ctrlKey;
            if (isShift || isMeta) {
              // Modifier click: contribute the folder to the multi-selection.
              // Do NOT navigate or expand — the user is collecting rows for
              // a batch action.
              e.stopPropagation();
              applyRowClick({ kind: "folder", id: node.folder.id }, e);
              return;
            }
            handleRowClick(node);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // If this folder isn't in the multi-selection, OR there's no
            // multi-selection yet, act on just this folder. Otherwise act on
            // the entire current selection (folder + file mix).
            const sel = treeSelection;
            if (sel && (sel.folders.has(node.folder.id) || sel.files.size > 0 || sel.folders.size > 0)) {
              const files = resolveSelectionToFiles(sel);
              onContextMenu?.({ kind: "files", files }, e.clientX, e.clientY);
            } else {
              onContextMenu?.(
                { kind: "folder", folder: node.folder, descendantFiles: filesUnder(node.folder.id) },
                e.clientX,
                e.clientY,
              );
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleRowClick(node);
            }
          }}
          className={
            "group flex cursor-pointer items-center gap-1.5 border-l-2 py-1 pr-2 text-sm outline-none transition-colors " +
            "focus-visible:ring-1 focus-visible:ring-asu-gold " +
            (isMultiFolder
              ? "border-asu-gold/70 bg-asu-gold/10 text-helios-text"
              : isSelected
                ? "border-asu-gold bg-helios-line text-helios-text"
                : "border-transparent text-helios-text hover:bg-helios-panel hover:text-helios-text")
          }
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          {hasContents ? (
            <span
              role="none"
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.folder.name}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(node.folder.id);
              }}
              className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-helios-dim hover:bg-helios-line hover:text-helios-text"
            >
              <Chevron expanded={isExpanded} />
            </span>
          ) : (
            <span className="inline-block w-4 shrink-0" />
          )}
          <span className={"shrink-0 " + (isSelected ? "text-asu-gold" : "text-helios-dim")}>
            <FolderIcon open={isExpanded} />
          </span>
          <span className="truncate">{node.folder.name}</span>
          {folderFiles.length > 0 && (
            <span className="ml-auto shrink-0 rounded bg-helios-line px-1.5 py-0.5 text-[10px] font-mono-num text-helios-dim group-hover:text-helios-dim">
              {folderFiles.length}
            </span>
          )}
        </div>
        {isExpanded && (
          <>
            {node.children.map((c) => renderFolderNode(c, depth + 1))}
            {folderFiles.map((f) => renderFileLeaf(f, depth + 1))}
          </>
        )}
      </div>
    );
  }

  // Files at the vault root (folder_id === null). They live under the
  // "All folders" row in the tree and the FileTable renders them when the
  // user has selected the root view.
  const rootFiles = filesByFolder.get(null) ?? [];

  // Drag-marquee — mousedown anywhere starts a potential lasso. A >4px move
  // threshold separates a drag from a plain click; a plain mousedown on a
  // row falls through to the row's onClick. On a plain click that NEVER
  // exceeds the threshold and lands outside a row, we clear the selection.
  // Coords are viewport-fixed (clientX/clientY) so the math survives any
  // scrolling without translation.
  function onContainerMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return; // left button only
    const target = e.target as HTMLElement;
    const onRow = !!target.closest("[data-row-kind]");
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const baseline = additive
      ? cloneSelection(treeSelection ?? emptyTreeSelection())
      : emptyTreeSelection();

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    let curX = startX, curY = startY;
    function onMove(ev: MouseEvent) {
      curX = ev.clientX;
      curY = ev.clientY;
      if (!started) {
        if (Math.hypot(curX - startX, curY - startY) < 4) return;
        started = true;
      }
      setMarquee({ x0: startX, y0: startY, x1: curX, y1: curY, baseline, additive });
      onTreeSelectionChange?.(computeMarqueeSelection(startX, startY, curX, curY, baseline));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!started && !onRow && !additive) {
        // Plain click on whitespace → clear the multi-selection.
        onTreeSelectionChange?.(emptyTreeSelection());
      }
      setMarquee(null);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function computeMarqueeSelection(
    x0: number, y0: number, x1: number, y1: number,
    baseline: TreeSelection,
  ): TreeSelection {
    const next = cloneSelection(baseline);
    const lx = Math.min(x0, x1), rx = Math.max(x0, x1);
    const ty = Math.min(y0, y1), by = Math.max(y0, y1);
    // Use viewport coords directly (the marquee is fixed-positioned too).
    const rows = document.querySelectorAll<HTMLElement>("[data-row-kind]");
    rows.forEach((row) => {
      const r = row.getBoundingClientRect();
      const intersects = !(r.right < lx || r.left > rx || r.bottom < ty || r.top > by);
      if (!intersects) return;
      const kind = row.getAttribute("data-row-kind");
      const id = row.getAttribute("data-row-id");
      if (!id) return;
      if (kind === "file") next.files.add(id);
      else if (kind === "folder") next.folders.add(id);
    });
    return next;
  }

  return (
    <div
      ref={containerRef}
      className="relative flex select-none flex-col gap-0.5 py-2"
      onMouseDown={onContainerMouseDown}
    >
      {marquee && (
        <div
          // Fixed-positioned in viewport coords — matches the row hit-test
          // math in computeMarqueeSelection so the visible lasso and the
          // intersection logic stay in sync as the tree scrolls.
          className="pointer-events-none fixed z-[60] rounded border border-asu-gold/80 bg-asu-gold/10"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}
      <div
        role="button"
        tabIndex={0}
        aria-current={selected === null ? "page" : undefined}
        data-row-kind="root"
        onClick={() => onSelect(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu?.(
            { kind: "files", files: rootFiles },
            e.clientX,
            e.clientY,
          );
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(null);
          }
        }}
        className={
          "flex cursor-pointer items-center gap-1.5 border-l-2 px-2 py-1.5 text-xs uppercase tracking-wider outline-none transition-colors " +
          "focus-visible:ring-1 focus-visible:ring-asu-gold " +
          (selected === null
            ? "border-asu-gold bg-helios-line text-helios-text"
            : "border-transparent text-helios-dim hover:bg-helios-panel hover:text-helios-text")
        }
      >
        <span className="inline-block w-4 shrink-0" />
        <span>Vault root</span>
        {rootFiles.length > 0 && (
          <span className="ml-auto shrink-0 rounded bg-helios-line px-1.5 py-0.5 text-[10px] font-mono-num text-helios-dim">
            {rootFiles.length}
          </span>
        )}
      </div>
      {rootFiles.map((f) => renderFileLeaf(f, 0))}
      {tree.length === 0 && rootFiles.length === 0 ? (
        <div className="px-3 py-3 text-xs italic text-helios-dim">No folders yet.</div>
      ) : (
        tree.map((n) => renderFolderNode(n, 0))
      )}
    </div>
  );
}
