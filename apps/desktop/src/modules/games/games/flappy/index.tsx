import { useEffect, useRef } from "react";
import { useGameLoop } from "../../lib/useGameLoop";
import type { GameProps } from "../types";
import {
  WORLD, BIRD_X, BIRD_R, PIPE_W, GAP_H, PIPE_SPEED,
  createInitialState, step, type FlappyState,
} from "./logic";

// Two starfield layers, precomputed once (deterministic, no per-frame alloc).
// Positions are pseudo-random from index math so there's no Math.random churn.
interface Star { x: number; y: number; r: number }
function makeStars(count: number, seed: number): Star[] {
  const out: Star[] = [];
  for (let i = 0; i < count; i++) {
    const a = ((i + seed) * 2654435761) >>> 0;
    const b = ((i * 40503 + seed * 12289) * 2246822519) >>> 0;
    out.push({
      x: (a % WORLD.w),
      y: (b % WORLD.h),
      r: 0.6 + ((a >>> 8) % 100) / 140, // ~0.6 .. 1.3px
    });
  }
  return out;
}
const STARS_FAR = makeStars(24, 7);
const STARS_NEAR = makeStars(16, 53);

// Mutable per-instance render scratch (no per-frame allocation churn).
interface DrawScratch {
  t: number;        // accumulated time (s)
  scroll: number;   // world scroll offset (px), advances with dt
  trail: number[];  // recent bird y positions
}

export function FlappyGame({ onGameOver, paused }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef<FlappyState>(createInitialState());
  const flapQueued = useRef(false);
  const ended = useRef(false);
  const scratch = useRef<DrawScratch>({ t: 0, scroll: 0, trail: [] });

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

    // Advance render-only clocks. The world scroll mirrors pipe motion so the
    // starfield/ground hazard stay coherent with gameplay, but only once the
    // run has actually started.
    const sc = scratch.current;
    sc.t += dt;
    if (state.current.started && !state.current.dead) {
      sc.scroll += PIPE_SPEED * dt;
      sc.trail.push(state.current.y);
      if (sc.trail.length > 5) sc.trail.shift();
    }

    draw(canvasRef.current, state.current, sc);
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
    <div className="games-crt">
      <canvas
        ref={canvasRef}
        width={WORLD.w}
        height={WORLD.h}
        className="block rounded-sm"
        role="img"
        aria-label="Flappy game"
      />
    </div>
  );
}

