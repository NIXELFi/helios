// Pure snake core. No rendering, no timers — the component drives `step` on a
// fixed tick and draws the returned state. Randomness is injected (rng) so
// tests are deterministic.

export const GRID = 20; // 20×20 cells

export interface Point { x: number; y: number }
export type Dir = "up" | "down" | "left" | "right";
export type Rng = () => number;

export interface SnakeState {
  snake: Point[]; // head first
  dir: Dir;
  food: Point;
  score: number;
  gameOver: boolean;
}

const DELTA: Record<Dir, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

export function placeFood(occupied: Point[], rng: Rng): Point {
  const taken = new Set(occupied.map((p) => p.y * GRID + p.x));
  const free: Point[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!taken.has(y * GRID + x)) free.push({ x, y });
    }
  }
  // free is guaranteed non-empty: step() returns the win branch before calling
  // placeFood when the board is full, so this array is always non-empty here.
  return free[Math.floor(rng() * free.length)]!;
}

export function createInitialState(rng: Rng): SnakeState {
  const snake = [
    { x: 5, y: 10 },
    { x: 4, y: 10 },
    { x: 3, y: 10 },
  ];
  return { snake, dir: "right", food: placeFood(snake, rng), score: 0, gameOver: false };
}

export function step(state: SnakeState, want: Dir | null, rng: Rng): SnakeState {
  if (state.gameOver) return state;
  const dir = want && want !== OPPOSITE[state.dir] ? want : state.dir;
  const head = state.snake[0]!;
  const next = { x: head.x + DELTA[dir].x, y: head.y + DELTA[dir].y };
  if (next.x < 0 || next.y < 0 || next.x >= GRID || next.y >= GRID) {
    return { ...state, dir, gameOver: true };
  }
  const eats = next.x === state.food.x && next.y === state.food.y;
  // Tail cell vacates this tick unless we grow, so moving into it is legal.
  const body = eats ? state.snake : state.snake.slice(0, -1);
  if (body.some((p) => p.x === next.x && p.y === next.y)) {
    return { ...state, dir, gameOver: true };
  }
  const snake = [next, ...body];
  if (!eats) return { ...state, dir, snake };
  if (snake.length === GRID * GRID) {
    // Board full — perfect game. No free cell for food; end the run as a win.
    return { ...state, dir, snake, score: state.score + 1, gameOver: true };
  }
  return { dir, snake, score: state.score + 1, food: placeFood(snake, rng), gameOver: false };
}
