import { useEffect, useRef, useState } from "react";
import type { GameProps } from "../types";
import type { BjTable } from "../../api";
import {
  handValue,
  hiLoValue,
  netUnits,
  trueCount,
  type Card,
  type Outcome,
} from "./logic";
import { actionEVs, bestAction, optimalEV, referenceEV, type Action } from "./ev";
import {
  handAdvantage,
  lineEV,
  RATING_REFERENCE_BANKROLL,
} from "./rating";

// The SERVER deals this table. Every action — deal, hit, stand, double — is an
// RPC against a per-player shoe no client can read; settlement is computed in
// the same transaction that draws the cards, and the dealer's hole card does
// not exist client-side until the hand is over. This cabinet renders what it
// is handed and never decides an outcome, exactly as the plinko board animates
// a ball the server already dropped. (v5.6.2 — before this, the shoe was dealt
// client-side and the settle was client-reported.)
//
// INTENTS, NOT CALLS. Every server action is wrapped in a single pending
// intent: {kind, nonce}, minted when the player first asks and retried
// VERBATIM until the server answers. The games.bj_* RPCs replay by nonce, so
// a response lost to a flaky link costs nothing — the next button press
// replays the same intent and gets the same hand back, instead of dealing a
// second hand, drawing a second card, or wedging against the one-open-hand
// index. Grading (the EV coaching) is charged once, when the intent is
// created, so a retried network call can't bill the same decision twice.
//
// What stays client-side is everything that doesn't move money: the EV
// coaching line, the Hi-Lo count over the cards this player has SEEN, and the
// session LUCK number. They read the same reveals the player does.
//
//  * Chips come from the SUBTEAM BUDGET. The stake leaves when the cards come
//    out (bj_deal) and the payout arrives with the settle the server computed.
//    The balance on screen is always the server's answer, never one worked out
//    here.
//  * Leaving mid-hand FORFEITS the bet, same as walking away from a live
//    table. The cabinet forfeits any hand it finds still open on mount.
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
/** A brand-new 4-deck shoe minus the four cards a deal consumes. */
const FRESH_SHOE_AFTER_DEAL = 4 * 52 - 4;

type Phase = "bet" | "player" | "dealer" | "settled";

type IntentKind = "deal" | "hit" | "stand" | "double";

/** One outstanding server intent. Held until the server answers; every retry
 *  re-sends exactly this, which is what makes the server-side nonce replay
 *  reachable. `tcAtBet` rides along on deals so the count the bet was priced
 *  at survives the retries. */
interface Intent {
  kind: IntentKind;
  nonce: string;
  stake: number;
  tcAtBet: number;
}

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

/** Running totals for the session, all of them player-facing stats. */
interface Session {
  hands: number;
  play: number;
  bet: number;
  risk: number;
  total: number;
  /** Realised result minus what the line was worth — pure luck, shown to the
   *  player as its own number. */
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
  /** Cards left in the server's shoe; null until the server first says. */
  cardsLeft: number | null;
}

const EMPTY_SESSION: Session = {
  hands: 0, play: 0, bet: 0, risk: 0, total: 0, fortune: 0, evLost: 0, clean: 0,
};

const SUIT_CHAR = { S: "♠", H: "♥", D: "♦", C: "♣" } as const;
const ACTION_LABEL: Record<Action, string> = { hit: "HIT", stand: "STAND", double: "DOUBLE" };

