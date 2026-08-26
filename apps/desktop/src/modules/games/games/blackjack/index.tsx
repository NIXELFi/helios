import { useEffect, useRef, useState } from "react";
import type { GameProps } from "../types";
import {
  createShoe,
  dealerShouldHit,
  handValue,
  hiLoValue,
  isBlackjack,
  netUnits,
  settle,
  trueCount,
  DECKS,
  RESHUFFLE_BELOW,
  type Card,
  type Outcome,
} from "./logic";
import { actionEVs, bestAction, optimalEV, referenceEV, type Action } from "./ev";
import {
  handAdvantage,
  lineEV,
  RATING_REFERENCE_BANKROLL,
} from "./rating";

// Chips come from the SUBTEAM BUDGET now, not a 200-chip stack the cabinet
// owns. Two consequences run through this file:
//
//  * Money moves in two server round trips per hand — placeBet when the cards
//    come out, settleBet when the hand finishes — because a blackjack hand is
//    played over time and can't settle atomically the way a plinko drop does.
//    The balance on screen is always the server's answer, never one worked out
//    here, and the stake is gone from the budget the moment the hand is dealt
//    (which is exactly where those chips are: on the table).
//  * Leaving mid-hand FORFEITS the bet. Refunding would pay a player to close
//    the window on a losing hand, since the client knows the outcome before it
//    settles. The cabinet forfeits any hand it finds still open on mount.
//
// Blackjack is NOT rated. The chips are the whole scoreboard: the table keeps
// no score and submits no session, and games.ratings is left alone rather than
// deleted so the ladder can be switched back on without losing anyone's
// history. The EV machinery below survives because it still drives the
// coaching line ("the chart wanted X") and LUCK — not a ladder.

const CHIP_VALUES = [5, 25, 100] as const;
/** The table minimum — the unit every stake is measured in. */
const TABLE_MIN = CHIP_VALUES[0];
const DEALER_DRAW_MS = 450;

type Phase = "bet" | "player" | "dealer" | "settled";

/** Everything the rating needs to know about the hand in progress. Captured at
 *  the deal so a doubled stake or a drawn card can't retroactively change what
 *  the spot was worth. */
interface LiveHand {
  /** The dealt two cards — the reference player's EV is measured from these. */
  opening: Card[];
  /** V* of the opening spot, given the options actually affordable. */
  evOptimal: number;
  /** EV surrendered to misplays so far, in initial-bet units. */
  evLost: number;
  /** The worst decision made this hand, for the coaching line. */
  worst: { chosen: Action; best: Action; cost: number } | null;
  /** Stake before any double. */
  initialBet: number;
  /** True count when the bet went down — the only information a bet can
   *  honestly be based on. */
  trueCountAtBet: number;
}

/** Running totals for the session, all of them rating inputs or player-facing
 *  stats. Advantage components are kept apart so the UI can show WHERE the
 *  rating came from. */
interface Session {
  hands: number;
  play: number;
  bet: number;
  risk: number;
  total: number;
  /** Realised result minus what the line was worth — pure luck, deliberately
   *  kept OUT of the rating and shown to the player as its own number. */
  fortune: number;
  /** EV thrown away across the whole session. */
  evLost: number;
  /** Hands played without a single misplay. */
  clean: number;
}

interface Table {
  phase: Phase;
  /** The SUBTEAM budget, as the server last reported it. Display only — the
   *  cabinet never does arithmetic on it. */
  bankroll: number;
  /** Server id of the hand currently on the table, null between hands. */
  betId: string | null;
  /** What the finished hand pays, waiting to be sent to settleBet. */
  lastPayout: number;
  /** Guards the settle effect so one hand is only ever settled once. */
  settleSent: boolean;
  /** Staged wager in the bet phase; the live stake (doubled if doubled) once dealt. */
  bet: number;
  /** Pre-double stake — carried into the next hand as the default re-bet. */
  baseBet: number;
  player: Card[];
  dealer: Card[];
  holeShown: boolean;
  outcome: Outcome | null;
  live: LiveHand | null;
  session: Session;
  wins: number;
  losses: number;
  pushes: number;
  cardsLeft: number;
}

const EMPTY_SESSION: Session = {
  hands: 0, play: 0, bet: 0, risk: 0, total: 0, fortune: 0, evLost: 0, clean: 0,
};

