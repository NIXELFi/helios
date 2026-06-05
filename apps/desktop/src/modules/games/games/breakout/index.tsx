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
    draw(canvasRef.current, state.current, paddleX.current);

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
      width={W}
      height={H}
      className="rounded-sm border border-helios-line bg-helios-panel"
      role="img"
      aria-label="Breakout game"
    />
  );
}

function draw(canvas: HTMLCanvasElement | null, s: BreakoutState, paddleX: number) {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;

  // Background
  ctx.fillStyle = "#16171B"; // helios-panel
  ctx.fillRect(0, 0, W, H);

  // Bricks
  ctx.fillStyle = "#FFC627"; // asu-gold
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!s.bricks[row * COLS + col]) continue;
      const bx = col * BRICK_W + 1;
      const by = BRICK_TOP + row * BRICK_H + 1;
      ctx.fillRect(bx, by, BRICK_W - 2, BRICK_H - 2);
    }
  }

  // Paddle
  ctx.fillStyle = "#D8DCE2"; // helios-text
  ctx.fillRect(paddleX, PADDLE_Y, PADDLE_W, PADDLE_H);

  // Ball
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(s.x, s.y, BALL_R, 0, Math.PI * 2);
  ctx.fill();

  // Score + level
  ctx.fillStyle = "#9097A0"; // helios-dim
  ctx.font = "12px sans-serif";
  ctx.fillText(`Score ${s.score}  Level ${s.level}`, 8, 16);
}
