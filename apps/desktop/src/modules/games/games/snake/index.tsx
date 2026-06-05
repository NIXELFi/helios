import { useEffect, useRef } from "react";
import { useGameLoop } from "../../lib/useGameLoop";
import type { GameProps } from "../types";
import { GRID, createInitialState, step, type Dir, type SnakeState } from "./logic";

const CELL = 20; // 400×400 canvas
const TICK_S = 0.1; // snake advances every 100 ms

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right",
};

export function SnakeGame({ onGameOver, paused }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef<SnakeState>(createInitialState(Math.random));
  const want = useRef<Dir | null>(null);
  const acc = useRef(0);
  const ended = useRef(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const dir = KEY_DIR[e.key];
      if (!dir || paused) return;
      e.preventDefault();
      want.current = dir;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paused]);

  useGameLoop((dt) => {
    acc.current += dt;
    while (acc.current >= TICK_S) {
      acc.current -= TICK_S;
      state.current = step(state.current, want.current, Math.random);
      want.current = null;
    }
    draw(canvasRef.current, state.current);
    if (state.current.gameOver && !ended.current) {
      ended.current = true;
      onGameOver(state.current.score);
    }
    // Note: `ended` is a ref, so flipping it does NOT stop the rAF loop (the
    // effect only re-runs on `paused`). That's intentional and harmless — the
    // pure step() short-circuits on gameOver and onGameOver fires exactly
    // once behind the guard above. Don't "fix" this by making `ended` state.
  }, paused);

  return (
    <canvas
      ref={canvasRef}
      width={GRID * CELL}
      height={GRID * CELL}
      className="rounded-sm border border-helios-line bg-helios-panel"
    />
  );
}

function draw(canvas: HTMLCanvasElement | null, s: SnakeState) {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#16171B"; // helios-panel
  ctx.fillRect(0, 0, GRID * CELL, GRID * CELL);
  ctx.fillStyle = "#FFC627"; // asu-gold
  for (const p of s.snake) ctx.fillRect(p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2);
  ctx.fillStyle = "#D8DCE2"; // helios-text
  ctx.beginPath();
  ctx.arc(s.food.x * CELL + CELL / 2, s.food.y * CELL + CELL / 2, CELL / 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#9097A0"; // helios-dim
  ctx.font = "12px sans-serif";
  ctx.fillText(`Score ${s.score}`, 8, 16);
}
