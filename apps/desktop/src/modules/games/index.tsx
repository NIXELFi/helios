import { useState } from "react";
import { useHeliosAuth } from "../../auth/AuthShell";
import { submitScore, type GameId } from "./api";
import { GAMES, type GameDef } from "./registry";
import { GameCard } from "./components/GameCard";
import { LeaderboardPanel } from "./components/LeaderboardPanel";
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

  if (!client) return null; // module is auth-gated by the shell; belt-and-braces

  const ActiveGame = active?.component;

  return (
    <div className="flex h-full bg-helios-base">
      <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-4">
        {active && ActiveGame ? (
          <>
            <div className="flex w-full max-w-xl items-center justify-between">
              <div className="text-sm font-semibold text-helios-text">{active.title}</div>
              <button
                type="button"
                onClick={() => setActive(null)}
                className="rounded-sm border border-helios-line bg-helios-panel px-2 py-1 text-xs text-helios-text hover:border-asu-gold"
              >
                ← All games
              </button>
            </div>
            <div className="relative">
              <ActiveGame key={run} onGameOver={(s) => void handleGameOver(s)} paused={paused} />
              {over && (
                <GameOverOverlay
                  score={over.score}
                  status={over.status}
                  onRetrySubmit={() => void handleGameOver(over.score)}
                  onRestart={() => {
                    setOver(null);
                    setRun((n) => n + 1);
                  }}
                  onBack={() => setActive(null)}
                />
              )}
            </div>
          </>
        ) : (
          <div className="grid w-full max-w-xl grid-cols-2 gap-3">
            {GAMES.map((g) => (
              <GameCard key={g.id} game={g} onPlay={() => play(g)} />
            ))}
          </div>
        )}
      </div>
      <LeaderboardPanel client={client} gameId={boardGame} refreshToken={refreshToken} />
    </div>
  );
}
