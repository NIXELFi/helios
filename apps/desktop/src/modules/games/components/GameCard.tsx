import type { GameDef } from "../registry";

export function GameCard({ game, onPlay }: { game: GameDef; onPlay: () => void }) {
  const Icon = game.icon;
  return (
    <button
      type="button"
      onClick={onPlay}
      className="flex flex-col items-start gap-2 rounded-sm border border-helios-line bg-helios-panel p-4 text-left transition-colors hover:border-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
    >
      <Icon size={28} strokeWidth={1.5} className="text-asu-gold" />
      <div className="text-sm font-semibold text-helios-text">{game.title}</div>
      <div className="text-xs text-helios-dim">{game.blurb}</div>
    </button>
  );
}
