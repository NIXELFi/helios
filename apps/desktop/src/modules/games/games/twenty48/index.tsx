import { useEffect, useRef, useState } from "react";
import type { GameProps } from "../types";
import { canMove, moveTiles, spawnTile, tilesToBoard, type Dir, type Tile } from "./logic";

// Cell + gap sizes match the Tailwind classes on each tile (h-16/w-16 = 64px,
// gap-2 = 8px). Tile position is computed from these rather than CSS grid so
// a moving tile can transition its own transform instead of being redrawn.
const CELL = 64;
const GAP = 8;
const STEP = CELL + GAP;
const BOARD_PX = CELL * 4 + GAP * 3;

interface GameState {
  tiles: Tile[];
  nextId: number;
  score: number;
  over: boolean;
  // Ids to animate THIS render only: a spawned tile pops in, a merged tile
  // bumps. Replaced wholesale on every move so the classes correctly toggle
  // off between moves (needed for the animation to re-trigger on reuse).
  spawnedIds: Set<number>;
  mergedIds: Set<number>;
  /** Increments per move. Merged tiles key their inner node on it so the
   *  bump keyframe restarts even when the same survivor merges on
   *  consecutive moves (a stable className would never re-trigger). */
  moveSeq: number;
}

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

// Deliberate 11-step tile ramp (2 → 2048+). Greys warm to bronze, then amber,
// then full glowing gold; values beyond 2048 fall into the maroon "beyond" tier.
const TILE_STYLES: Record<number, string> = {
  2: "bg-helios-panel text-helios-dim",
  4: "bg-[#1e1f24] text-helios-text",
  8: "bg-[#2a2718] text-[#e6c97a]",
  16: "bg-[#3a3422] text-[#f0d488]",
  32: "bg-[#4d3d1c] text-[#ffd766]",
  64: "bg-[#6b4f1a] text-[#ffdf7a]",
  128: "bg-[#9c7415] text-helios-base",
  256: "bg-[#c79412] text-helios-base",
  512: "bg-[#e2ad11] text-helios-base",
  1024: "bg-asu-gold text-helios-base shadow-[0_0_18px_rgba(255,198,39,0.45)]",
  2048: "bg-asu-gold text-helios-base shadow-[0_0_18px_rgba(255,198,39,0.45)]",
};
const TILE_BEYOND = "bg-asu-maroon text-asu-gold shadow-[0_0_18px_rgba(140,29,64,0.55)]";

function tileClass(v: number): string {
  if (v > 2048) return TILE_BEYOND;
  return TILE_STYLES[v] ?? "bg-helios-panel text-helios-text";
}

// 4-digit values (1024+) use smaller type so they never overflow the cell.
function tileTextSize(v: number): string {
  if (v >= 1024) return "text-base";
  if (v >= 128) return "text-lg";
  return "text-xl";
}

// Seeds the two starting tiles the same way createInitialBoard() does (two
// spawnTile calls), just against the identity-aware tile list instead of a
// plain Board.
function createInitialTiles(rng: () => number): { tiles: Tile[]; nextId: number } {
  const first = spawnTile([], rng, 1);
  const second = spawnTile(first.tiles, rng, first.nextId);
  return { tiles: second.tiles, nextId: second.nextId };
}

export function Twenty48Game({ onGameOver, paused }: GameProps) {
  const [game, setGame] = useState<GameState>(() => {
    const { tiles, nextId } = createInitialTiles(Math.random);
    return {
      tiles,
      nextId,
      score: 0,
      over: false,
      spawnedIds: new Set(tiles.map((t) => t.id)),
      mergedIds: new Set(),
      moveSeq: 0,
    };
  });
  const ended = useRef(false);
  // Mirror game state into a ref so the keydown handler can read the latest
  // board/score/over without being re-registered on every move. Previously
  // `game` was a dep, which tore down and re-added the window listener after
  // every arrow key press (listener churn). With the ref the handler closure
  // is stable; deps reduce to [paused, onGameOver].
  const gameRef = useRef(game);
  gameRef.current = game;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const dir = KEY_DIR[e.key];
      if (!dir || paused || gameRef.current.over) return;
      e.preventDefault();

      const result = moveTiles(gameRef.current.tiles, dir, gameRef.current.nextId);
      if (!result.moved) return;

      const spawn = spawnTile(result.tiles, Math.random, result.nextId);
      const spawnedId =
        spawn.tiles.length > result.tiles.length
          ? spawn.tiles[spawn.tiles.length - 1]!.id
          : undefined;
      const newScore = gameRef.current.score + result.gained;
      const over = !canMove(tilesToBoard(spawn.tiles));

      if (over && !ended.current) {
        ended.current = true;
        onGameOver(newScore);
      }

      setGame({
        tiles: spawn.tiles,
        nextId: spawn.nextId,
        score: newScore,
        over,
        spawnedIds: spawnedId === undefined ? new Set() : new Set([spawnedId]),
        mergedIds: new Set(result.merged),
        moveSeq: gameRef.current.moveSeq + 1,
      });
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paused, onGameOver]);

  return (
    <div className="games-crt">
      <div className="flex flex-col items-stretch gap-3">
        {/* Score line — micro-label + tabular value, right-aligned over grid */}
        <div className="flex items-baseline justify-end gap-2 px-1">
          <span className="games-display text-[10px] text-helios-dim">SCORE</span>
          <span className="games-num text-lg font-bold text-asu-gold">{game.score}</span>
        </div>

        <div
          role="grid"
          aria-label="2048 board"
          className={`relative rounded-sm transition-opacity duration-300 ${
            game.over ? "opacity-40" : "opacity-100"
          }`}
          style={{ width: BOARD_PX, height: BOARD_PX }}
        >
          {/* Fixed background grid of empty cells - tiles float on top of it,
              so a cell's own box never remounts as tiles slide across it. */}
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 16 }, (_, i) => (
              <div key={i} className="h-16 w-16 rounded-sm bg-helios-base shadow-inner" />
            ))}
          </div>

          <div className="absolute inset-0">
            {game.tiles.map((tile) => (
              // Keyed by stable id (not position) so a sliding tile keeps its
              // DOM node and .games-slide transitions its transform instead
              // of popping in a new element at the destination.
              <div
                key={tile.id}
                className="games-slide absolute left-0 top-0 h-16 w-16"
                style={{ transform: `translate(${tile.col * STEP}px, ${tile.row * STEP}px)` }}
              >
                <div
                  key={game.mergedIds.has(tile.id) ? `m${game.moveSeq}` : "t"}
                  className={`flex h-16 w-16 items-center justify-center rounded-sm font-bold ${tileTextSize(
                    tile.value,
                  )} ${tileClass(tile.value)} ${
                    game.spawnedIds.has(tile.id) ? "games-pop" : ""
                  } ${game.mergedIds.has(tile.id) ? "games-merge" : ""}`}
                >
                  {tile.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
