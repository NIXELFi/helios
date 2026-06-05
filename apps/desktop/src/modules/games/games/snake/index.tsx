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
    <div className="games-crt">
      <canvas
        ref={canvasRef}
        width={GRID * CELL}
        height={GRID * CELL}
        role="img"
        aria-label="Snake game"
      />
    </div>
  );
}

const SIZE = GRID * CELL;

// Per-segment fill: head full gold #FFC627 → tail #8a6c1a. Precomputed cheaply
// from index/length each call; the lerp is a few multiplies, no allocation.
function segmentColor(t: number): string {
  // t: 0 at head, 1 at tail
  const r = Math.round(0xff + (0x8a - 0xff) * t);
  const g = Math.round(0xc6 + (0x6c - 0xc6) * t);
  const b = Math.round(0x27 + (0x1a - 0x27) * t);
  return `rgb(${r},${g},${b})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  const rad = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function draw(canvas: HTMLCanvasElement | null, s: SnakeState) {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;

  // Flat dark surface.
  ctx.fillStyle = "#101114";
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Faint 1px grid every CELL.
  ctx.strokeStyle = "#1A1B20";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < GRID; i++) {
    const p = i * CELL + 0.5;
    ctx.moveTo(p, 0);
    ctx.lineTo(p, SIZE);
    ctx.moveTo(0, p);
    ctx.lineTo(SIZE, p);
  }
  ctx.stroke();

  // Food: pulsing gold glow dot.
  const t = performance.now() / 1000;
  const pulse = (Math.sin(t * 4) + 1) / 2; // 0..1
  const fcx = s.food.x * CELL + CELL / 2;
  const fcy = s.food.y * CELL + CELL / 2;
  ctx.save();
  ctx.shadowColor = "#FFC627";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "#FFC627";
  ctx.globalAlpha = 0.7 + 0.3 * pulse;
  ctx.beginPath();
  ctx.arc(fcx, fcy, CELL / 3.5 + pulse * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Snake: rounded-rect segments, head→tail brightness falloff.
  const n = s.snake.length;
  for (let i = n - 1; i >= 0; i--) {
    const p = s.snake[i]!;
    ctx.fillStyle = segmentColor(n > 1 ? i / (n - 1) : 0);
    roundRect(ctx, p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2, 4);
    ctx.fill();
  }

  // Head eyes, oriented by dir.
  const head = s.snake[0];
  if (head) {
    const hx = head.x * CELL;
    const hy = head.y * CELL;
    ctx.fillStyle = "#101114";
    const eye = 2.2;
    let e1x = 0, e1y = 0, e2x = 0, e2y = 0;
    const near = CELL * 0.32;
    const far = CELL * 0.68;
    switch (s.dir) {
      case "up":
        e1x = near; e1y = near; e2x = far; e2y = near; break;
      case "down":
        e1x = near; e1y = far; e2x = far; e2y = far; break;
      case "left":
        e1x = near; e1y = near; e2x = near; e2y = far; break;
      case "right":
        e1x = far; e1y = near; e2x = far; e2y = far; break;
    }
    ctx.beginPath();
    ctx.arc(hx + e1x, hy + e1y, eye, 0, Math.PI * 2);
    ctx.arc(hx + e2x, hy + e2y, eye, 0, Math.PI * 2);
    ctx.fill();
  }

  // HUD: SCORE microlabel + tabular number, top-left.
  ctx.textBaseline = "alphabetic";
  ctx.font = "700 9px Orbitron, sans-serif";
  ctx.fillStyle = "#9097A0";
  ctx.fillText("SCORE", 10, 18);
  ctx.font = "700 18px Orbitron, sans-serif";
  ctx.fillStyle = "#D8DCE2";
  ctx.fillText(String(s.score), 10, 38);

  // Dim the board on game over so the overlay pops.
  if (s.gameOver) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, SIZE, SIZE);
  }
}
