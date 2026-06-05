import {
  IconArrowsMove, IconBallTennis, IconFeather, IconGridDots, type TablerIcon,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { GameId } from "./api";
import type { GameProps } from "./games/types";
import { SnakeGame } from "./games/snake";
import { BreakoutGame } from "./games/breakout";
import { FlappyGame } from "./games/flappy";
import { Twenty48Game } from "./games/twenty48"; // folder is twenty48; id stays '2048'

export interface GameDef {
  id: GameId;
  title: string;
  blurb: string;
  icon: TablerIcon;
  component: ComponentType<GameProps>;
}

export const GAMES: GameDef[] = [
  { id: "snake", title: "Snake", blurb: "Eat. Grow. Don't bite yourself.", icon: IconArrowsMove, component: SnakeGame },
  { id: "breakout", title: "Breakout", blurb: "Clear the wall, level up, speed up.", icon: IconBallTennis, component: BreakoutGame },
  { id: "flappy", title: "Flappy", blurb: "One button. Endless pipes.", icon: IconFeather, component: FlappyGame },
  { id: "2048", title: "2048", blurb: "Merge tiles. Chase the big one.", icon: IconGridDots, component: Twenty48Game },
];
