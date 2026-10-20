import { useEffect, useRef } from "react";
import { tcDark, tcaDark } from "@helios/ui";
import { useGameLoop } from "../../lib/useGameLoop";
import type { GameProps } from "../types";
import {
  COLS, ROWS, KINDS, cellsOf, collides, createInitialState, dropY, gravityInterval, step,
  type Action, type Kind, type TetrisState,
} from "./logic";

const CELL = 24; // 240×480 well
const WELL_W = COLS * CELL;
const WELL_H = ROWS * CELL;
const SIDE = 120; // next / hold / score panel
const GAP = 12;
const W = WELL_W + GAP + SIDE;
const H = WELL_H;

/** A grounded piece gets this long to slide/rotate before gravity locks it. */
const LOCK_DELAY_S = 0.5;
/** Held-key auto-repeat: initial delay, then one move per interval. */
const DAS_S = 0.16;
const ARR_S = 0.045;
const SOFT_S = 0.035;

const KEY_ACTION: Record<string, Action> = {
  ArrowLeft: "left", a: "left",
  ArrowRight: "right", d: "right",
  ArrowDown: "down", s: "down",
  ArrowUp: "rotateCw", x: "rotateCw", w: "rotateCw",
  z: "rotateCcw",
  " ": "drop",
  c: "hold", Shift: "hold",
};
const REPEATS: ReadonlySet<Action> = new Set<Action>(["left", "right", "down"]);

const COLORS: Record<Kind, string> = {
  I: "#4FD1E8", O: "#FFC627", T: "#B07CF0", S: "#5BD08A", Z: "#F0605D", J: "#5B8CF0", L: "#F59E3B",
};

export function TetrisGame({ onGameOver, paused }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef<TetrisState>(createInitialState(Math.random));
  const pending = useRef<Action[]>([]);
  /** Held repeatable keys → seconds held (drives DAS/ARR). */
  const held = useRef<Map<Action, number>>(new Map());
  const gravity = useRef(0);
  const lockTimer = useRef(0);
  const ended = useRef(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (paused) return;
      const action = KEY_ACTION[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (!action) return;
      e.preventDefault();
      if (e.repeat) return; // our own auto-repeat, not the OS's
      pending.current.push(action);
      if (REPEATS.has(action)) held.current.set(action, 0);
    }
    function onKeyUp(e: KeyboardEvent) {
      const action = KEY_ACTION[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (action) held.current.delete(action);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      held.current.clear();
    };
  }, [paused]);

  useGameLoop((dt) => {
    let s = state.current;

    // Auto-repeat for held left/right/down.
    for (const [action, t] of held.current) {
      const every = action === "down" ? SOFT_S : ARR_S;
      const delay = action === "down" ? 0 : DAS_S;
      const before = Math.max(0, t - delay);
      const after = Math.max(0, t + dt - delay);
      const n = Math.floor(after / every) - Math.floor(before / every);
      for (let i = 0; i < n; i++) pending.current.push(action);
      held.current.set(action, t + dt);
    }

    for (const action of pending.current) {
      const before = s.piece;
      s = step(s, action, Math.random);
      if (action === "down" && s.piece !== before) gravity.current = 0;
      // Moving or rotating a grounded piece resets its lock delay.
      if (s.piece !== before) lockTimer.current = 0;
    }
    pending.current = [];

    // Gravity, with a lock delay once the piece is resting on something.
    const grounded = !s.gameOver && collides(s.board, { ...s.piece, y: s.piece.y + 1 });
    if (grounded) {
      lockTimer.current += dt;
      if (lockTimer.current >= LOCK_DELAY_S) {
        s = step(s, "tick", Math.random);
        lockTimer.current = 0;
        gravity.current = 0;
      }
    } else {
      lockTimer.current = 0;
      gravity.current += dt;
      const every = gravityInterval(s.level);
      while (gravity.current >= every && !s.gameOver) {
        gravity.current -= every;
        if (collides(s.board, { ...s.piece, y: s.piece.y + 1 })) break;
        s = step(s, "tick", Math.random);
      }
    }

    state.current = s;
    draw(canvasRef.current, s);
    if (s.gameOver && !ended.current) {
      ended.current = true;
      onGameOver(s.score);
    }
    // Same as the other cabinets: `ended` is a ref and the loop keeps running
    // after game over; step() short-circuits and onGameOver fires once.
  }, paused);

  return (
    <div className="games-crt">
      <canvas ref={canvasRef} width={W} height={H} role="img" aria-label="Tetris game" />
    </div>
  );
}