const SUIT_CHAR = { S: "♠", H: "♥", D: "♦", C: "♣" } as const;
const ACTION_LABEL: Record<Action, string> = { hit: "HIT", stand: "STAND", double: "DOUBLE" };

function PlayingCard({ card, hidden }: { card: Card; hidden?: boolean }) {
  if (hidden) return <div className="games-card games-deal games-card-back" />;
  const red = card.suit === "H" || card.suit === "D";
  const sym = SUIT_CHAR[card.suit];
  const corner = (
    <span>
      {card.rank}
      <span className="ml-px text-[9px]">{sym}</span>
    </span>
  );
  return (
    <div
      className={
        "games-card games-deal flex flex-col justify-between bg-[#e9e6dc] p-1 " +
        (red ? "text-asu-maroon" : "text-[#17181c]")
      }
    >
      <div className="text-[11px] font-bold leading-none">{corner}</div>
      <div className="self-center text-lg leading-none">{sym}</div>
      <div className="rotate-180 self-start text-[11px] font-bold leading-none">{corner}</div>
    </div>
  );
}

/** Hand label total: "17", "soft 17", or "BUST". */
function totalLabel(cards: Card[]): string {
  const { total, soft } = handValue(cards);
  if (total > 21) return "BUST";
  return soft ? `soft ${total}` : String(total);
}

function signed(n: number, digits = 2): string {
  const magnitude = Math.abs(n).toFixed(digits);
  // A value too small to show mustn't render as "−0.00" — a bet a shade over
  // the safe fraction costs a rounding error, and printing it as a loss reads
  // like the game is docking you for nothing.
  const sign = Number(magnitude) === 0 ? "" : n > 0 ? "+" : "−";
  return `${sign}${magnitude}`;
}

