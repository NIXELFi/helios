import { describe, expect, it } from "vitest";
import {
  COLS, KINDS, ROWS, bag, cellsOf, collides, createInitialState, dropY, emptyBoard, gravityInterval, step,
  type Kind, type TetrisState,
} from "../games/tetris/logic";

const rng0 = () => 0;

function withPiece(s: TetrisState, kind: Kind): TetrisState {
  return { ...s, piece: { kind, rot: 0, x: 3, y: kind === "I" ? -1 : 0 } };
}

describe("tetris", () => {
  it("a bag holds each of the seven pieces exactly once", () => {
    expect([...bag(Math.random)].sort()).toEqual([...KINDS].sort());
  });

  it("spawns inside the well without colliding", () => {
    for (const k of KINDS) {
      const s = withPiece(createInitialState(rng0), k);
      expect(collides(s.board, s.piece)).toBe(false);
      for (const [x, y] of cellsOf(s.piece)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(COLS);
        expect(y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("moves left and stops at the wall", () => {
    let s = withPiece(createInitialState(rng0), "O");
    for (let i = 0; i < 20; i++) s = step(s, "left", rng0);
    expect(Math.min(...cellsOf(s.piece).map(([x]) => x))).toBe(0);
  });

  it("every rotation keeps four cells and four rotations return to start", () => {
    for (const k of KINDS) {
      let s = withPiece(createInitialState(rng0), k);
      s = { ...s, piece: { ...s.piece, y: 5 } };
      const start = cellsOf(s.piece);
      for (let i = 0; i < 4; i++) {
        s = step(s, "rotateCw", rng0);
        expect(new Set(cellsOf(s.piece).map(String)).size).toBe(4);
      }
      expect(cellsOf(s.piece)).toEqual(start);
    }
  });

  it("hard drop lands on the floor and spawns the next piece", () => {
    const s0 = withPiece(createInitialState(rng0), "O");
    const s1 = step(s0, "drop", rng0);
    expect(s1.board[ROWS - 1]!.filter((c) => c !== 0).length).toBe(2);
    expect(s1.board[ROWS - 2]!.filter((c) => c !== 0).length).toBe(2);
    expect(s1.piece.kind).toBe(s0.queue[0]);
  });

  it("clears a full line and scores 100 × level", () => {
    const s0 = withPiece(createInitialState(rng0), "I");
    const board = emptyBoard();
    for (let x = 0; x < COLS; x++) if (x < 3 || x > 6) board[ROWS - 1]![x] = 1;
    const s1 = step({ ...s0, board, level: 2 }, "drop", rng0);
    expect(s1.lines).toBe(1);
    expect(s1.score).toBe(200);
    expect(s1.board[ROWS - 1]!.every((c) => c === 0)).toBe(true);
  });

  it("a four-line clear scores 800 and every score is a multiple of 100", () => {
    let s = withPiece(createInitialState(rng0), "I");
    const board = emptyBoard();
    for (let y = ROWS - 4; y < ROWS; y++) for (let x = 1; x < COLS; x++) board[y]![x] = 1;
    s = { ...s, board, piece: { kind: "I", rot: 1, x: -2, y: 5 } }; // vertical I in column 0
    expect(collides(s.board, s.piece)).toBe(false);
    s = step(s, "drop", rng0);
    expect(s.lines).toBe(4);
    expect(s.score).toBe(800);
    expect(s.score % 100).toBe(0);
  });

  it("levels up every ten lines and gravity speeds up", () => {
    let s = withPiece(createInitialState(rng0), "I");
    const board = emptyBoard();
    for (let x = 0; x < COLS; x++) if (x < 3 || x > 6) board[ROWS - 1]![x] = 1;
    s = step({ ...s, board, lines: 9 }, "drop", rng0);
    expect(s.level).toBe(2);
    expect(gravityInterval(2)).toBeLessThan(gravityInterval(1));
    expect(gravityInterval(99)).toBe(0.05);
  });

  it("hold swaps once per piece", () => {
    const s0 = withPiece(createInitialState(rng0), "T");
    const s1 = step(s0, "hold", rng0);
    expect(s1.hold).toBe("T");
    expect(s1.canHold).toBe(false);
    expect(step(s1, "hold", rng0)).toBe(s1);
  });

  it("tops out when the spawn area is blocked", () => {
    // Stack reaches row 2 (column 0 left open so nothing clears); an O locked
    // at the spawn rows then blocks whatever spawns next.
    const s0 = withPiece(createInitialState(rng0), "O");
    const board = emptyBoard();
    for (let y = 2; y < ROWS; y++) for (let x = 1; x < COLS; x++) board[y]![x] = 1;
    const s1 = step({ ...s0, board }, "drop", rng0);
    expect(s1.gameOver).toBe(true);
    expect(step(s1, "left", rng0)).toBe(s1);
  });

  it("the ghost row is where a hard drop lands", () => {
    const s = withPiece(createInitialState(rng0), "T");
    expect(dropY(s)).toBe(ROWS - 2);
  });
});
