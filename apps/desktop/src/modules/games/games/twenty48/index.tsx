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
    <div className="flex flex-col items-center gap-3">
      <div className="text-sm text-helios-dim">Score {game.score}</div>
      <div role="grid" aria-label="2048 board" className="grid grid-cols-4 gap-2 p-3 rounded-sm border border-helios-line bg-helios-panel">
        {game.board.map((v, i) => (
          <div
            key={i}
            className="flex h-16 w-16 items-center justify-center rounded-sm text-lg font-bold"
            style={
              v === 0
                ? { backgroundColor: "rgba(22,23,27,1)" }
                : {
                    backgroundColor: `rgba(255,198,39,${Math.min(0.25 + Math.log2(v) * 0.075, 1)})`,
                    color: "#16171B",
                  }
            }
          >
            {v !== 0 ? v : null}
          </div>
        ))}
      </div>
    </div>
  );
}
