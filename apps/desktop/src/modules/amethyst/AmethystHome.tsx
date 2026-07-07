import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconAffiliate,
  IconFiles,
  IconFolderCog,
  IconLayoutDashboard,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import "./amethyst.css";
import { useVaultRoot } from "./data/useVaultRoot";
import { useKbVault } from "./data/useVault";
import { useAttachments } from "./data/useAttachments";
import { buildIndex } from "./data/searchIndex";
import { EmptyState } from "./components/EmptyState";
import { Sidebar } from "./components/Sidebar";
import { SearchPanel } from "./components/SearchPanel";
import { NoteView } from "./components/NoteView";
import { RightRail } from "./components/RightRail";
import { Dashboard } from "./components/Dashboard";
import { GraphView } from "./components/GraphView";
import { CommandPalette } from "./components/CommandPalette";

type LeftMode = "files" | "search";

export function AmethystHome() {
  const { root, pick, clear } = useVaultRoot();
  const { vault, loading, error, reload } = useKbVault(root);
  const attachments = useAttachments(vault);
  const index = useMemo(() => (vault ? buildIndex(vault.notes) : null), [vault]);

  const [leftMode, setLeftMode] = useState<LeftMode>("files");
  const [showGraph, setShowGraph] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  // Navigation history (back / forward), kept in one atomic state object.
  const [nav, setNav] = useState<{ stack: string[]; i: number }>({ stack: [], i: -1 });
  const [paletteOpen, setPaletteOpen] = useState(false);

  const activeId = nav.i >= 0 ? nav.stack[nav.i] ?? null : null;
  const activeNote = useMemo(
    () => (activeId ? vault?.resolve.get(activeId.toLowerCase()) ?? null : null),
    [activeId, vault],
  );

  const navigate = useCallback((id: string, hl?: string) => {
    setNav((prev) => {
      const trimmed = prev.stack.slice(0, prev.i + 1);
      if (trimmed[trimmed.length - 1] === id) return prev;
      const stack = [...trimmed, id];
      return { stack, i: stack.length - 1 };
    });
    setHighlight(hl ?? null);
    setShowGraph(false);
    setPaletteOpen(false);
  }, []);

  const goHome = useCallback(() => {
    setShowGraph(false);
    setNav((p) => ({ ...p, i: -1 }));
  }, []);

  const back = useCallback(() => setNav((p) => ({ ...p, i: Math.max(-1, p.i - 1) })), []);
  const forward = useCallback(
    () => setNav((p) => ({ ...p, i: Math.min(p.stack.length - 1, p.i + 1) })),
    [],
  );

  const prevRoot = useRef<string | null>(null);
  useEffect(() => {
    if (prevRoot.current !== root) {
      prevRoot.current = root;
      setNav({ stack: [], i: -1 });
      setShowGraph(false);
    }
  }, [root]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setLeftMode("search");
      } else if (mod && e.key === "[") {
        e.preventDefault();
        back();
      } else if (mod && e.key === "]") {
        e.preventDefault();
        forward();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, forward]);

  if (!root) {
    return (
      <div className="h-full bg-helios-base text-helios-text">
        <EmptyState onPick={() => void pick()} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-helios-base text-helios-text">
      {/* top bar */}
      <div className="flex items-center gap-1 border-b border-helios-line px-2 py-1.5">
        <IconBtn onClick={back} disabled={nav.i < 0} label="Back">
          <IconArrowLeft size={16} />
        </IconBtn>
        <IconBtn onClick={forward} disabled={nav.i >= nav.stack.length - 1} label="Forward">
          <IconArrowRight size={16} />
        </IconBtn>
        <IconBtn onClick={goHome} active={!showGraph && !activeNote} label="Home / dashboard">
          <IconLayoutDashboard size={15} />
        </IconBtn>
        <IconBtn onClick={() => setShowGraph((g) => !g)} active={showGraph} label="Graph view">
          <IconAffiliate size={15} />
        </IconBtn>
        <div className="mx-1 min-w-0 flex-1 truncate text-xs text-helios-dim">
          {showGraph ? "Graph" : activeNote ? activeNote.rel : "Dashboard"}
        </div>
        <IconBtn onClick={() => setPaletteOpen(true)} label="Quick switch (Ctrl+O)">
          <IconSearch size={15} />
        </IconBtn>
        <IconBtn onClick={reload} label="Refresh">
          <IconRefresh size={15} />
        </IconBtn>
        <IconBtn onClick={() => void pick()} label="Change folder">
          <IconFolderCog size={15} />
        </IconBtn>
      </div>

      {error && (
        <div className="border-b border-helios-line bg-helios-danger/10 px-3 py-2 text-xs text-helios-danger">
          Couldn’t read the folder: {error}{" "}
          <button className="underline" onClick={() => clear()}>
            pick another
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-helios-line bg-helios-panel/30">
          {/* left-pane mode toggle */}
          <div className="flex gap-0.5 border-b border-helios-line p-1.5">
            <SegBtn active={leftMode === "files"} onClick={() => setLeftMode("files")} icon={<IconFiles size={14} />} label="Files" />
            <SegBtn active={leftMode === "search"} onClick={() => setLeftMode("search")} icon={<IconSearch size={14} />} label="Search" />
          </div>
          <div className="min-h-0 flex-1">
            {!vault ? (
              <div className="p-4 text-sm text-helios-dim">{loading ? "Scanning…" : ""}</div>
            ) : leftMode === "files" ? (
              <Sidebar vault={vault} activeId={activeId} onSelect={navigate} />
            ) : index ? (
              <SearchPanel vault={vault} index={index} activeId={activeId} onSelect={navigate} />
            ) : null}
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          {!vault ? (
            <div className="flex h-full items-center justify-center text-sm text-helios-dim">
              {loading ? "Scanning your knowledge base…" : "No notes found in this folder."}
            </div>
          ) : showGraph ? (
            <GraphView vault={vault} activeId={activeId} onSelect={navigate} />
          ) : activeNote ? (
            <NoteView note={activeNote} vault={vault} attachments={attachments} highlight={highlight} onNavigate={navigate} />
          ) : (
            <Dashboard vault={vault} onNavigate={navigate} />
          )}
        </main>

        {vault && activeNote && !showGraph && (
          <aside className="w-60 shrink-0 border-l border-helios-line bg-helios-panel/30">
            <RightRail note={activeNote} vault={vault} onNavigate={navigate} />
          </aside>
        )}
      </div>

      {paletteOpen && vault && (
        <CommandPalette notes={vault.notes} onPick={navigate} onClose={() => setPaletteOpen(false)} />
      )}
    </div>
  );
}

function IconBtn({
  onClick,
  disabled,
  active,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={
        "rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
        (active ? "bg-asu-gold/15 text-asu-gold" : "text-helios-dim hover:bg-helios-panel hover:text-helios-text")
      }
    >
      {children}
    </button>
  );
}

function SegBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors " +
        (active ? "bg-asu-gold/15 text-asu-gold" : "text-helios-dim hover:bg-helios-panel hover:text-helios-text")
      }
    >
      {icon}
      {label}
    </button>
  );
}
