import { IconDiamond, IconFolderOpen } from "@tabler/icons-react";

export function EmptyState({ onPick }: { onPick: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 inline-flex rounded-2xl bg-asu-gold/10 p-4 text-asu-gold">
          <IconDiamond size={40} strokeWidth={1.4} />
        </div>
        <h1 className="font-display text-2xl text-helios-text">Amethyst</h1>
        <p className="mt-1 text-xs uppercase tracking-widest text-asu-gold/70">Knowledge Base</p>
        <p className="mt-3 text-sm leading-relaxed text-helios-dim">
          Point Amethyst at your knowledge-base folder — an Obsidian-style vault of markdown notes and
          figures. The files stay on disk; Helios reads them live and gives you a fast, linked reader
          with search, backlinks, and embedded figures.
        </p>
        <button
          onClick={onPick}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-asu-gold px-4 py-2.5 text-sm font-semibold text-helios-base transition-colors hover:bg-asu-gold/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold focus-visible:ring-offset-2 focus-visible:ring-offset-helios-base"
        >
          <IconFolderOpen size={18} strokeWidth={1.8} />
          Choose folder…
        </button>
        <p className="mt-4 text-xs text-helios-dim/70">
          Your selection is remembered on this machine.
        </p>
      </div>
    </div>
  );
}
