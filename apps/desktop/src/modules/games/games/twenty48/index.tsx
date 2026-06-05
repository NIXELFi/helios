import { useEffect, useRef, useState } from "react";
import type { GameProps } from "../types";
import { createInitialBoard, move, addRandomTile, canMove, type Dir } from "./logic";

interface GameState {
  board: number[];
  score: number;
  over: boolean;
}

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

// Deliberate 11-step tile ramp (2 → 2048+). Greys warm to bronze, then amber,
// then full glowing gold; values beyond 2048 fall into the maroon "beyond" tier.
const TILE_STYLES: Record<number, string> = {
  2: "bg-helios-panel text-helios-dim",
  4: "bg-[#1e1f24] text-helios-text",
  8: "bg-[#2a2718] text-[#e6c97a]",
  16: "bg-[#3a3422] text-[#f0d488]",
  32: "bg-[#4d3d1c] text-[#ffd766]",
  64: "bg-[#6b4f1a] text-[#ffdf7a]",
  128: "bg-[#9c7415] text-helios-base",
  256: "bg-[#c79412] text-helios-base",
  512: "bg-[#e2ad11] text-helios-base",
  1024: "bg-asu-gold text-helios-base shadow-[0_0_18px_rgba(255,198,39,0.45)]",
  2048: "bg-asu-gold text-helios-base shadow-[0_0_18px_rgba(255,198,39,0.45)]",
};
const TILE_BEYOND = "bg-asu-maroon text-asu-gold shadow-[0_0_18px_rgba(140,29,64,0.55)]";

function tileClass(v: number): string {
  if (v > 2048) return TILE_BEYOND;
  return TILE_STYLES[v] ?? "bg-helios-panel text-helios-text";
}

// 4-digit values (1024+) use smaller type so they never overflow the cell.
function tileTextSize(v: number): string {
  if (v >= 1024) return "text-base";
  if (v >= 128) return "text-lg";
  return "text-xl";
}

export function Twenty48Game({ onGameOver, paused }: GameProps) {
  const [game, setGame] = useState<GameState>(() => ({
    board: createInitialBoard(Math.random),
    score: 0,
    over: false,
  }));
  const ended = useRef(false);
  // Mirror game state into a ref so the keydown handler can read the latest
  // board/score/over without being re-registered on every move. Previously
  // `game` was a dep, which tore down and re-added the window listener after
  // every arrow key press (listener churn). With the ref the handler closure
  // is stable; deps reduce to [paused, onGameOver].
  const gameRef = useRef(game);
  gameRef.current = game;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const dir = KEY_DIR[e.key];
      if (!dir || paused || gameRef.current.over) return;
      e.preventDefault();

      const result = move(gameRef.current.board, dir);
      if (!result.moved) return;

      const newBoard = addRandomTile(result.board, Math.random);
      const newScore = gameRef.current.score + result.gained;
      const over = !canMove(newBoard);

      if (over && !ended.current) {
        ended.current = true;
        onGameOver(newScore);
      }

      setGame({ board: newBoard, score: newScore, over });
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paused, onGameOver]);

  return (
    <div className="games-crt">
      <div className="flex flex-col items-stretch gap-3">
        {/* Score line — micro-label + tabular value, right-aligned over grid */}
        <div className="flex items-baseline justify-end gap-2 px-1">
          <span className="games-display text-[10px] text-helios-dim">SCORE</span>
          <span className="games-num text-lg font-bold text-asu-gold">{game.score}</span>
        </div>

        <div
          role="grid"
          aria-label="2048 board"
          className={`grid grid-cols-4 gap-2 rounded-sm transition-opacity duration-300 ${
            game.over ? "opacity-40" : "opacity-100"
          }`}
        >
          {game.board.map((v, i) =>
            v === 0 ? (
              <div
                key={i}
                className="h-16 w-16 rounded-sm bg-helios-base shadow-inner"
              />
            ) : (
              // Key by index+value so a cell whose value changes remounts and
              // pops; unchanged cells keep their key and don't re-animate.
              <div
                key={`${i}-${v}`}
                className={`games-pop flex h-16 w-16 items-center justify-center rounded-sm font-bold ${tileTextSize(
                  v,
                )} ${tileClass(v)}`}
              >
                {v}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
