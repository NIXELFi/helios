import { useEffect, useMemo, useState } from "react";
import {
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import type { KbNote, KbVault } from "../types";
import { NotePreviewCard, useNotePreview } from "./HoverPreview";

interface TreeNode {
  name: string;
  path: string; // dir path or note id
  isDir: boolean;
  note?: KbNote;
  children: TreeNode[];
}

function buildTree(notes: KbNote[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  const dirMap = new Map<string, TreeNode>([["", root]]);
  const ensureDir = (dir: string): TreeNode => {
    if (dirMap.has(dir)) return dirMap.get(dir)!;
    const parentPath = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    const parent = ensureDir(parentPath);
    const node: TreeNode = {
      name: dir.split("/").pop() ?? dir,
      path: dir,
      isDir: true,
      children: [],
    };
    parent.children.push(node);
    dirMap.set(dir, node);
    return node;
  };
  for (const n of notes) {
    const parent = ensureDir(n.dir);
    parent.children.push({ name: n.title, path: n.id, isDir: false, note: n, children: [] });
  }
  const sortRec = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    node.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

export function Sidebar({
  vault,
  activeId,
  onSelect,
}: {
  vault: KbVault;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const { preview, show, hide } = useNotePreview();
  const tree = useMemo(() => buildTree(vault.notes), [vault.notes]);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(tree.children.filter((c) => c.isDir).map((c) => c.path)),
  );

  // Auto-expand ancestors of the active note.
  useEffect(() => {
    if (!activeId) return;
    const parts = activeId.split("/");
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [activeId]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return vault.notes
      .map((n) => {
        const hay = `${n.title} ${n.id} ${n.tags.join(" ")}`.toLowerCase();
        let score = hay.includes(q) ? 2 : 0;
        if (!score && n.body.toLowerCase().includes(q)) score = 1;
        return { n, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.n.title.localeCompare(b.n.title))
      .slice(0, 60)
      .map((r) => r.n);
  }, [query, vault.notes]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-2">
        <div className="relative">
          <IconSearch
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-helios-dim"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes…"
            className="w-full rounded-md border border-helios-line bg-helios-base py-1.5 pl-8 pr-7 text-sm text-helios-text placeholder:text-helios-dim focus:border-asu-gold/60 focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-helios-dim hover:text-helios-text"
              aria-label="Clear search"
            >
              <IconX size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="kb-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-3">
        {results ? (
          <div className="px-1">
            <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-helios-dim">
              {results.length} result{results.length === 1 ? "" : "s"}
            </div>
            {results.map((n) => (
              <FileRow
                key={n.id}
                label={n.title}
                sub={n.dir}
                active={n.id === activeId}
                onClick={() => onSelect(n.id)}
                onHover={(el) => show(n, el)}
                onHoverOut={hide}
              />
            ))}
            {results.length === 0 && <div className="px-3 py-4 text-sm text-helios-dim">No matches.</div>}
          </div>
        ) : (
          <TreeLevel
            node={tree}
            depth={0}
            expanded={expanded}
            toggle={toggle}
            activeId={activeId}
            onSelect={onSelect}
            onHover={show}
            onHoverOut={hide}
          />
        )}
      </div>
      <NotePreviewCard preview={preview} />
    </div>
  );
}

function TreeLevel({
  node,
  depth,
  expanded,
  toggle,
  activeId,
  onSelect,
  onHover,
  onHoverOut,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (p: string) => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onHover: (note: KbNote, el: HTMLElement) => void;
  onHoverOut: () => void;
}) {
  return (
    <>
      {node.children.map((child) =>
        child.isDir ? (
          <div key={child.path}>
            <button
              onClick={() => toggle(child.path)}
              className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-sm text-helios-text/90 hover:bg-helios-panel"
              style={{ paddingLeft: 6 + depth * 12 }}
            >
              <IconChevronRight
                size={13}
                className={"shrink-0 text-helios-dim transition-transform " + (expanded.has(child.path) ? "rotate-90" : "")}
              />
              <IconFolder size={14} className="shrink-0 text-asu-gold/70" />
              <span className="truncate">{child.name}</span>
            </button>
            {expanded.has(child.path) && (
              <TreeLevel node={child} depth={depth + 1} expanded={expanded} toggle={toggle} activeId={activeId} onSelect={onSelect} onHover={onHover} onHoverOut={onHoverOut} />
            )}
          </div>
        ) : (
          <FileRow
            key={child.path}
            label={child.name}
            indent={depth}
            active={child.path === activeId}
            onClick={() => onSelect(child.path)}
            onHover={child.note ? (el) => onHover(child.note!, el) : undefined}
            onHoverOut={onHoverOut}
          />
        ),
      )}
    </>
  );
}

function FileRow({
  label,
  sub,
  indent = 0,
  active,
  onClick,
  onHover,
  onHoverOut,
}: {
  label: string;
  sub?: string;
  indent?: number;
  active: boolean;
  onClick: () => void;
  onHover?: (el: HTMLElement) => void;
  onHoverOut?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onHover ? (e) => onHover(e.currentTarget) : undefined}
      onMouseLeave={onHoverOut}
      className={
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm " +
        (active ? "bg-asu-gold/15 text-asu-gold" : "text-helios-text/80 hover:bg-helios-panel")
      }
      style={{ paddingLeft: 6 + (indent + 1) * 12 }}
    >
      <IconFileText size={13} className={"shrink-0 " + (active ? "text-asu-gold" : "text-helios-dim")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {sub && <span className="shrink-0 truncate text-[10px] text-helios-dim">{sub}</span>}
    </button>
  );
}