function draw(canvas: HTMLCanvasElement | null, s: FlappyState, sc: DrawScratch) {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;

  // --- Background: vertical gradient void -----------------------------------
  const grad = ctx.createLinearGradient(0, 0, 0, WORLD.h);
  grad.addColorStop(0, "#0c0d10");
  grad.addColorStop(1, "#14151a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);

  // --- Parallax starfield (2 layers) ----------------------------------------
  // Scroll left at fractions of PIPE_SPEED, wrapped horizontally with modulo.
  ctx.fillStyle = "rgba(216,220,226,0.18)";
  for (const st of STARS_FAR) {
    const x = mod(st.x - sc.scroll * 0.15, WORLD.w);
    ctx.beginPath();
    ctx.arc(x, st.y, st.r * 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(216,220,226,0.32)";
  for (const st of STARS_NEAR) {
    const x = mod(st.x - sc.scroll * 0.35, WORLD.w);
    ctx.beginPath();
    ctx.arc(x, st.y, st.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Pipes: dark metal with a gold-tinted gap lip -------------------------
  const LIP = 6;
  for (const p of s.pipes) {
    const gapTop = p.gapY - GAP_H / 2;
    const gapBottom = p.gapY + GAP_H / 2;

    // Top pipe body
    ctx.fillStyle = "#1d1f25";
    ctx.fillRect(p.x, 0, PIPE_W, gapTop);
    // Bottom pipe body
    ctx.fillRect(p.x, gapBottom, PIPE_W, WORLD.h - gapBottom);

    // 1px edges
    ctx.strokeStyle = "#2A2C32";
    ctx.lineWidth = 1;
    ctx.strokeRect(p.x + 0.5, 0.5, PIPE_W - 1, gapTop - 1);
    ctx.strokeRect(p.x + 0.5, gapBottom + 0.5, PIPE_W - 1, WORLD.h - gapBottom - 1);

    // Gold-tinted lips at the gap-facing ends
    ctx.fillStyle = "rgba(255,198,39,0.5)";
    ctx.fillRect(p.x, gapTop - LIP, PIPE_W, LIP);
    ctx.fillRect(p.x, gapBottom, PIPE_W, LIP);
  }

  // --- Bird trail (motion ghost) --------------------------------------------
  const n = sc.trail.length;
  for (let i = 0; i < n; i++) {
    const ty = sc.trail[i]!;
    const alpha = 0.04 + (i / n) * 0.12; // older = fainter
    ctx.fillStyle = `rgba(255,198,39,${alpha})`;
    ctx.beginPath();
    ctx.arc(BIRD_X - (n - i) * 4, ty, BIRD_R * 0.85, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Bird: gold body + flapping wing + eye ---------------------------------
  ctx.save();
  ctx.shadowColor = "rgba(255,198,39,0.45)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#FFC627";
  ctx.beginPath();
  ctx.arc(BIRD_X, s.y, BIRD_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Wing wedge — flaps via sin of clock, biased by vertical velocity.
  const flap = Math.sin(sc.t * 14) * 0.5 + (s.vy < 0 ? -0.4 : 0.2);
  ctx.fillStyle = "#d89e10";
  ctx.beginPath();
  ctx.moveTo(BIRD_X - 2, s.y);
  ctx.lineTo(BIRD_X - BIRD_R - 4, s.y + flap * 8 - 4);
  ctx.lineTo(BIRD_X - BIRD_R - 4, s.y + flap * 8 + 4);
  ctx.closePath();
  ctx.fill();

  // Eye
  ctx.fillStyle = "#16171B";
  ctx.beginPath();
  ctx.arc(BIRD_X + BIRD_R * 0.35, s.y - BIRD_R * 0.3, 1.8, 0, Math.PI * 2);
  ctx.fill();

  // --- Ground hazard stripe band --------------------------------------------
  const BAND = 4;
  const bandY = WORLD.h - BAND;
  ctx.fillStyle = "#0a0b0d";
  ctx.fillRect(0, bandY, WORLD.w, BAND);
  const sw = 8; // stripe pitch
  const off = mod(sc.scroll, sw * 2);
  ctx.fillStyle = "rgba(255,198,39,0.55)";
  for (let x = -off - sw * 2; x < WORLD.w + sw * 2; x += sw * 2) {
    ctx.beginPath();
    ctx.moveTo(x, WORLD.h);
    ctx.lineTo(x + sw, WORLD.h);
    ctx.lineTo(x + sw + BAND, bandY);
    ctx.lineTo(x + BAND, bandY);
    ctx.closePath();
    ctx.fill();
  }

  // --- HUD: score -----------------------------------------------------------
  ctx.save();
  ctx.shadowColor = "rgba(255,198,39,0.4)";
  ctx.shadowBlur = 8;
  ctx.fillStyle = "#FFC627";
  ctx.font = "900 28px Orbitron, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(String(s.score), WORLD.w / 2, 44);
  ctx.restore();
  ctx.textAlign = "left";

  // --- Pre-start hint: pulsing "PRESS SPACE" --------------------------------
  if (!s.started) {
    const pulse = 0.45 + 0.4 * (Math.sin(sc.t * 3.2) * 0.5 + 0.5);
    ctx.fillStyle = `rgba(144,151,160,${pulse})`;
    ctx.font = "700 14px Orbitron, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("PRESS SPACE", WORLD.w / 2, WORLD.h / 2);
    ctx.textAlign = "left";
  }

  // --- Dead: dim overlay ----------------------------------------------------
  if (s.dead) {
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  }
}

function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}
