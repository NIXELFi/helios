import { useEffect, useState, useRef } from "react";
import "./games.css";
import { useHeliosAuth } from "../../auth/AuthShell";
import { prefetchBoards } from "./components/standings";
import {
  dropBall, fetchBudget, fetchRating, forfeitOpenBet, isMoney, isRated, placeBet,
  raiseBet, settleBet, submitRatedSession, submitScore,
  type Budget, type DropRequest, type DropResult, type GameId, type PlacedBet,
  type RaisedBet, type Rating, type SettledBet,
} from "./api";
import type { MoneyTable, RatedSession } from "./games/types";
import { GAMES, categoryOf, gamesInCategory, type GameCategory, type GameDef } from "./registry";
import { GameCard } from "./components/GameCard";
import { LobbyStandings } from "./components/LobbyStandings";
import { GameStandings } from "./components/GameStandings";
import { GameOverOverlay, type SubmitStatus } from "./components/GameOverOverlay";

export interface GamesModuleProps {
  /** True while another module is the active tab — games must halt their
   *  loops so a hidden game doesn't burn CPU or rack up time-based score. */
  paused: boolean;
}

const LAST_GAME_KEY = "helios:games:lastGame";
const LAST_SECTION_KEY = "helios:games:lastSection";

/** Lobby copy per section — same room, different corner of it. */
const SECTIONS: { id: GameCategory; label: string; tagline: string }[] = [
  { id: "arcade", label: "ARCADE", tagline: "Sun Devil Motorsports · after hours" },
  { id: "casino", label: "CASINO", tagline: "Sun Devil Motorsports · house chips only" },
];