function PlayingCard({ card, hidden }: { card?: Card; hidden?: boolean }) {
  if (hidden || !card) return <div className="games-card games-deal games-card-back" />;
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

/** Server cards are {rank,suit} strings from the same 52-card universe this
 *  module draws from; narrow them for the pure helpers. */
function asCards(cards: BjTable["player"]): Card[] {
  return cards as Card[];
}

export function BlackjackGame({ onGameOver, paused, money }: GameProps) {

  // Hi-Lo running count over every card the player has SEEN. The shoe itself
  // lives on the server AND SURVIVES between sessions — so a freshly mounted
  // cabinet joining a mid-shoe game has no honest count until the server
  // reshuffles. `trusted` gates the count-derived numbers until then.
  const runningRef = useRef(0);
  const countTrustedRef = useRef(false);

  const [table, setTable] = useState<Table>(() => ({
    phase: "bet",
    bankroll: money?.balance ?? 0,
    betId: null,
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
    cardsLeft: null,
  }));
  const ended = useRef(false);
  // Same pattern as 2048: mirror state into a ref so the keydown handler and
  // dealer timer read the latest table without re-registering per render.
  const tableRef = useRef(table);
  tableRef.current = table;
  /** An RPC is in flight — blocks a second one racing it out. A ref because
   *  the guard has to be synchronous; `busy` mirrors it for the UI. */
  const acting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);
  function setActing(v: boolean) {
    acting.current = v;
    setBusy(v);
  }
  /** The settled table the dealer animation is revealing toward. */
  const revealRef = useRef<BjTable | null>(null);
  /** The one outstanding server intent (see the header). Cleared only when
   *  the server answers; a failed call leaves it in place so the next press
   *  retries the SAME nonce instead of minting a new action. */
  const intentRef = useRef<Intent | null>(null);

  // The budget moves under this cabinet whenever a teammate plays, so take the
  // module's number whenever it changes — except while our own round trip or
  // the dealer reveal is the fresher truth (the payout must not flash onto the
  // rail before the cards that earned it are face up; same fix plinko got in
  // 5.6.1).
  useEffect(() => {
    if (!money || acting.current || tableRef.current.phase === "dealer") return;
    setTable((t) => (t.bankroll === money.balance ? t : { ...t, bankroll: money.balance }));
  }, [money?.balance]); // eslint-disable-line react-hooks/exhaustive-deps

  // A hand left open by a previous session (crash, closed window, machine
  // asleep mid-deal) is FORFEIT — walking away from a live table. Clear it on
  // mount so the table can be dealt again.
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

  /** Fold newly revealed cards into the running count, resetting first when
   *  the server reshuffled before dealing them. A reshuffle also makes the
   *  count trustworthy: from here on we have seen every card that left it. */
  function see(reshuffled: boolean, ...cards: Card[]) {
    if (reshuffled) {
      runningRef.current = 0;
      countTrustedRef.current = true;
    }
    for (const c of cards) runningRef.current += hiLoValue(c);
  }

  /** Charge the player for a decision that wasn't the best one available.
   *  Called exactly once per decision, when its intent is CREATED — a retried
   *  network call must not bill the same choice twice. */
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

  /** Apply a SETTLED server table: session stats, record, bankroll. The
   *  outcome and payout are the server's — this only does the bookkeeping.
   *  `countRemainder` is false when the caller already consumed the response's
   *  reveal/reshuffle (the deal-natural path counts its own cards). */
  function applySettled(t: Table, res: BjTable, countRemainder = true): Table {
    const player = asCards(res.player);
    const dealer = asCards(res.dealer);
    const outcome = (res.outcome ?? "lose") as Outcome;
    const payout = res.payout ?? 0;

    // The up card was counted at the deal; the hole and any draws become
    // visible exactly now. A mid-hand reshuffle voids the count instead —
    // the revealed cards straddle two shoes.
    if (countRemainder) {
      if (res.reshuffled) {
        runningRef.current = 0;
        countTrustedRef.current = true;
      } else {
        see(false, ...dealer.slice(1));
      }
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
          (netUnits(payout, res.stake, live.initialBet) - evLine) * (live.initialBet / TABLE_MIN),
        evLost: session.evLost + live.evLost,
        clean: session.clean + (live.evLost <= 1e-9 ? 1 : 0),
      };
    }

    return {
      ...t,
      phase: "settled",
      bankroll: res.balance,
      bet: res.stake,
      player,
      dealer,
      holeShown: true,
      outcome,
      session,
      wins: t.wins + (outcome === "win" || outcome === "blackjack" ? 1 : 0),
      losses: t.losses + (outcome === "lose" ? 1 : 0),
      pushes: t.pushes + (outcome === "push" ? 1 : 0),
      cardsLeft: res.cardsLeft,
    };
  }

  /** Route a settled server table either straight onto the felt (a bust only
   *  flips the hole) or through the dealer reveal, which always gets its beat:
   *  flip the hole on one tick, lay each draw on the next, settle on the last. */
  function receiveSettled(t: Table, res: BjTable): Table {
    if (handValue(asCards(res.player)).total > 21) {
      return applySettled(t, res);
    }
    revealRef.current = res;
    return {
      ...t,
      phase: "dealer",
      player: asCards(res.player),
      bet: res.stake,
      dealer: asCards(res.dealer).slice(0, 2),
      holeShown: false,
    };
  }

  /** Handle the server's answer to an intent. All four kinds resolve here so
   *  a replayed intent lands exactly like a first answer. */
  function applyResponse(intent: Intent, res: BjTable) {
    const t = tableRef.current;
    const player = asCards(res.player);

    if (intent.kind === "deal") {
      const dealerUp = asCards(res.dealer)[0]!;
      see(res.reshuffled || res.cardsLeft === FRESH_SHOE_AFTER_DEAL,
        player[0]!, player[1]!, dealerUp);
      const live: LiveHand = {
        opening: player.slice(0, 2),
        // Doubling is on the menu only if the budget could take a second stake
        // of the same size — the 5% cap applies to it separately.
        evOptimal: optimalEV(player.slice(0, 2), dealerUp, res.maxBet >= res.stake),
        evLost: 0,
        worst: null,
        initialBet: res.stake,
        trueCountAtBet: res.reshuffled ? 0 : intent.tcAtBet,
      };
      const dealt: Table = {
        ...t,
        phase: "player",
        bankroll: res.balance,
        betId: res.betId,
        baseBet: intent.stake,
        bet: res.stake,
        player,
        dealer: [dealerUp],
        holeShown: false,
        outcome: null,
        live,
        cardsLeft: res.cardsLeft,
      };
      if (res.state === "settled") {
        // A natural (either side): the server settled it at the deal. The
        // player never got a decision, so the hand carries ZERO play margin —
        // the line is pinned to what the reference would have scored from the
        // same spot. The hole becomes visible here, so count it; the reshuffle
        // (if any) was already consumed by the see() above.
        see(false, ...asCards(res.dealer).slice(1));
        const flat = {
          ...dealt,
          live: { ...live, evOptimal: referenceEV(player.slice(0, 2), dealerUp) },
        };
        setTable(applySettled(flat, res, false));
        return;
      }
      setTable(dealt);
      return;
    }

    // hit / stand / double. The newly drawn player card (hit, double) becomes
    // visible with this response — count it exactly once, replay or not: a
    // replayed intent means the FIRST response was lost, so nothing was
    // counted for it.
    if (intent.kind !== "stand" && player.length > t.player.length) {
      see(res.reshuffled && res.state === "player", player[player.length - 1]!);
    }

    if (res.state === "player") {
      // Only a hit leaves the hand open. Auto-stand a 21 — nothing left to
      // decide, exactly as the old table auto-moved to the dealer.
      setTable({ ...t, player, bet: res.stake, cardsLeft: res.cardsLeft });
      if (handValue(player).total === 21) {
        intentRef.current = {
          kind: "stand", nonce: crypto.randomUUID(), stake: 0, tcAtBet: 0,
        };
        void runIntent();
      }
      return;
    }
    setTable(receiveSettled(t, res));
  }

  /** Send the outstanding intent. On failure the intent SURVIVES — the next
   *  press of any action button retries it verbatim and the server replays. */
  async function runIntent(): Promise<void> {
    const intent = intentRef.current;
    if (!intent || !money || acting.current || ended.current) return;
    const betId = tableRef.current.betId;
    if (intent.kind !== "deal" && !betId) {
      intentRef.current = null;
      return;
    }
    setActing(true);
    let res: BjTable;
    try {
      res =
        intent.kind === "deal" ? await money.deal(intent.stake, intent.nonce)
        : intent.kind === "hit" ? await money.hit(betId!, intent.nonce)
        : intent.kind === "stand" ? await money.stand(betId!, intent.nonce)
        : await money.double(betId!, intent.nonce);
    } catch (e) {
      setActing(false);
      setTableError(e instanceof Error ? e.message : "the house said no");
      return;
    }
    setActing(false);
    setTableError(null);
    intentRef.current = null;
    if (ended.current) return;
    applyResponse(intent, res);
  }

  /** True when an unanswered intent was retried instead of starting `kind`. */
  function retriedPending(): boolean {
    if (!intentRef.current) return false;
    void runIntent();
    return true;
  }

  function deal() {
    const t = tableRef.current;
    if (ended.current || acting.current || !money) return;
    if (retriedPending()) return;
    if (t.phase !== "bet" || t.bet <= 0 || t.bet > money.maxBet) return;
    intentRef.current = {
      kind: "deal",
      nonce: crypto.randomUUID(),
      stake: t.bet,
      // Sampled at intent creation: the whole information set the bet could
      // legitimately have been based on. Zero until the count is trustworthy
      // (a remounted cabinet joins a shoe it never saw the start of).
      tcAtBet: countTrustedRef.current
        ? trueCount(runningRef.current, Math.max(1, t.cardsLeft ?? 4 * 52))
        : 0,
    };
    void runIntent();
  }

  function hit() {
    const t = tableRef.current;
    if (ended.current || acting.current) return;
    if (retriedPending()) return;
    if (t.phase !== "player" || !t.betId) return;
    setTable(grade(t, "hit"));
    intentRef.current = { kind: "hit", nonce: crypto.randomUUID(), stake: 0, tcAtBet: 0 };
    void runIntent();
  }

  function stand() {
    const t = tableRef.current;
    if (ended.current || acting.current) return;
    if (retriedPending()) return;
    if (t.phase !== "player" || !t.betId) return;
    setTable(grade(t, "stand"));
    intentRef.current = { kind: "stand", nonce: crypto.randomUUID(), stake: 0, tcAtBet: 0 };
    void runIntent();
  }

  function doubleDown() {
    const t = tableRef.current;
    if (ended.current || acting.current || !money) return;
    if (retriedPending()) return;
    if (t.phase !== "player" || t.player.length !== 2 || !t.betId) return;
    setTable(grade(t, "double"));
    intentRef.current = { kind: "double", nonce: crypto.randomUUID(), stake: 0, tcAtBet: 0 };
    void runIntent();
  }

  function nextHand() {
    const t = tableRef.current;
    if (ended.current || t.phase !== "settled" || intentRef.current) return;
    if (!money || money.maxBet <= 0) return;
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
    // through the server-dealt RPCs. There is no score and no rating to
    // submit, so leaving the table just ends the session.
    onGameOver(0);
  }

  function addChip(v: number) {
    // Touching the chips is the player acknowledging whatever went wrong last
    // time; leaving a stale refusal on screen just makes the table look broken.
    if (tableError) setTableError(null);
    const t = tableRef.current;
    if (ended.current || t.phase !== "bet" || intentRef.current) return;
    if (t.bet + v > (money?.maxBet ?? 0)) return;
    setTable({ ...t, bet: t.bet + v });
  }

  // The dealer reveal: the hand is already settled server-side; this lays the
  // cards out at table pace — flip the hole, then one draw per tick — and only
  // then shows the outcome and the chips. Pausing simply stops the next tick.
  useEffect(() => {
    if (table.phase !== "dealer" || paused || ended.current) return;
    const id = setTimeout(() => {
      const t = tableRef.current;
      const reveal = revealRef.current;
      if (t.phase !== "dealer" || !reveal) return;
      const full = asCards(reveal.dealer);
      if (!t.holeShown) {
        setTable({ ...t, holeShown: true });
      } else if (t.dealer.length < full.length) {
        setTable({ ...t, dealer: full.slice(0, t.dealer.length + 1) });
      } else {
        revealRef.current = null;
        setTable(applySettled(t, reveal));
      }
    }, DEALER_DRAW_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.phase, table.dealer, table.holeShown, paused]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (paused || ended.current) return;
      const t = tableRef.current;
      const k = e.key.toLowerCase();
      if (t.phase === "player") {
        if (k === "h") { e.preventDefault(); hit(); }
        else if (k === "s") { e.preventDefault(); stand(); }
        else if (k === "d") { e.preventDefault(); doubleDown(); }
      } else if (e.key === "Enter") {
        if (t.phase === "bet" && t.bet > 0) { e.preventDefault(); deal(); }
        else if (t.phase === "settled") { e.preventDefault(); nextHand(); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const { phase, bankroll, bet, player, dealer, holeShown, outcome, session, live } = table;
  const maxBet = money?.maxBet ?? 0;
  // "Broke" is a SUBTEAM-wide condition: the budget can no longer cover a
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
              {dealer.length === 0 ? "—"
                : dealer.length === 1 || !holeShown ? totalLabel([dealer[0]!])
                : totalLabel(dealer)}
            </span>
          </div>
          <div className="mt-1 flex min-h-[68px] items-center">
            {dealer.map((c, i) => (
              // Remount the hole card when it flips so it plays the deal-in.
              <PlayingCard key={i === 1 ? `1-${holeShown ? "up" : "down"}` : i} card={c} hidden={i === 1 && !holeShown} />
            ))}
            {/* The hole card exists only on the server while the hand is live,
                but the table should still look like blackjack: draw its back. */}
            {phase === "player" && dealer.length === 1 && <PlayingCard hidden />}
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
              refused bet has to be visible — the whole subteam sees the
              consequence in the ledger either way. */}
          {tableError ? (
            <span className="text-[10px] normal-case tracking-normal text-red-300">
              {tableError}
            </span>
          ) : busy ? (
            <span className="games-pulse text-helios-dim">THE HOUSE IS DEALING…</span>
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

        {/* Coaching line — say which decision cost you and what the chart
            wanted instead. Reserved height. */}
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
          <span>SHOE <span className="text-helios-text">{table.cardsLeft ?? "—"}</span></span>
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
                disabled={paused || busy || maxBet <= 0 || bet === maxBet}
                onClick={() => {
                  // Same pending-intent guard as addChip: an unanswered deal
                  // retries with ITS stake, so the rail must not drift.
                  if (intentRef.current) return;
                  setTable({ ...tableRef.current, bet: maxBet });
                }}
                className={lineBtn}
                title="5% of the subteam budget — the most one bet is allowed to be"
              >
                MAX {maxBet}
              </button>
              <button
                type="button"
                disabled={paused || busy || bet === 0}
                onClick={() => {
                  if (intentRef.current) return;
                  setTable({ ...tableRef.current, bet: 0 });
                }}
                className={lineBtn}
              >
                CLEAR
              </button>
              <button type="button" disabled={paused || busy || bet === 0} onClick={deal} className={goldBtn}>
                DEAL
              </button>
            </>
          )}
          {phase === "player" && (
            <>
              <button type="button" disabled={paused || busy} onClick={hit} className={goldBtn}>
                HIT
              </button>
              <button type="button" disabled={paused || busy} onClick={stand} className={lineBtn}>
                STAND
              </button>
              <button
                type="button"
                disabled={paused || busy || player.length !== 2 || maxBet < bet}
                onClick={doubleDown}
                className={lineBtn}
                title={
                  maxBet < bet
                    ? "Doubling debits a SECOND stake this size, and the 5% cap must cover it on its own — the budget can't right now"
                    : "Double the stake, take exactly one more card"
                }
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
            title="These are the subteam's chips, not yours. The server deals every card and settles every hand. One bet can never be more than 5% of what the budget holds, and the balance moves when a teammate plays too."
          >
            Dealer stands on 17 · BJ pays 3:2 · the house deals
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
