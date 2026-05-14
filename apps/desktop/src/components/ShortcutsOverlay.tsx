import { useEffect } from "react";

interface Shortcut {
  keys: string[];
  label: string;
}

interface Group {
  title: string;
  items: Shortcut[];
}

const GROUPS: Group[] = [
  {
    title: "Workspace",
    items: [
      { keys: ["⌘", "1"], label: "Switch to workspace 1 (⌘1..9 for tab N)" },
      { keys: ["⌘", "E"], label: "Toggle edit mode" },
      { keys: ["⌘", "K"], label: "Open command palette" },
      { keys: ["⌘", "O"], label: "Open data file…" },
      { keys: ["?"],      label: "Show this overlay" },
    ],
  },
  {
    title: "Cursor & laps",
    items: [
      { keys: ["Space"], label: "Play / pause cursor" },
      { keys: ["["],     label: "Previous lap boundary (primary)" },
      { keys: ["]"],     label: "Next lap boundary (primary)" },
      { keys: ["M"],     label: "Make lap at cursor the Main lap" },
      { keys: ["R"],     label: "Make lap at cursor the Ref lap" },
    ],
  },
  {
    title: "Strip chart",
    items: [
      { keys: ["click"],         label: "Scrub cursor (time or distance mode)" },
      { keys: ["shift", "click"], label: "Drop a datum marker" },
      { keys: ["shift", "drag"],  label: "Zoom to drawn range" },
      { keys: ["dbl-click"],     label: "Reset zoom" },
    ],
  },
];

function KeyChip({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 border border-helios-line bg-helios-base text-helios-text rounded-sm text-[10px] font-mono-num">
      {children}
    </kbd>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Compact keyboard-shortcuts cheat sheet. Triggered by `?` from anywhere
 *  outside an input. Esc / backdrop click dismisses. Static content — the
 *  bindings themselves live in App.tsx; if you add a new hotkey there,
 *  add the corresponding entry here. */
export function ShortcutsOverlay({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] bg-helios-panel border border-helios-line rounded-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center justify-between px-3 border-b border-helios-line">
          <span className="text-xs uppercase tracking-wider text-asu-gold">Keyboard shortcuts</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-helios-dim hover:text-asu-gold hover:bg-helios-base rounded-sm"
          >×</button>
        </div>
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="text-[10px] uppercase tracking-wider text-helios-dim mb-2">{g.title}</div>
              <ul className="space-y-1.5">
                {g.items.map((s, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-helios-text flex-1 min-w-0 truncate">{s.label}</span>
                    <span className="flex items-center gap-1 flex-shrink-0">
                      {s.keys.map((k, j) => (
                        <KeyChip key={j}>{k}</KeyChip>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-helios-line px-3 py-2 text-[10px] text-helios-dim font-mono-num">
          ? to reopen · esc to close
        </div>
      </div>
    </div>
  );
}
