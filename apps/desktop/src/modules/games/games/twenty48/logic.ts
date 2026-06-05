// Pure 2048 core: 16-cell row-major board, 0 = empty. The component owns
// score accumulation (sum of `gained`) and tile spawning after a real move.

export type Board = number[]; // length 16
export type Dir = "up" | "down" | "left" | "right";
export type Rng = () => number;

export function addRandomTile(board: Board, rng: Rng): Board {
  const free = board.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  if (free.length === 0) return board;
  const next = board.slice();
  // free is derived from board indices, always within [0,15] — safe to assert
  next[free[Math.floor(rng() * free.length)]!] = rng() < 0.9 ? 2 : 4;
  return next;
}

export function createInitialBoard(rng: Rng): Board {
  return addRandomTile(addRandomTile(Array(16).fill(0), rng), rng);
}

// Slide + merge one 4-cell line toward index 0. Standard 2048 rule: each tile
// merges at most once per move.
export function slideRow(row: number[]): { row: number[]; gained: number } {
  const vals = row.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
      // i and i+1 are provably within vals bounds (loop guard + explicit check)
      out.push(vals[i]! * 2);
      gained += vals[i]! * 2;
      i++;
    } else {
      out.push(vals[i]!); // i is within vals bounds (loop guard)
    }
  }
  while (out.length < 4) out.push(0);
  return { row: out, gained };
}

export function move(board: Board, dir: Dir): { board: Board; gained: number; moved: boolean } {
  const next = board.slice();
  let gained = 0;
  let moved = false;
  for (let i = 0; i < 4; i++) {
    // Cell indices of line i, ordered from the edge tiles slide toward.
    const idx: number[] = [];
    for (let j = 0; j < 4; j++) {
      if (dir === "left") idx.push(i * 4 + j);
      else if (dir === "right") idx.push(i * 4 + (3 - j));
      else if (dir === "up") idx.push(j * 4 + i);
      else idx.push((3 - j) * 4 + i);
    }
    // idx values are board indices [0,15] — safe to assert on board access
    const r = slideRow(idx.map((k) => board[k]!));
    gained += r.gained;
    idx.forEach((k, j) => {
      if (next[k] !== r.row[j]) moved = true;
      next[k] = r.row[j]!; // j is within [0,3], r.row is always length 4
    });
  }
  return { board: next, gained, moved };
}

export function canMove(board: Board): boolean {
  if (board.includes(0)) return true;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const v = board[y * 4 + x]; // y*4+x in [0,15] — provably in range
      if (x < 3 && board[y * 4 + x + 1] === v) return true;
      if (y < 3 && board[(y + 1) * 4 + x] === v) return true;
    }
  }
  return false;
}
