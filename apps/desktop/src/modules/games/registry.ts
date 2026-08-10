import {
  IconArrowsMove, IconBallTennis, IconCards, IconFeather, IconGridDots, type TablerIcon,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { GameId } from "./api";
import type { GameProps } from "./games/types";
import { SnakeGame } from "./games/snake";
import { BreakoutGame } from "./games/breakout";
import { FlappyGame } from "./games/flappy";
import { Twenty48Game } from "./games/twenty48"; // folder is twenty48; id stays '2048'
import { BlackjackGame } from "./games/blackjack";

/** Lobby section a game's cabinet lives in. Standings are section-agnostic —
 *  every game shares the one board with its own chip. */
export type GameCategory = "arcade" | "casino";

export interface GameDef {
  id: GameId;
  title: string;
  blurb: string;
  icon: TablerIcon;
  category: GameCategory;
  component: ComponentType<GameProps>;
}

export const GAMES: GameDef[] = [
  { id: "snake", title: "Snake", blurb: "Eat. Grow. Don't bite yourself.", icon: IconArrowsMove, category: "arcade", component: SnakeGame },
  { id: "breakout", title: "Breakout", blurb: "Clear the wall, level up, speed up.", icon: IconBallTennis, category: "arcade", component: BreakoutGame },
  { id: "flappy", title: "Flappy", blurb: "One button. Endless pipes.", icon: IconFeather, category: "arcade", component: FlappyGame },
  { id: "2048", title: "2048", blurb: "Merge tiles. Chase the big one.", icon: IconGridDots, category: "arcade", component: Twenty48Game },
  { id: "blackjack", title: "Blackjack", blurb: "Beat the dealer. Score is your Elo.", icon: IconCards, category: "casino", component: BlackjackGame },
];