export function GamesModule({ paused }: GamesModuleProps) {
  const { client } = useHeliosAuth();
  const [active, setActive] = useState<GameDef | null>(null);
  const [run, setRun] = useState(0); // key bump remounts the game = restart
  const [over, setOver] = useState<
    { score: number; status: SubmitStatus; rated?: boolean; delta?: number } | null
  >(null);
  // Rated games continue a carried rating, so it has to be in hand before the
  // cabinet mounts. `null` means "still loading" for a rated game.
  const [carried, setCarried] = useState<Rating | null>(null);
  // Money games spend the subteam's shared budget, which likewise has to be
  // resolved before the cabinet mounts. `null` means "still loading".
  const [budget, setBudget] = useState<Budget | null>(null);
  // Idempotency nonce for the current game-over submission: generated once when
  // the game ends, then reused on every retry so a duplicate-insert can never
  // occur on a flaky network.
  const submitNonceRef = useRef<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [boardGame, setBoardGame] = useState<GameId>(() => {
    try {
      const saved = localStorage.getItem(LAST_GAME_KEY) as GameId | null;
      return saved && GAMES.some((g) => g.id === saved) ? saved : GAMES[0]!.id;
    } catch {
      return GAMES[0]!.id;
    }
  });
  const [section, setSection] = useState<GameCategory>(() => {
    try {
      const saved = localStorage.getItem(LAST_SECTION_KEY);
      return saved === "casino" ? "casino" : "arcade";
    } catch {
      return "arcade";
    }
  });

  function selectSection(s: GameCategory) {
    setSection(s);
    try {
      localStorage.setItem(LAST_SECTION_KEY, s);
    } catch {
      // ignore (private mode / quota)
    }
  }

  // Warm every standings board on mount (and re-warm after each submit) so
  // the first click on any tab or game chip renders instantly from cache
  // instead of cold-loading.
  useEffect(() => {
    if (client) prefetchBoards(client, refreshToken);
  }, [client, refreshToken]);

  /** Lobby board game switch — persisted like play() so the choice sticks. */
  function selectBoard(g: GameId) {
    setBoardGame(g);
    try {
      localStorage.setItem(LAST_GAME_KEY, g);
    } catch {
      // ignore (private mode / quota)
    }
  }

  function play(game: GameDef) {
    if (!client) return; // unreachable: the shell auth-gates this module
    submitNonceRef.current = null; // fresh game → fresh submission nonce
    setActive(game);
    setOver(null);
    setRun((n) => n + 1);
    setBoardGame(game.id);
    setCarried(null);
    setBudget(null);
    // Blackjack is BOTH rated and money — it carries a personal rating AND
    // spends the subteam budget — so these are two independent ifs, not a
    // chain. Getting that wrong leaves the cabinet gated forever on a budget
    // nobody fetched.
    if (isRated(game.id)) {
      // gate the cabinet until the rating lands
      void fetchRating(client, game.id)
        // A failed load must not lock anyone out of the table. The stored
        // rating is computed server-side from the server's own row, so a wrong
        // baseline here only misdraws the live projection — it cannot corrupt
        // what actually gets saved.
        .catch(() => ({ rating: 1000, handsRated: 0 }))
        .then(setCarried);
    }
    if (isMoney(game.id)) {
      // Gate the cabinet until the budget lands, and DON'T fall back to a
      // made-up balance the way the rating does: a wrong rating misdraws a
      // projection, but a wrong balance would invite bets the budget can't
      // cover. Leaving it null keeps the cabinet on its loading state.
      void fetchBudget(client)
        .then(setBudget)
        .catch(() => setBudget(null));
    }
    selectSection(game.category); // back-nav lands in the section you played from
    try {
      localStorage.setItem(LAST_GAME_KEY, game.id);
    } catch {
      // ignore (private mode / quota)
    }
  }

  async function handleGameOver(score: number, session?: RatedSession) {
    if (!active || !client) return;
    // A money game that carries no rating has nothing to submit: its chips
    // were already spent one ledger row at a time while it was being played,
    // and there is no score. Blackjack is money AND rated, so it must NOT take
    // this exit — it still submits the session that moves its rating.
    if (isMoney(active.id) && !isRated(active.id)) return;
    // Lazily mint the nonce the first time this game-over fires, then reuse it
    // on every retry so we never insert duplicate rows for the same play.
    if (!submitNonceRef.current) {
      submitNonceRef.current = crypto.randomUUID();
    }
    const rated = isRated(active.id) && session !== undefined;
    setOver({ score, status: "submitting", rated });
    try {
      if (rated) {
        // The server owns the arithmetic; show what it decided, not what the
        // client projected, so the two can never appear to disagree.
        const applied = await submitRatedSession(client, active.id, session, submitNonceRef.current);
        setCarried({ rating: applied.rating, handsRated: applied.handsRated });
        setOver({
          score: Math.round(applied.rating),
          status: "submitted",
          rated: true,
          delta: applied.delta,
        });
      } else {
        await submitScore(client, active.id, score, submitNonceRef.current);
        setOver({ score, status: "submitted" });
      }
      setRefreshToken((n) => n + 1);
    } catch {
      setOver({ score, status: "error", rated });
    }
  }

  // ---------------------------------------------------------- shared money
  // The cabinet never touches the network: it calls `place`, we place the bet
  // and hand back what the server decided. The balance it renders is always
  // the server's, never one we worked out here.
  // Every one of these ends the same way: take the server's balance, never
  // compute one here.
  const bank = <T extends { balance: number; maxBet: number }>(res: T): T => {
    setBudget((b) => (b ? { ...b, balance: res.balance, maxBet: res.maxBet } : b));
    return res;
  };
  // Reassigned every render so the closures always see the current client and
  // cabinet — a ref initialiser would freeze the first render's forever.
  const moneyOps = useRef<{
    drop: (req: DropRequest, nonce: string) => Promise<DropResult>;
    placeBet: (stake: number, nonce: string) => Promise<PlacedBet>;
    raiseBet: (betId: string, nonce: string) => Promise<RaisedBet>;
    settleBet: (
      betId: string, payout: number, outcome: string, nonce: string,
    ) => Promise<SettledBet>;
    forfeitOpen: () => Promise<{ stake: number } | null>;
  } | null>(null);
  moneyOps.current = {
    drop: async (req, nonce) => {
      if (!client) throw new Error("no table open");
      return bank(await dropBall(client, req, nonce));
    },
    placeBet: async (stake, nonce) => {
      if (!client || !active) throw new Error("no table open");
      return bank(await placeBet(client, active.id, stake, nonce));
    },
    raiseBet: async (betId, nonce) => {
      if (!client) throw new Error("no table open");
      return bank(await raiseBet(client, betId, nonce));
    },
    settleBet: async (betId, payout, outcome, nonce) => {
      if (!client) throw new Error("no table open");
      return bank(await settleBet(client, betId, payout, outcome, nonce));
    },
    forfeitOpen: async () => {
      if (!client || !active) return null;
      const lost = await forfeitOpenBet(client, active.id);
      // Forfeiting doesn't move the balance (those chips left when the hand
      // was dealt) but it does free the table, so re-read what's affordable.
      if (lost) void fetchBudget(client).then(setBudget).catch(() => undefined);
      return lost;
    },
  };
  // Stable identities, same reasoning as stableOnGameOver below: a re-render
  // must not churn the cabinet's effects mid-hand.
  const stableMoney = useRef({
    place: (req: DropRequest, nonce: string) => moneyOps.current!.drop(req, nonce),
    placeBet: (stake: number, nonce: string) => moneyOps.current!.placeBet(stake, nonce),
    raiseBet: (betId: string, nonce: string) => moneyOps.current!.raiseBet(betId, nonce),
    settleBet: (betId: string, payout: number, outcome: string, nonce: string) =>
      moneyOps.current!.settleBet(betId, payout, outcome, nonce),
    forfeitOpen: () => moneyOps.current!.forfeitOpen(),
  }).current;

  // Shared money is only shared if you can watch it move. While a money
  // cabinet is open, re-read the budget so a teammate spending at another desk
  // shows up as a falling number rather than as a surprise rejection when you
  // next press DROP. Paused (tab hidden) stops it, like every other loop here.
  useEffect(() => {
    if (!client || !active || !isMoney(active.id) || paused) return;
    const id = setInterval(() => {
      void fetchBudget(client)
        .then(setBudget)
        .catch(() => undefined); // a flaky poll must never disturb the table
    }, 6000);
    return () => clearInterval(id);
  }, [client, active, paused]);

  const money: MoneyTable | undefined =
    active && isMoney(active.id) && budget
      ? { ...budget, ...stableMoney }
      : undefined;

  // Keep the latest closure in a ref but hand the games a stable identity, so
  // a GamesModule re-render (e.g. leaderboard refresh) can't churn their
  // input-listener effects mid-play.
  const handleGameOverRef = useRef(handleGameOver);
  handleGameOverRef.current = handleGameOver;
  const stableOnGameOver = useRef((score: number, session?: RatedSession) => {
    void handleGameOverRef.current(score, session);
  }).current;

  if (!client) return null; // module is auth-gated by the shell; belt-and-braces

  const ActiveGame = active?.component;

  return (
    <div className="games-root games-bg flex h-full">
      <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-4">
        {active && ActiveGame ? (
          /* In-game the standings wrap the surface vertically (podium strip
           * above, rest of the field below) instead of a side tower — the
           * games are small, so the vertical room is where the space is. */
          <div className="flex h-full min-h-0 w-fit max-w-full flex-col justify-center gap-2">
            <div className="flex shrink-0 items-center justify-between">
              <div className="games-display text-sm text-helios-text">{active.title}</div>
              <button
                type="button"
                onClick={() => { setActive(null); setOver(null); }}
                className="rounded-sm px-2 py-1 text-xs text-helios-dim transition-colors hover:text-asu-gold"
              >
                ← All games
              </button>
            </div>
            <GameStandings client={client} gameId={active.id} refreshToken={refreshToken}>
              <div className="relative shrink-0 self-center">
                {(isRated(active.id) && !carried) || (isMoney(active.id) && !budget) ? (
                  /* A rated cabinet can't open until we know what rating the
                   * session is continuing from, and a money cabinet can't open
                   * until we know what the subteam can afford. Sized to the
                   * table so the layout doesn't jump when it lands. */
                  <div className="games-crt">
                    <div
                      className={
                        "games-display flex w-[400px] items-center justify-center text-[10px] tracking-[0.2em] text-helios-dim " +
                        // Sized to the cabinet it stands in for, so the layout
                        // doesn't jump when the real table lands.
                        (isMoney(active.id) ? "h-[510px]" : "h-[420px]")
                      }
                    >
                      <span className="games-pulse">
                        {isMoney(active.id) && !budget
                          ? "OPENING THE SUBTEAM BUDGET…"
                          : "LOADING YOUR RATING…"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <ActiveGame
                    key={run}
                    onGameOver={stableOnGameOver}
                    paused={paused}
                    rating={carried ?? undefined}
                    money={money}
                  />
                )}
                {over && (
                  <GameOverOverlay
                    score={over.score}
                    status={over.status}
                    rated={over.rated}
                    delta={over.delta}
                    onRetrySubmit={() => void handleGameOver(over.score)}
                    onRestart={() => {
                      submitNonceRef.current = null; // fresh game → fresh nonce
                      setOver(null);
                      setRun((n) => n + 1);
                    }}
                    onBack={() => { setActive(null); setOver(null); }}
                  />
                )}
              </div>
            </GameStandings>
          </div>
        ) : (
          /* Lobby: one centered column — header, cabinet grid, and the
           * standings board beneath at the same width (with its own game
           * switcher), instead of a side tower fighting for horizontal room. */
          <div className="max-h-full w-full max-w-2xl overflow-y-auto px-1">
            <div className="mb-6">
              <div className="games-hazard mb-3 h-1 w-12 rounded-sm" />
              {/* The heading IS the section switcher: active section in gold,
               * the other room a dim click away. */}
              <div className="flex items-baseline gap-5">
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => selectSection(s.id)}
                    className={
                      "games-display-heavy text-2xl tracking-[0.22em] transition-colors " +
                      (section === s.id
                        ? "text-asu-gold"
                        : "text-helios-line hover:text-helios-dim")
                    }
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-helios-dim">
                {SECTIONS.find((s) => s.id === section)!.tagline}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {GAMES.filter((g) => g.category === section).map((g, i) => (
                <GameCard key={g.id} game={g} index={i} onPlay={() => play(g)} />
              ))}
            </div>
            <div className="mt-4 pb-2">
              {/* Each room has its own standings board: if the remembered
               * board game belongs to the other room, fall back to this
               * room's first game rather than showing a cross-room board. */}
              <LobbyStandings
                client={client}
                game={
                  categoryOf(boardGame) === section
                    ? boardGame
                    : gamesInCategory(section)[0]!.id
                }
                onGameChange={selectBoard}
                refreshToken={refreshToken}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
