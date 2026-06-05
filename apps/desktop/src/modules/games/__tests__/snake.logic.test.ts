import { describe, expect, it } from "vitest";
import { GRID, createInitialState, placeFood, step } from "../games/snake/logic";

const rng0 = () => 0; // always picks the first free cell

describe("snake", () => {
  it("moves right by one cell per step", () => {
    const s0 = createInitialState(rng0);
    const s1 = step(s0, null, rng0);
    expect(s1.snake[0]!).toEqual({ x: s0.snake[0]!.x + 1, y: s0.snake[0]!.y });
    expect(s1.snake.length).toBe(s0.snake.length);
  });

  it("ignores reversing into itself", () => {
    const s0 = createInitialState(rng0); // moving right
    const s1 = step(s0, "left", rng0);
    expect(s1.dir).toBe("right");
  });

  it("turns on valid input", () => {
    const s1 = step(createInitialState(rng0), "up", rng0);
    expect(s1.dir).toBe("up");
  });

  it("grows and scores when eating food", () => {
    const s0 = createInitialState(rng0);
    const head = s0.snake[0]!;
    const fed = { ...s0, food: { x: head.x + 1, y: head.y } };
    const s1 = step(fed, null, rng0);
    expect(s1.score).toBe(1);
    expect(s1.snake.length).toBe(s0.snake.length + 1);
    expect(s1.food).not.toEqual(fed.food); // new food placed
  });

  it("dies on wall hit", () => {
    let s = createInitialState(rng0);
    for (let i = 0; i < GRID; i++) s = step(s, null, rng0);
    expect(s.gameOver).toBe(true);
  });

  it("dies on self collision", () => {
    // The first "down" step moves the head into {5,6}, which is already in
    // the body — death on that step. (The follow-up "left" is a no-op.)
    const body = [
      { x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 },
    ];
    const s0 = { snake: body, dir: "right" as const, food: { x: 0, y: 0 }, score: 0, gameOver: false };
    const s1 = step(step(s0, "down", rng0), "left", rng0);
    expect(s1.gameOver).toBe(true);
  });

  it("places food only on free cells", () => {
    const occupied = [{ x: 0, y: 0 }];
    expect(placeFood(occupied, rng0)).toEqual({ x: 1, y: 0 });
  });
});
