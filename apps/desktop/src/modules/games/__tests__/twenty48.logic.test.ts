import { describe, expect, it } from "vitest";
import { addRandomTile, canMove, createInitialBoard, move, slideRow } from "../games/twenty48/logic";

describe("slideRow", () => {
  it("slides tiles toward the front", () => {
    expect(slideRow([0, 2, 0, 4])).toEqual({ row: [2, 4, 0, 0], gained: 0 });
  });
  it("merges equal neighbors once", () => {
    expect(slideRow([2, 2, 4, 0])).toEqual({ row: [4, 4, 0, 0], gained: 4 });
  });
  it("does not double-merge", () => {
    expect(slideRow([2, 2, 2, 2])).toEqual({ row: [4, 4, 0, 0], gained: 8 });
    expect(slideRow([4, 2, 2, 0])).toEqual({ row: [4, 4, 0, 0], gained: 4 });
  });
});

describe("move", () => {
  // board is 16 cells row-major
  it("moves left across all rows and reports gained", () => {
    const board = [
      2, 2, 0, 0,
      4, 0, 4, 0,
      0, 0, 0, 2,
      0, 0, 0, 0,
    ];
    const r = move(board, "left");
    expect(r.board).toEqual([
      4, 0, 0, 0,
      8, 0, 0, 0,
      2, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(r.gained).toBe(12);
    expect(r.moved).toBe(true);
  });
  it("moves up along columns", () => {
    const board = [
      2, 0, 0, 0,
      2, 0, 0, 0,
      0, 0, 0, 0,
      4, 0, 0, 0,
    ];
    const r = move(board, "up");
    expect(r.board[0]).toBe(4);
    expect(r.board[4]).toBe(4);
    expect(r.gained).toBe(4);
  });
  it("flags moved=false when nothing changes", () => {
    const board = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(move(board, "left").moved).toBe(false);
  });
});

describe("board lifecycle", () => {
  it("addRandomTile fills a free cell with 2 (rng<0.9) deterministically", () => {
    const rng = () => 0;
    const board = addRandomTile(Array(16).fill(0), rng);
    expect(board[0]).toBe(2);
    expect(board.filter((v) => v !== 0)).toHaveLength(1);
  });
  it("createInitialBoard seeds two tiles", () => {
    const seq = [0.1, 0.5, 0.2, 0.95]; // positions + values
    let i = 0;
    const board = createInitialBoard(() => seq[i++ % seq.length]!);
    expect(board.filter((v) => v !== 0)).toHaveLength(2);
  });
  it("canMove detects merges on a full board", () => {
    const stuck = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
    expect(canMove(stuck)).toBe(false);
    const mergeable = stuck.slice();
    mergeable[1] = 2; // two 2s adjacent
    expect(canMove(mergeable)).toBe(true);
  });
});
