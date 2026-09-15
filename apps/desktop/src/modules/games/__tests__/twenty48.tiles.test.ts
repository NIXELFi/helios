import { describe, expect, it } from "vitest";
import {
  move,
  moveTiles,
  spawnTile,
  tilesToBoard,
  type Board,
  type Dir,
  type Tile,
} from "../games/twenty48/logic";

// Assigns sequential ids to non-zero cells, in board order, so results are
// deterministic and easy to reason about across a test.
function boardToTiles(board: Board): Tile[] {
  const tiles: Tile[] = [];
  let id = 1;
  board.forEach((v, i) => {
    if (v !== 0) tiles.push({ id: id++, value: v, row: Math.floor(i / 4), col: i % 4 });
  });
  return tiles;
}

const BOARDS: Board[] = [
  [2, 2, 0, 0, 4, 0, 4, 0, 0, 0, 0, 2, 0, 0, 0, 0],
  [2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0],
  [4, 4, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 4, 0, 0, 0],
];
const DIRS: Dir[] = ["left", "right", "up", "down"];

describe("moveTiles vs move", () => {
  for (const board of BOARDS) {
    for (const dir of DIRS) {
      it(`matches move() board result for ${JSON.stringify(board)} / ${dir}`, () => {
        const expected = move(board, dir);
        const result = moveTiles(boardToTiles(board), dir, 1000);
        expect(tilesToBoard(result.tiles)).toEqual(expected.board);
        expect(result.gained).toBe(expected.gained);
        expect(result.moved).toBe(expected.moved);
      });
    }
  }
});

describe("moveTiles identity", () => {
  it("keeps tile ids stable across a non-merging slide", () => {
    // Two tiles of different value in a row: slides but never merges.
    const tiles: Tile[] = [
      { id: 7, value: 2, row: 0, col: 1 },
      { id: 9, value: 4, row: 0, col: 3 },
    ];
    const result = moveTiles(tiles, "left", 100);
    expect(result.moved).toBe(true);
    expect(result.merged).toEqual([]);
    const ids = result.tiles.map((t) => t.id).sort();
    expect(ids).toEqual([7, 9]);
    const byId = new Map(result.tiles.map((t) => [t.id, t]));
    expect(byId.get(7)).toMatchObject({ value: 2, row: 0, col: 0 });
    expect(byId.get(9)).toMatchObject({ value: 4, row: 0, col: 1 });
  });

  it("reports merges and keeps the front tile's id as the survivor", () => {
    const tiles: Tile[] = [
      { id: 1, value: 2, row: 0, col: 0 },
      { id: 2, value: 2, row: 0, col: 1 },
      { id: 3, value: 4, row: 0, col: 2 },
    ];
    const result = moveTiles(tiles, "left", 100);
    expect(result.merged).toEqual([1]);
    expect(result.gained).toBe(4);
    // Absorbed tile (id 2) is gone; survivor keeps id 1 with doubled value.
    expect(result.tiles.find((t) => t.id === 2)).toBeUndefined();
    const survivor = result.tiles.find((t) => t.id === 1);
    expect(survivor).toMatchObject({ value: 4, row: 0, col: 0 });
    // nextId is untouched: merges reuse an existing id, they don't mint one.
    expect(result.nextId).toBe(100);
  });

  it("does not double-merge a run of four equal tiles", () => {
    const tiles: Tile[] = [
      { id: 1, value: 2, row: 0, col: 0 },
      { id: 2, value: 2, row: 0, col: 1 },
      { id: 3, value: 2, row: 0, col: 2 },
      { id: 4, value: 2, row: 0, col: 3 },
    ];
    const result = moveTiles(tiles, "left", 100);
    expect(result.merged.sort()).toEqual([1, 3]);
    expect(tilesToBoard(result.tiles).slice(0, 4)).toEqual([4, 4, 0, 0]);
    expect(result.gained).toBe(8);
  });
});

describe("spawnTile", () => {
  it("mirrors addRandomTile: fills a free cell with 2 when rng < 0.9", () => {
    const rng = () => 0;
    const result = spawnTile([], rng, 1);
    expect(result.tiles).toHaveLength(1);
    expect(result.tiles[0]).toMatchObject({ id: 1, value: 2, row: 0, col: 0 });
    expect(result.nextId).toBe(2);
  });

  it("places a 4-tile when the value roll is >= 0.9", () => {
    let call = 0;
    const result = spawnTile([], () => (call++ === 0 ? 0 : 0.95), 1);
    expect(result.tiles[0]).toMatchObject({ value: 4 });
  });

  it("is a no-op when the board is full", () => {
    const full = boardToTiles(Array(16).fill(2));
    const result = spawnTile(full, () => 0, 999);
    expect(result.tiles).toBe(full);
    expect(result.nextId).toBe(999);
  });
});
