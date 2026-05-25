import { useEffect, useState } from "react";
import type { FileId, Folder, FolderId, Lock, UserId, VaultFile } from "../data/types";

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
}

interface FolderNode {
  folder: Folder;
  children: FolderNode[];
}

function buildTree(folders: Folder[]): FolderNode[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const arr = byParent.get(f.parent_id) ?? [];
    arr.push(f);
    byParent.set(f.parent_id, arr);
  }
  function nodesFor(parentId: string | null): FolderNode[] {
    return (byParent.get(parentId) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ folder: f, children: nodesFor(f.id) }));
  }
  return nodesFor(null);
}

function ancestorsOf(folderId: FolderId, folders: Folder[]): FolderId[] {
  const out: FolderId[] = [];
  let current = folders.find((f) => f.id === folderId);
  while (current?.parent_id) {
    out.push(current.parent_id);
    current = folders.find((f) => f.id === current!.parent_id);
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

export function FolderTree({
  folders,
  selected,
  onSelect,
  files = [],
  selectedFile,
  onSelectFile,
  locks = [],
  currentUserId,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = buildTree(folders);

  // Pre-bucket files by folder_id for O(1) lookup during render.
  const filesByFolder = new Map<string | null, VaultFile[]>();
  for (const f of files) {
    const key = f.folder_id;
    const arr = filesByFolder.get(key) ?? [];
    arr.push(f);
    filesByFolder.set(key, arr);
  }
  for (const arr of filesByFolder.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }

  useEffect(() => {
    if (!selected) return;
    const ancestors = ancestorsOf(selected, folders);
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of ancestors) next.add(id);
      return next;
    });
  }, [selected, folders]);

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
    const lock = locks.find((l) => l.file_id === fileId && l.released_at === null);
    if (!lock) return "none";
    return lock.user_id === currentUserId ? "me" : "other";
  }

  function renderFileLeaf(file: VaultFile, depth: number): React.ReactNode {
    const isSelectedFile = selectedFile === file.id;
    const lockKind = lockKindFor(file.id);
    return (
      <div
        key={file.id}
        role="button"
        tabIndex={0}
        aria-current={isSelectedFile ? "page" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          // Select the file's containing folder (null = vault root) so the
          // right-side file table jumps to it, then mark the file as selected
          // for the detail panel.
          onSelect(file.folder_id);
          onSelectFile?.(file.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(file.folder_id);
            onSelectFile?.(file.id);
          }
        }}
        className={
          "flex cursor-pointer items-center gap-1.5 border-l-2 py-0.5 pr-2 text-[13px] outline-none transition-colors " +
          "focus-visible:ring-1 focus-visible:ring-asu-gold " +
          (isSelectedFile
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

    return (
      <div key={node.folder.id}>
        <div
          role="button"
          tabIndex={0}
          aria-current={isSelected ? "page" : undefined}
          onClick={() => handleRowClick(node)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleRowClick(node);
            }
          }}
          className={
            "group flex cursor-pointer items-center gap-1.5 border-l-2 py-1 pr-2 text-sm outline-none transition-colors " +
            "focus-visible:ring-1 focus-visible:ring-asu-gold " +
            (isSelected
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

  return (
    <div className="flex select-none flex-col gap-0.5 py-2">
      <div
        role="button"
        tabIndex={0}
        aria-current={selected === null ? "page" : undefined}
        onClick={() => onSelect(null)}
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
