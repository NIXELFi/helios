import { useState, useRef } from "react";
import "./games.css";
import { useHeliosAuth } from "../../auth/AuthShell";
import { submitScore, type GameId } from "./api";
import { GAMES, type GameDef } from "./registry";
import { GameCard } from "./components/GameCard";
import { LeaderboardPanel } from "./components/LeaderboardPanel";
import { GameStandings } from "./components/GameStandings";
import { GameOverOverlay, type SubmitStatus } from "./components/GameOverOverlay";

export interface GamesModuleProps {
  /** True while another module is the active tab — games must halt their
   *  loops so a hidden game doesn't burn CPU or rack up time-based score. */
  paused: boolean;
}

const LAST_GAME_KEY = "helios:games:lastGame";

export function GamesModule({ paused }: GamesModuleProps) {
  const { client } = useHeliosAuth();
  const [active, setActive] = useState<GameDef | null>(null);
  const [run, setRun] = useState(0); // key bump remounts the game = restart
  const [over, setOver] = useState<{ score: number; status: SubmitStatus } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [boardGame, setBoardGame] = useState<GameId>(() => {
    try {
      const saved = localStorage.getItem(LAST_GAME_KEY) as GameId | null;
      return saved && GAMES.some((g) => g.id === saved) ? saved : GAMES[0]!.id;
    } catch {
      return GAMES[0]!.id;
    }
  });

  function play(game: GameDef) {
    setActive(game);
    setOver(null);
    setRun((n) => n + 1);
    setBoardGame(game.id);
    try {
      localStorage.setItem(LAST_GAME_KEY, game.id);
    } catch {
      // ignore (private mode / quota)
    }
  }

  async function handleGameOver(score: number) {
    if (!active || !client) return;
    setOver({ score, status: "submitting" });
    try {
      await submitScore(client, active.id, score);
      setOver({ score, status: "submitted" });
      setRefreshToken((n) => n + 1);
    } catch {
      setOver({ score, status: "error" });
    }
  }

  // Keep the latest closure in a ref but hand the games a stable identity, so
  // a GamesModule re-render (e.g. leaderboard refresh) can't churn their
  // input-listener effects mid-play.
  const handleGameOverRef = useRef(handleGameOver);
  handleGameOverRef.current = handleGameOver;
  const stableOnGameOver = useRef((score: number) => {
    void handleGameOverRef.current(score);
  }).current;

  if (!client) return null; // module is auth-gated by the shell; belt-and-braces

  const ActiveGame = active?.component;

  return (
    <div className="games-root games-bg flex h-full">
      <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-4">
        {active && ActiveGame ? (
          /* In-game the standings wrap the surface vertically (podium strip
           * above, rest of the field below) instead of a side tower — the
           * games are small, so the vertical room is where the space is. */
          <div className="flex h-full min-h-0 w-fit max-w-full flex-col justify-center gap-2">
            <div className="flex shrink-0 items-center justify-between">
              <div className="games-display text-sm text-helios-text">{active.title}</div>
              <button
                type="button"
                onClick={() => { setActive(null); setOver(null); }}
                className="rounded-sm px-2 py-1 text-xs text-helios-dim transition-colors hover:text-asu-gold"
              >
                ← All games
              </button>
            </div>
            <GameStandings client={client} gameId={active.id} refreshToken={refreshToken}>
              <div className="relative shrink-0 self-center">
                <ActiveGame key={run} onGameOver={stableOnGameOver} paused={paused} />
                {over && (
                  <GameOverOverlay
                    score={over.score}
                    status={over.status}
                    onRetrySubmit={() => void handleGameOver(over.score)}
                    onRestart={() => {
                      setOver(null);
                      setRun((n) => n + 1);
                    }}
                    onBack={() => { setActive(null); setOver(null); }}
                  />
                )}
              </div>
            </GameStandings>
          </div>
        ) : (
          <div className="w-full max-w-2xl">
            <div className="mb-6">
              <div className="games-hazard mb-3 h-1 w-12 rounded-sm" />
              <h1 className="games-display-heavy text-2xl tracking-[0.22em] text-asu-gold">ARCADE</h1>
              <p className="mt-1 text-xs text-helios-dim">Sun Devil Motorsports · after hours</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {GAMES.map((g, i) => (
                <GameCard key={g.id} game={g} index={i} onPlay={() => play(g)} />
              ))}
            </div>
          </div>
        )}
      </div>
      {/* Side tower only in the lobby — in-game the standings wrap the
          surface via GameStandings instead. */}
      {!active && (
        <LeaderboardPanel client={client} gameId={boardGame} refreshToken={refreshToken} />
      )}
    </div>
  );
}