export function BlackjackGame({ onGameOver, paused, money }: GameProps) {

  // Shoe is draw-only mutable state the UI never maps over — a ref keeps the
  // multi-draw actions (deal = four pops) simple; cardsLeft mirrors it for
  // display.
  const shoeRef = useRef<Card[] | null>(null);
  if (!shoeRef.current) shoeRef.current = createShoe(Math.random);
  // Hi-Lo running count over every card the player has SEEN. Reset with the
  // shoe. Cards are counted explicitly at each reveal point rather than inside
  // draw(), because the hole card is drawn long before it is visible.
  const runningRef = useRef(0);
  // The hole card is the one card whose reveal isn't tied to a draw. Several
  // paths flip it face-up, so it's counted once per hand at settle time —
  // always before the next deal reads the count — and this guards the double.
  const holeCountedRef = useRef(false);

  const [table, setTable] = useState<Table>(() => ({
    phase: "bet",
    bankroll: money?.balance ?? 0,
    betId: null,
    lastPayout: 0,
    settleSent: true, // nothing on the table yet
    bet: 0,
    baseBet: 0,
    player: [],
    dealer: [],
    holeShown: false,
    outcome: null,
    live: null,
    session: EMPTY_SESSION,
    wins: 0,
    losses: 0,
    pushes: 0,
    cardsLeft: DECKS * 52, // a fresh shoe — the guard above just built it
  }));
  const ended = useRef(false);
  // Same pattern as 2048: mirror state into a ref so the keydown handler and
  // dealer timer read the latest table without re-registering per render.
  const tableRef = useRef(table);
  tableRef.current = table;
  /** A bet or a double is in flight — blocks a second one racing it out. A ref
   *  because the guard has to be synchronous; `busy` mirrors it for the UI. */
  const placing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);
  function setPlacing(v: boolean) {
    placing.current = v;
    setBusy(v);
  }

  // The budget moves under this cabinet whenever a teammate plays, so take the
  // module's number whenever it changes — except while a hand is being dealt
  // or settled, when our own round trip is the fresher truth.
  useEffect(() => {
    if (!money || placing.current) return;
    setTable((t) => (t.bankroll === money.balance ? t : { ...t, bankroll: money.balance }));
  }, [money?.balance]); // eslint-disable-line react-hooks/exhaustive-deps

  // A hand left open by a previous session (crash, closed window, machine
  // asleep mid-deal) is FORFEIT. It can't be refunded: the client knows the
  // outcome before it settles, so refunding would pay players to close the
  // window on losers. Clear it on mount so the table can be dealt again.
  useEffect(() => {
    if (!money) return;
    void money
      .forfeitOpen()
      .then((lost) => {
        if (lost) setTableError(`a hand left open last time forfeited ${lost.stake} chips`);
      })
      .catch(() => undefined);
    // Mount only — a forfeit mid-session would kill the hand being played.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // THE settle path. settled() is pure and is reached from four places (a
  // natural, a bust, a double-bust, the dealer's last draw); routing the money
  // through one effect keyed on `settleSent` means a hand is paid exactly once
  // however it ended, and a failed settle is retried rather than lost.
  useEffect(() => {
    if (!money || table.settleSent || !table.betId || table.phase !== "settled") return;
    const betId = table.betId;
    const payout = table.lastPayout;
    const outcome = table.outcome ?? "unknown";
    setTable((t) => ({ ...t, settleSent: true }));
    void money
      .settleBet(betId, payout, outcome, crypto.randomUUID())
      .then((res) => {
        setTable((t) => (t.betId === betId ? { ...t, bankroll: res.balance } : t));
      })
      .catch((e: unknown) => {
        // Let it be retried: the chips are still out, and the server has the
        // hand open, so the next attempt settles the same bet id.
        setTable((t) => (t.betId === betId ? { ...t, settleSent: false } : t));
        setTableError(e instanceof Error ? e.message : "couldn't settle that hand");
      });
  }, [table.settleSent, table.betId, table.phase, table.lastPayout, money]); // eslint-disable-line react-hooks/exhaustive-deps

  function draw(): Card {
    const shoe = shoeRef.current!;
    if (shoe.length === 0) shoeRef.current = createShoe(Math.random); // unreachable with the between-hand reshuffle; belt-and-braces
    return shoeRef.current!.pop()!; // non-empty by the line above
  }

  /** Fold newly visible cards into the running count. */
  function see(...cards: Card[]) {
    for (const c of cards) runningRef.current += hiLoValue(c);
  }

  /** Charge the player for a decision that wasn't the best one available. */
  function grade(t: Table, action: Action): Table {
    const live = t.live;
    if (!live) return t;
    const canDouble = t.player.length === 2 && t.bankroll >= t.bet;
    const evs = actionEVs(t.player, t.dealer[0]!, canDouble);
    const best = bestAction(t.player, t.dealer[0]!, canDouble);
    const chosen = action === "double" ? evs.double : evs[action];
    // A double the player can't afford isn't on the menu; actionEVs returns
    // null for it and there is nothing to grade.
    if (chosen === null || chosen === undefined) return t;
    const cost = Math.max(0, best.ev - chosen);
    return {
      ...t,
      live: {
        ...live,
        evLost: live.evLost + cost,
        worst:
          cost > 1e-9 && (!live.worst || cost > live.worst.cost)
            ? { chosen: action, best: best.action, cost }
            : live.worst,
      },
    };
  }

  /** Settle the hand into a new table state (rating, record, bankroll). */
  function settled(t: Table, player: Card[], dealer: Card[]): Table {
    const { outcome, payout } = settle(player, dealer, t.bet);
    // The hole card is face-up by now on every path into here, and this always
    // runs before the next deal samples the count. `t.holeShown` is NOT a
    // usable guard — stand/double/hit-to-21 all flip it before settling — so
    // the once-per-hand ref is what keeps the count honest.
    if (!holeCountedRef.current && dealer[1]) {
      see(dealer[1]);
      holeCountedRef.current = true;
    }

    const live = t.live;
    let session = t.session;
    if (live) {
      // The reference player is measured from the SAME opening cards, which is
      // what cancels deal luck: a gift hand is a gift to both of us.
      const evReference = referenceEV(live.opening, dealer[0]!);
      const evLine = lineEV(live.evOptimal, live.evLost);
      const adv = handAdvantage({
        stakeUnits: live.initialBet / TABLE_MIN,
        // Measured against the rating's own reference stack, NOT the subteam
        // budget. Against a 10,000-chip budget every legal bet is a rounding
        // error, RISK would never fire, and bankroll discipline would silently
        // stop being rated at all.
        bankrollFraction: Math.min(1, live.initialBet / RATING_REFERENCE_BANKROLL),
        evLine,
        evReference,
        trueCountAtBet: live.trueCountAtBet,
      });
      session = {
        hands: session.hands + 1,
        play: session.play + adv.play,
        bet: session.bet + adv.bet,
        risk: session.risk + adv.risk,
        total: session.total + adv.total,
        // In table-minimum money like every other column: how many minimums
        // the shoe handed you (or robbed you of) beyond what the line was worth.
        fortune:
          session.fortune +
          (netUnits(payout, t.bet, live.initialBet) - evLine) * (live.initialBet / TABLE_MIN),
        evLost: session.evLost + live.evLost,
        clean: session.clean + (live.evLost <= 1e-9 ? 1 : 0),
      };
    }

    return {
      ...t,
      phase: "settled",
      player,
      dealer,
      holeShown: true,
      outcome,
      session,
      wins: t.wins + (outcome === "win" || outcome === "blackjack" ? 1 : 0),
      losses: t.losses + (outcome === "lose" ? 1 : 0),
      pushes: t.pushes + (outcome === "push" ? 1 : 0),
      // The budget is NOT credited here. This function is pure and is called
      // from four different settle paths; the payout is recorded and a single
      // effect sends it to the server, so one hand can only ever be settled
      // once no matter which path finished it.
      lastPayout: payout,
      settleSent: false,
      cardsLeft: shoeRef.current!.length,
    };
  }

  async function deal() {
    const t = tableRef.current;
    if (ended.current || t.phase !== "bet" || t.bet <= 0 || !money) return;
    if (t.bet > money.maxBet || placing.current) return;

    // Chips leave the budget BEFORE any card is dealt. If the server refuses
    // (a teammate just spent the budget down under us, or the hand is somehow
    // still open) nothing is dealt at all — the alternative is a hand in play
    // that the team never paid for.
    setPlacing(true);
    let placed;
    try {
      placed = await money.placeBet(t.bet, crypto.randomUUID());
    } catch (e) {
      setPlacing(false);
      setTableError(e instanceof Error ? e.message : "the house said no");
      return;
    }
    setPlacing(false);
    setTableError(null);
    if (ended.current) return;

    if (shoeRef.current!.length < RESHUFFLE_BELOW) {
      shoeRef.current = createShoe(Math.random);
      runningRef.current = 0; // a fresh shoe knows nothing
    }
    // Sampled BEFORE the deal: this is the whole information set the bet could
    // legitimately have been based on.
    const tcAtBet = trueCount(runningRef.current, shoeRef.current!.length);

    const player = [draw(), draw()];
    const dealer = [draw(), draw()];
    see(player[0]!, player[1]!, dealer[0]!); // the hole stays uncounted until it flips
    holeCountedRef.current = false;

    const live: LiveHand = {
      opening: player,
      // Doubling is on the menu only if the budget could take a second stake
      // of the same size — the 5% cap applies to it separately.
      evOptimal: optimalEV(player, dealer[0]!, placed.maxBet >= t.bet),
      evLost: 0,
      worst: null,
      initialBet: t.bet,
      trueCountAtBet: tcAtBet,
    };
    const dealt: Table = {
      ...t,
      phase: "player",
      bankroll: placed.balance,
      betId: placed.betId,
      settleSent: true, // nothing settled yet; settled() flips this
      baseBet: t.bet,
      player,
      dealer,
      holeShown: false,
      outcome: null,
      live,
      cardsLeft: shoeRef.current!.length,
    };
    // Naturals settle on the spot — no double into a dealer blackjack. The
    // player never got a decision, so the hand must carry ZERO play margin:
    // pinning the line to exactly what the reference would have scored from
    // the same spot does that. It matters most when the DEALER has the
    // natural — without this the player would bank the margin of a hand they
    // were never allowed to play. The stake still answers for itself through
    // the bet and risk terms.
    if (isBlackjack(player) || isBlackjack(dealer)) {
      const flat = { ...dealt, live: { ...live, evOptimal: referenceEV(player, dealer[0]!) } };
      setTable(settled(flat, player, dealer));
      return;
    }
    setTable(dealt);
  }

  function hit() {
    const t0 = tableRef.current;
    if (ended.current || t0.phase !== "player") return;
    const t = grade(t0, "hit");
    const player = [...t.player, draw()];
    see(player[player.length - 1]!);
    const total = handValue(player).total;
    if (total > 21) {
      setTable(settled(t, player, t.dealer)); // dealer just shows the hole on a bust
    } else if (total === 21) {
      setTable({ ...t, player, phase: "dealer", holeShown: true, cardsLeft: shoeRef.current!.length });
    } else {
      setTable({ ...t, player, cardsLeft: shoeRef.current!.length });
    }
  }

  function stand() {
    const t0 = tableRef.current;
    if (ended.current || t0.phase !== "player") return;
    const t = grade(t0, "stand");
    setTable({ ...t, phase: "dealer", holeShown: true });
  }

  async function doubleDown() {
    const t0 = tableRef.current;
    if (ended.current || t0.phase !== "player" || t0.player.length !== 2) return;
    if (!money || !t0.betId || placing.current) return;
    // The double is a SECOND debit of the same size, capped on its own — so a
    // doubled hand can carry up to 10% of the budget. Charge it before the
    // card comes out, same as the deal.
    setPlacing(true);
    let raised;
    try {
      raised = await money.raiseBet(t0.betId, crypto.randomUUID());
    } catch (e) {
      setPlacing(false);
      setTableError(e instanceof Error ? e.message : "can't double that");
      return;
    }
    setPlacing(false);
    setTableError(null);
    if (ended.current) return;

    const t = grade(tableRef.current, "double");
    const doubled: Table = { ...t, bankroll: raised.balance, bet: raised.stake };
    const player = [...t.player, draw()];
    see(player[player.length - 1]!);
    setTable(
      handValue(player).total > 21
        ? settled(doubled, player, t.dealer)
        : { ...doubled, player, phase: "dealer", holeShown: true, cardsLeft: shoeRef.current!.length },
    );
  }

  function nextHand() {
    const t = tableRef.current;
    if (ended.current || t.phase !== "settled") return;
    // Don't deal on top of a hand whose payout hasn't reached the server yet —
    // the one-open-hand index would reject it anyway, and the error would land
    // on the player instead of on the retry.
    if (!t.settleSent || !money || money.maxBet <= 0) return;
    setTable({
      ...t,
      phase: "bet",
      betId: null,
      bet: Math.min(t.baseBet, money.maxBet),
      player: [],
      dealer: [],
      holeShown: false,
      outcome: null,
      live: null,
    });
  }

  function cashOut() {
    const t = tableRef.current;
    if (ended.current || (t.phase !== "bet" && t.phase !== "settled")) return;
    ended.current = true;
    // Blackjack is a money game only: the chips already moved, hand by hand,
    // through place_bet/settle_bet. There is no score and no rating to submit,
    // so leaving the table just ends the session.
    onGameOver(0);
  }

  function addChip(v: number) {
    // Touching the chips is the player acknowledging whatever went wrong last
    // time; leaving a stale refusal on screen just makes the table look broken.
    if (tableError) setTableError(null);
    const t = tableRef.current;
    if (ended.current || t.phase !== "bet" || t.bet + v > (money?.maxBet ?? 0)) return;
    setTable({ ...t, bet: t.bet + v });
  }

  // Dealer draws one card per tick until 17+, then the hand settles. The
  // effect re-arms itself off the dealer hand changing; pausing simply stops
  // arming the next tick.
  useEffect(() => {
    if (table.phase !== "dealer" || paused || ended.current) return;
    const id = setTimeout(() => {
      const t = tableRef.current;
      if (t.phase !== "dealer") return;
      if (dealerShouldHit(t.dealer)) {
        const card = draw();
        see(card);
        setTable({ ...t, dealer: [...t.dealer, card], cardsLeft: shoeRef.current!.length });
      } else {
        setTable(settled(t, t.player, t.dealer));
      }
    }, DEALER_DRAW_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.phase, table.dealer, paused]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (paused || ended.current) return;
      const t = tableRef.current;
      const k = e.key.toLowerCase();
      if (t.phase === "player") {
        if (k === "h") { e.preventDefault(); hit(); }
        else if (k === "s") { e.preventDefault(); stand(); }
        else if (k === "d") { e.preventDefault(); void doubleDown(); }
      } else if (e.key === "Enter") {
        if (t.phase === "bet" && t.bet > 0) { e.preventDefault(); void deal(); }
        else if (t.phase === "settled") { e.preventDefault(); nextHand(); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const { phase, bankroll, bet, player, dealer, holeShown, outcome, session, live } = table;
  const maxBet = money?.maxBet ?? 0;
  // "Broke" is a SUBTEAM-wide condition now: the budget can no longer cover a
  // legal bet, and nothing this player does at this table will change that.
  const broke = phase === "settled" && maxBet <= 0;


  const outcomeLine =
    outcome === "blackjack" ? { text: "BLACKJACK — PAYS 3:2", cls: "text-asu-gold" }
    : outcome === "win" ? { text: "YOU WIN", cls: "text-asu-gold" }
    : outcome === "push" ? { text: "PUSH", cls: "text-helios-text" }
    : outcome === "lose" ? { text: handValue(player).total > 21 ? "BUST" : "DEALER WINS", cls: "text-red-300" }
    : null;

  const actionBtn =
    "games-display rounded-sm border px-3 py-1.5 text-[10px] tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-35";
  const goldBtn = `${actionBtn} border-asu-gold bg-asu-gold text-helios-base hover:opacity-90 disabled:hover:opacity-35`;
  const lineBtn = `${actionBtn} border-helios-line bg-transparent text-helios-text hover:border-asu-gold`;

  return (
    <div className="games-crt">
      <div className="flex w-[400px] flex-col gap-3 p-1">
        {/* Chip rail — the subteam's shared budget is the only scoreboard this
            table keeps. It moves when a TEAMMATE plays too. */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span
              className="games-display text-[10px] text-helios-dim"
              title="Your subteam's shared budget — these are the team's chips"
            >
              {(money?.subteam ?? "BANK").toUpperCase()}
            </span>
            <span className="games-num text-lg font-bold text-asu-gold">
              {bankroll.toLocaleString()}
            </span>
          </div>
          <span className="games-num text-[10px] text-helios-dim">
            W {table.wins} · L {table.losses} · P {table.pushes}
          </span>
        </div>

        {/* Dealer */}
        <div>
          <div className="flex items-baseline justify-between">
            <span className="games-display text-[9px] tracking-[0.2em] text-helios-dim">DEALER</span>
            <span className="games-num text-xs text-helios-text">
              {dealer.length === 0 ? "—" : holeShown ? totalLabel(dealer) : totalLabel([dealer[0]!])}
            </span>
          </div>
          <div className="mt-1 flex min-h-[68px] items-center">
            {dealer.map((c, i) => (
              // Remount the hole card when it flips so it plays the deal-in.
              <PlayingCard key={i === 1 ? `1-${holeShown ? "up" : "down"}` : i} card={c} hidden={i === 1 && !holeShown} />
            ))}
          </div>
        </div>

        {/* Player */}
        <div>
          <div className="flex items-baseline justify-between">
            <span className="games-display text-[9px] tracking-[0.2em] text-helios-dim">YOU</span>
            <span className="games-num text-xs text-helios-text">
              {player.length === 0 ? "—" : totalLabel(player)}
            </span>
          </div>
          <div className="mt-1 flex min-h-[68px] items-center">
            {player.map((c, i) => (
              <PlayingCard key={i} card={c} />
            ))}
          </div>
        </div>

        {/* Status line — fixed height so the table never jumps */}
        <div className="games-display min-h-[18px] text-center text-xs tracking-[0.18em]">
          {/* The money is shared and the server has the last word on it, so a
              refused bet or a failed settle has to be visible — the whole
              subteam sees the consequence in the ledger either way. */}
          {tableError ? (
            <span className="text-[10px] normal-case tracking-normal text-red-300">
              {tableError}
            </span>
          ) : busy ? (
            <span className="games-pulse text-helios-dim">TAKING IT FROM THE BUDGET…</span>
          ) : phase === "bet" ? (
            <span className="text-helios-dim">PLACE YOUR BET</span>
          ) : phase === "player" ? (
            <span className="text-helios-dim">HIT · STAND · DOUBLE</span>
          ) : phase === "dealer" ? (
            <span className="games-pulse text-helios-dim">DEALER DRAWS…</span>
          ) : phase === "settled" && outcomeLine ? (
            <span className={outcomeLine.cls}>{outcomeLine.text}</span>
          ) : null}
        </div>

        {/* Coaching line — the rating is built on decisions, so say which one
            cost you and what the chart wanted instead. Reserved height. */}
        <div className="min-h-[13px] text-center text-[9px] tracking-wide">
          {phase === "settled" && live?.worst ? (
            <span className="text-red-300/90">
              {ACTION_LABEL[live.worst.chosen]} cost {live.worst.cost.toFixed(2)} EV — chart says{" "}
              <span className="font-bold">{ACTION_LABEL[live.worst.best]}</span>
            </span>
          ) : phase === "settled" && session.hands > 0 ? (
            <span className="text-helios-dim/70">played by the book</span>
          ) : null}
        </div>

        {/* Table rail */}
        <div className="games-num flex items-center justify-between text-[10px] text-helios-dim">
          <span title="5% of the budget is the most one bet can be">
            MAX <span className="text-helios-text">{maxBet}</span>
          </span>
          <span>BET <span className="font-bold text-asu-gold">{bet}</span></span>
          <span>SHOE <span className="text-helios-text">{table.cardsLeft}</span></span>
        </div>

        {/* Session line. The table is not rated any more, so this is purely
            coaching: how much of the session followed the chart, and how the
            cards fell versus what the play was actually worth. */}
        <div className="rounded-sm border border-helios-line/70 bg-helios-panel/40 px-2 py-1.5">
          <div className="games-num flex items-center justify-between text-[9px] text-helios-dim">
            <span>
              {session.hands} hand{session.hands === 1 ? "" : "s"}
              {session.hands > 0 && ` · ${session.clean}/${session.hands} by the book`}
            </span>
            <span title="How the cards fell versus what your play was worth.">
              LUCK <span className="text-helios-text">{signed(session.fortune, 1)}</span>
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex min-h-[40px] items-center justify-center gap-2">
          {phase === "bet" && (
            <>
              {CHIP_VALUES.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={paused || bet + v > maxBet}
                  onClick={() => addChip(v)}
                  className={
                    "games-num h-10 w-10 rounded-full border-2 border-dashed text-xs font-bold transition-transform enabled:hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-35 " +
                    (v === 5
                      ? "border-helios-dim bg-helios-panel text-helios-text"
                      : v === 25
                        ? "border-asu-gold bg-asu-gold/15 text-asu-gold"
                        : "border-asu-maroon bg-asu-maroon/25 text-[#e8a1b8]")
                  }
                >
                  {v}
                </button>
              ))}
              <button
                type="button"
                disabled={paused || maxBet <= 0 || bet === maxBet}
                onClick={() => setTable({ ...tableRef.current, bet: maxBet })}
                className={lineBtn}
                title="5% of the subteam budget — the most one bet is allowed to be"
              >
                MAX {maxBet}
              </button>
              <button
                type="button"
                disabled={paused || bet === 0}
                onClick={() => setTable({ ...tableRef.current, bet: 0 })}
                className={lineBtn}
              >
                CLEAR
              </button>
              <button type="button" disabled={paused || busy || bet === 0} onClick={() => void deal()} className={goldBtn}>
                DEAL
              </button>
            </>
          )}
          {phase === "player" && (
            <>
              <button type="button" disabled={paused} onClick={hit} className={goldBtn}>
                HIT
              </button>
              <button type="button" disabled={paused} onClick={stand} className={lineBtn}>
                STAND
              </button>
              <button
                type="button"
                disabled={paused || busy || player.length !== 2 || maxBet < bet}
                onClick={() => void doubleDown()}
                className={lineBtn}
              >
                DOUBLE
              </button>
            </>
          )}
          {phase === "settled" &&
            (broke ? (
              <button type="button" disabled={paused} onClick={cashOut} className={goldBtn}>
                LEAVE TABLE
              </button>
            ) : (
              <>
                <button type="button" disabled={paused} onClick={nextHand} className={goldBtn}>
                  NEXT HAND
                </button>
                <button type="button" disabled={paused} onClick={cashOut} className={lineBtn}>
                  CASH OUT
                </button>
              </>
            ))}
        </div>

        {/* Cash-out escape hatch while betting; house rules footnote */}
        <div className="flex items-center justify-between">
          <span
            className="text-[9px] text-helios-dim/80"
            title="These are the subteam's chips, not yours. One bet can never be more than 5% of what the budget holds, and the balance moves when a teammate plays too."
          >
            Dealer stands on 17 · BJ pays 3:2 · rated on decisions, not luck
          </span>
          {phase === "bet" && (
            <button
              type="button"
              disabled={paused}
              onClick={cashOut}
              className="games-display text-[9px] tracking-wider text-helios-dim transition-colors hover:text-asu-gold"
            >
              CASH OUT ▸
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
