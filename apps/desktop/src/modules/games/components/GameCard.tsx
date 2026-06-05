import type { GameDef } from "../registry";

export function GameCard({ game, onPlay, index }: { game: GameDef; onPlay: () => void; index: number }) {
  const Icon = game.icon;
  return (
    <button
      type="button"
      onClick={onPlay}
      style={{ animationDelay: `${index * 70}ms` }}
      className="games-rise group relative flex flex-col items-start gap-3 overflow-hidden rounded-sm border border-helios-line bg-helios-panel p-5 text-left transition hover:-translate-y-0.5 hover:border-asu-gold hover:shadow-[0_0_24px_-6px_rgba(255,198,39,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold sm:p-6"
    >
      {/* grid-position badge */}
      <span className="games-num absolute right-3 top-3 text-xs font-semibold text-helios-dim/70">
        P{index + 1}
      </span>

      <Icon size={34} strokeWidth={1.5} className="text-asu-gold" />
      <div className="games-display text-sm text-helios-text">{game.title}</div>
      <div className="text-xs text-helios-dim">{game.blurb}</div>

      {/* play affordance — revealed on hover */}
      <div className="games-display text-[0.65rem] tracking-[0.2em] text-asu-gold opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        PLAY ▸
      </div>

      {/* bottom hazard-stripe accent */}
      <span className="games-hazard absolute inset-x-0 bottom-0 h-0.5 opacity-40 transition-opacity duration-200 group-hover:opacity-100" />
    </button>
  );
}
