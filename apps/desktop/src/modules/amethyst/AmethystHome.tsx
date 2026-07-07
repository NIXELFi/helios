import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconFolderCog,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import "./amethyst.css";
import { useVaultRoot } from "./data/useVaultRoot";
import { useKbVault } from "./data/useVault";
import { useAttachments } from "./data/useAttachments";
import { EmptyState } from "./components/EmptyState";
import { Sidebar } from "./components/Sidebar";
import { NoteView } from "./components/NoteView";
import { RightRail } from "./components/RightRail";
import { Dashboard } from "./components/Dashboard";
import { CommandPalette } from "./components/CommandPalette";

export function AmethystHome() {
  const { root, pick, clear } = useVaultRoot();
  const { vault, loading, error, reload } = useKbVault(root);
  const attachments = useAttachments(vault);

  // Navigation history (back / forward), like a browser. Kept in one atomic
  // state object so stack + index never desync.
  const [nav, setNav] = useState<{ stack: string[]; i: number }>({ stack: [], i: -1 });
  const [paletteOpen, setPaletteOpen] = useState(false);

  const activeId = nav.i >= 0 ? nav.stack[nav.i] ?? null : null;
  const activeNote = useMemo(
    () => (activeId ? vault?.resolve.get(activeId.toLowerCase()) ?? null : null),
    [activeId, vault],
  );

  const navigate = useCallback((id: string) => {
    setNav((prev) => {
      const trimmed = prev.stack.slice(0, prev.i + 1);
      if (trimmed[trimmed.length - 1] === id) return prev;
      const stack = [...trimmed, id];
      return { stack, i: stack.length - 1 };
    });
    setPaletteOpen(false);
  }, []);

  const back = useCallback(() => setNav((p) => ({ ...p, i: Math.max(-1, p.i - 1) })), []);
  const forward = useCallback(
    () => setNav((p) => ({ ...p, i: Math.min(p.stack.length - 1, p.i + 1) })),
    [],
  );

  // Reset navigation when the vault root changes.
  const prevRoot = useRef<string | null>(null);
  useEffect(() => {
    if (prevRoot.current !== root) {
      prevRoot.current = root;
      setNav({ stack: [], i: -1 });
    }
  }, [root]);

  // Global-ish shortcuts (module is always mounted, so gate on visibility via
  // document.hasFocus + the palette being the only KB-owned key handler).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "[") {
        e.preventDefault();
        back();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "]") {
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
        <div className="mx-1 min-w-0 flex-1 truncate text-xs text-helios-dim">
          {activeNote ? activeNote.rel : "Knowledge Base"}
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
        <aside className="w-64 shrink-0 border-r border-helios-line bg-helios-panel/30">
          {vault ? (
            <Sidebar vault={vault} activeId={activeId} onSelect={navigate} />
          ) : (
            <div className="p-4 text-sm text-helios-dim">{loading ? "Scanning…" : ""}</div>
          )}
        </aside>

        <main className="min-w-0 flex-1">
          {!vault ? (
            <div className="flex h-full items-center justify-center text-sm text-helios-dim">
              {loading ? "Scanning your knowledge base…" : "No notes found in this folder."}
            </div>
          ) : activeNote ? (
            <NoteView note={activeNote} vault={vault} attachments={attachments} onNavigate={navigate} />
          ) : (
            <Dashboard vault={vault} onNavigate={navigate} />
          )}
        </main>

        {vault && activeNote && (
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
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
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
      className="rounded p-1.5 text-helios-dim transition-colors hover:bg-helios-panel hover:text-helios-text disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
    >
      {children}
    </button>
  );
}
