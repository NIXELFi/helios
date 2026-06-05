import { useEffect, useRef } from "react";
import { useGameLoop } from "../../lib/useGameLoop";
import type { GameProps } from "../types";
import {
  W, H, PADDLE_W, PADDLE_H, PADDLE_Y, BALL_R, COLS, ROWS, BRICK_W, BRICK_H, BRICK_TOP,
  createInitialState, step, type BreakoutState,
} from "./logic";

export function BreakoutGame({ onGameOver, paused }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef<BreakoutState>(createInitialState());
  const paddleX = useRef((W - PADDLE_W) / 2);
  const ended = useRef(false);
  const keys = useRef<Set<string>>(new Set());
  const trail = useRef<{ x: number; y: number }[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function onMouseMove(e: MouseEvent) {
      if (paused) return;
      const rect = canvas!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      paddleX.current = Math.max(0, Math.min(W - PADDLE_W, cx - PADDLE_W / 2));
    }

    function onKeyDown(e: KeyboardEvent) {
      if (paused) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        keys.current.add(e.key);
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      keys.current.delete(e.key);
    }

    canvas.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      canvas.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [paused]);

  useGameLoop((dt) => {
    // Keyboard paddle movement: 300px/s
    if (keys.current.has("ArrowLeft")) {
      paddleX.current = Math.max(0, paddleX.current - 300 * dt);
    }
    if (keys.current.has("ArrowRight")) {
      paddleX.current = Math.min(W - PADDLE_W, paddleX.current + 300 * dt);
    }

    state.current = step(state.current, dt, paddleX.current);

    // Update ball motion trail (reuse array; cap at 5 points).
    const tr = trail.current;
    tr.push({ x: state.current.x, y: state.current.y });
    if (tr.length > 5) tr.shift();

    draw(canvasRef.current, state.current, paddleX.current, tr);

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
        width={W}
        height={H}
        role="img"
        aria-label="Breakout game"
      />
    </div>
  );
}

// Per-row color ramp: maroon #8C1D40 (top) → gold #FFC627 (bottom), RGB lerp.
// Precomputed once at module load — ROWS is constant.
function lerpColor(t: number): string {
  const r = Math.round(0x8c + (0xff - 0x8c) * t);
  const g = Math.round(0x1d + (0xc6 - 0x1d) * t);
  const b = Math.round(0x40 + (0x27 - 0x40) * t);
  return `rgb(${r},${g},${b})`;
}
const ROW_COLORS: string[] = Array.from({ length: ROWS }, (_, i) =>
  lerpColor(ROWS > 1 ? i / (ROWS - 1) : 0),
);
// Slightly darker variant for the bottom-edge depth line.
const ROW_EDGES: string[] = Array.from({ length: ROWS }, (_, i) => {
  const t = ROWS > 1 ? i / (ROWS - 1) : 0;
  const r = Math.round((0x8c + (0xff - 0x8c) * t) * 0.6);
  const g = Math.round((0x1d + (0xc6 - 0x1d) * t) * 0.6);
  const b = Math.round((0x40 + (0x27 - 0x40) * t) * 0.6);
  return `rgb(${r},${g},${b})`;
});

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

function draw(
  canvas: HTMLCanvasElement | null,
  s: BreakoutState,
  paddleX: number,
  trail: { x: number; y: number }[],
) {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;

  // Flat dark surface (bezel supplies the vignette).
  ctx.fillStyle = "#101114";
  ctx.fillRect(0, 0, W, H);

  // Bricks: row color ramp, rounded with a darker bottom-edge for depth.
  const gap = 2;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!s.bricks[row * COLS + col]) continue;
      const bx = col * BRICK_W + gap;
      const by = BRICK_TOP + row * BRICK_H + gap;
      const bw = BRICK_W - gap * 2;
      const bh = BRICK_H - gap * 2;
      // bottom-edge depth line
      ctx.fillStyle = ROW_EDGES[row]!;
      roundRect(ctx, bx, by + 1, bw, bh, 3);
      ctx.fill();
      // face
      ctx.fillStyle = ROW_COLORS[row]!;
      roundRect(ctx, bx, by, bw, bh - 1, 3);
      ctx.fill();
    }
  }

  // Ball trail: fading white circles, oldest → newest (alpha 0.1 → 0.5).
  for (let i = 0; i < trail.length; i++) {
    const p = trail[i]!;
    const a = 0.1 + (0.4 * i) / Math.max(1, trail.length - 1);
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, BALL_R * (0.5 + 0.4 * (i / Math.max(1, trail.length))), 0, Math.PI * 2);
    ctx.fill();
  }

  // Paddle: gold capsule with a slight glow.
  ctx.save();
  ctx.shadowColor = "#FFC627";
  ctx.shadowBlur = 8;
  ctx.fillStyle = "#FFC627";
  roundRect(ctx, paddleX, PADDLE_Y, PADDLE_W, PADDLE_H, PADDLE_H / 2);
  ctx.fill();
  ctx.restore();

  // Ball: white core.
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(s.x, s.y, BALL_R, 0, Math.PI * 2);
  ctx.fill();

  // HUD: SCORE (top-left) + LVL (top-right), Orbitron microlabels.
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.font = "700 9px Orbitron, sans-serif";
  ctx.fillStyle = "#9097A0";
  ctx.fillText("SCORE", 10, 18);
  ctx.font = "700 16px Orbitron, sans-serif";
  ctx.fillStyle = "#D8DCE2";
  ctx.fillText(String(s.score), 10, 34);

  ctx.textAlign = "right";
  ctx.font = "700 9px Orbitron, sans-serif";
  ctx.fillStyle = "#9097A0";
  ctx.fillText("LVL", W - 10, 18);
  ctx.font = "700 16px Orbitron, sans-serif";
  ctx.fillStyle = "#D8DCE2";
  ctx.fillText(String(s.level), W - 10, 34);
  ctx.textAlign = "left";

  // Dim on game over so the overlay pops.
  if (s.gameOver) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, W, H);
  }
}