function block(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
  // Bevel: light top edge, dark bottom edge.
  ctx.fillStyle = "rgba(255,255,255,0.28)";
  ctx.fillRect(x + 1, y + 1, size - 2, 3);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(x + 1, y + size - 4, size - 2, 3);
  ctx.globalAlpha = 1;
}

/** A small preview of `kind`, centred in a SIDE-wide box at (x, y). */
function preview(ctx: CanvasRenderingContext2D, kind: Kind | null, x: number, y: number, dim = false) {
  ctx.fillStyle = tcDark("deep");
  ctx.fillRect(x, y, SIDE, 64);
  ctx.strokeStyle = "#1A1B20";
  ctx.strokeRect(x + 0.5, y + 0.5, SIDE - 1, 64 - 1);
  if (!kind) return;
  const cells = cellsOf({ kind, rot: 0, x: 0, y: 0 });
  const size = 18;
  const xs = cells.map(([cx]) => cx);
  const ys = cells.map(([, cy]) => cy);
  const w = (Math.max(...xs) - Math.min(...xs) + 1) * size;
  const h = (Math.max(...ys) - Math.min(...ys) + 1) * size;
  const ox = x + (SIDE - w) / 2 - Math.min(...xs) * size;
  const oy = y + (64 - h) / 2 - Math.min(...ys) * size;
  for (const [cx, cy] of cells) block(ctx, ox + cx * size, oy + cy * size, size, COLORS[kind], dim ? 0.35 : 1);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.font = "700 9px Orbitron, sans-serif";
  ctx.fillStyle = tcDark("dim");
  ctx.fillText(text, x, y);
}

function stat(ctx: CanvasRenderingContext2D, name: string, value: number, x: number, y: number) {
  label(ctx, name, x, y);
  ctx.font = "700 18px Orbitron, sans-serif";
  ctx.fillStyle = tcDark("text");
  ctx.fillText(String(value), x, y + 20);
}

function draw(canvas: HTMLCanvasElement | null, s: TetrisState) {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = tcDark("deep");
  ctx.fillRect(0, 0, WELL_W, WELL_H);

  // Faint grid.
  ctx.strokeStyle = "#1A1B20";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < COLS; i++) { const p = i * CELL + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, WELL_H); }
  for (let i = 1; i < ROWS; i++) { const p = i * CELL + 0.5; ctx.moveTo(0, p); ctx.lineTo(WELL_W, p); }
  ctx.stroke();

  // Locked cells.
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const v = s.board[y]![x]!;
      if (v) block(ctx, x * CELL, y * CELL, CELL, COLORS[KINDS[v - 1]!]);
    }
  }

  if (!s.gameOver) {
    // Ghost, then the live piece.
    const ghost = { ...s.piece, y: dropY(s) };
    for (const [x, y] of cellsOf(ghost)) if (y >= 0) block(ctx, x * CELL, y * CELL, CELL, COLORS[s.piece.kind], 0.18);
    for (const [x, y] of cellsOf(s.piece)) if (y >= 0) block(ctx, x * CELL, y * CELL, CELL, COLORS[s.piece.kind]);
  }

  // Side panel.
  const sx = WELL_W + GAP;
  ctx.textBaseline = "alphabetic";
  label(ctx, "NEXT", sx, 10);
  preview(ctx, s.queue[0] ?? null, sx, 16);
  label(ctx, "HOLD", sx, 100);
  preview(ctx, s.hold, sx, 106, !s.canHold);
  stat(ctx, "SCORE", s.score, sx, 196);
  stat(ctx, "LINES", s.lines, sx, 244);
  stat(ctx, "LEVEL", s.level, sx, 292);

  ctx.font = "500 10px Inter Variable, sans-serif";
  ctx.fillStyle = tcDark("dim");
  const help = ["← → move", "↓ soft drop", "↑ / X rotate", "Z rotate back", "Space drop", "C hold"];
  help.forEach((line, i) => ctx.fillText(line, sx, 360 + i * 16));

  if (s.gameOver) {
    ctx.fillStyle = tcaDark("base", 0.55);
    ctx.fillRect(0, 0, W, H);
  }
}
