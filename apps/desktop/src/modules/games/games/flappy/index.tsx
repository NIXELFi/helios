import { useEffect, useRef } from "react";
import { useGameLoop } from "../../lib/useGameLoop";
import type { GameProps } from "../types";
import {
  WORLD, BIRD_X, BIRD_R, PIPE_W, GAP_H,
  createInitialState, step, type FlappyState,
} from "./logic";

export function FlappyGame({ onGameOver, paused }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef<FlappyState>(createInitialState());
  const flapQueued = useRef(false);
  const ended = useRef(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (paused) return;
      if (e.key === " ") {
        e.preventDefault();
        flapQueued.current = true;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onClick() {
      if (paused) return;
      flapQueued.current = true;
    }
    canvas.addEventListener("click", onClick);
    return () => canvas.removeEventListener("click", onClick);
  }, [paused]);

  useGameLoop((dt) => {
    state.current = step(state.current, dt, flapQueued.current, Math.random);
    flapQueued.current = false;
    draw(canvasRef.current, state.current);
    if (state.current.dead && !ended.current) {
      ended.current = true;
      onGameOver(state.current.score);
    }
    // Note: `ended` is a ref, so flipping it does NOT stop the rAF loop (the
    // effect only re-runs on `paused`). That's intentional and harmless — the
    // pure step() short-circuits on dead and onGameOver fires exactly
    // once behind the guard above. Don't "fix" this by making `ended` state.
  }, paused);

  return (
    <canvas
      ref={canvasRef}
      width={WORLD.w}
      height={WORLD.h}
      className="rounded-sm border border-helios-line bg-helios-panel"
    />
  );
}

function draw(canvas: HTMLCanvasElement | null, s: FlappyState) {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;

  // Background
  ctx.fillStyle = "#16171B"; // helios-panel
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);

  // Pipes
  ctx.fillStyle = "#2A2C32"; // helios-line
  for (const p of s.pipes) {
    const gapTop = p.gapY - GAP_H / 2;
    const gapBottom = p.gapY + GAP_H / 2;
    // Top pipe
    ctx.fillRect(p.x, 0, PIPE_W, gapTop);
    // Bottom pipe
    ctx.fillRect(p.x, gapBottom, PIPE_W, WORLD.h - gapBottom);
  }

  // Bird
  ctx.fillStyle = "#FFC627"; // asu-gold
  ctx.beginPath();
  ctx.arc(BIRD_X, s.y, BIRD_R, 0, Math.PI * 2);
  ctx.fill();

  // Score (centered top)
  ctx.fillStyle = "#D8DCE2"; // helios-text
  ctx.font = "20px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(String(s.score), WORLD.w / 2, 32);
  ctx.textAlign = "left";

  // Pre-start message
  if (!s.started) {
    ctx.fillStyle = "#9097A0"; // helios-dim
    ctx.font = "16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Press Space to start", WORLD.w / 2, WORLD.h / 2);
    ctx.textAlign = "left";
  }
}
