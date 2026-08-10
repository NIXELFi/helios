import { useEffect, useRef, useState } from "react";
import type { GameProps } from "../types";
import {
  createShoe,
  dealerShouldHit,
  eloUpdate,
  handValue,
  isBlackjack,
  outcomeEloScore,
  settle,
  DECKS,
  ELO_START,
  RESHUFFLE_BELOW,
  type Card,
  type Outcome,
} from "./logic";

const START_BANKROLL = 200;
const CHIP_VALUES = [5, 25, 100] as const;
const DEALER_DRAW_MS = 450;

type Phase = "bet" | "player" | "dealer" | "settled";

interface Table {
  phase: Phase;
  bankroll: number;
  /** Staged wager in the bet phase; the live stake (doubled if doubled) once dealt. */
  bet: number;
  /** Pre-double stake — carried into the next hand as the default re-bet. */
  baseBet: number;
  player: Card[];
  dealer: Card[];
  holeShown: boolean;
  outcome: Outcome | null;
  elo: number; // float; rounded only for display/submission
  delta: number | null; // last hand's rating change
  wins: number;
  losses: number;
  pushes: number;
  cardsLeft: number;
}

const SUIT_CHAR = { S: "♠", H: "♥", D: "♦", C: "♣" } as const;

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

export function BlackjackGame({ onGameOver, paused }: GameProps) {
  // Shoe is draw-only mutable state the UI never maps over — a ref keeps the
  // multi-draw actions (deal = four pops) simple; cardsLeft mirrors it for
  // display.
  const shoeRef = useRef<Card[] | null>(null);
  if (!shoeRef.current) shoeRef.current = createShoe(Math.random);

  const [table, setTable] = useState<Table>(() => ({
    phase: "bet",
    bankroll: START_BANKROLL,
    bet: 0,
    baseBet: 0,
    player: [],
    dealer: [],
    holeShown: false,
    outcome: null,
    elo: ELO_START,
    delta: null,
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

  function draw(): Card {
    const shoe = shoeRef.current!;
    if (shoe.length === 0) shoeRef.current = createShoe(Math.random); // unreachable with the between-hand reshuffle; belt-and-braces
    return shoeRef.current!.pop()!; // non-empty by the line above
  }

  /** Settle the hand into a new table state (rating, record, bankroll). */
  function settled(t: Table, player: Card[], dealer: Card[]): Table {
    const { outcome, payout } = settle(player, dealer, t.bet);
    const s = outcomeEloScore(outcome);
    const elo = eloUpdate(t.elo, s);
    return {
      ...t,
      phase: "settled",
      player,
      dealer,
      holeShown: true,
      outcome,
      elo,
      delta: elo - t.elo,
      wins: t.wins + (s === 1 ? 1 : 0),
      losses: t.losses + (s === 0 ? 1 : 0),
      pushes: t.pushes + (s === 0.5 ? 1 : 0),
      bankroll: t.bankroll + payout,
      cardsLeft: shoeRef.current!.length,
    };
  }

  function deal() {
    const t = tableRef.current;
    if (ended.current || t.phase !== "bet" || t.bet <= 0 || t.bet > t.bankroll) return;
    if (shoeRef.current!.length < RESHUFFLE_BELOW) shoeRef.current = createShoe(Math.random);
    const player = [draw(), draw()];
    const dealer = [draw(), draw()];
    const dealt: Table = {
      ...t,
      phase: "player",
      bankroll: t.bankroll - t.bet,
      baseBet: t.bet,
      player,
      dealer,
      holeShown: false,
      outcome: null,
      delta: null,
      cardsLeft: shoeRef.current!.length,
    };
    // Naturals settle on the spot — no double into a dealer blackjack.
    setTable(isBlackjack(player) || isBlackjack(dealer) ? settled(dealt, player, dealer) : dealt);
  }

  function hit() {
    const t = tableRef.current;
    if (ended.current || t.phase !== "player") return;
    const player = [...t.player, draw()];
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
    const t = tableRef.current;
    if (ended.current || t.phase !== "player") return;
    setTable({ ...t, phase: "dealer", holeShown: true });
  }

  function doubleDown() {
    const t = tableRef.current;
    if (ended.current || t.phase !== "player" || t.player.length !== 2 || t.bankroll < t.bet) return;
    const doubled: Table = { ...t, bankroll: t.bankroll - t.bet, bet: t.bet * 2 };
    const player = [...t.player, draw()];
    setTable(
      handValue(player).total > 21
        ? settled(doubled, player, t.dealer)
        : { ...doubled, player, phase: "dealer", holeShown: true, cardsLeft: shoeRef.current!.length },
    );
  }

  function nextHand() {
    const t = tableRef.current;
    if (ended.current || t.phase !== "settled" || t.bankroll <= 0) return;
    setTable({
      ...t,
      phase: "bet",
      bet: Math.min(t.baseBet, t.bankroll),
      player: [],
      dealer: [],
      holeShown: false,
      outcome: null,
    });
  }

  function cashOut() {
    const t = tableRef.current;
    if (ended.current || (t.phase !== "bet" && t.phase !== "settled")) return;
    ended.current = true;
    onGameOver(Math.max(0, Math.round(t.elo)));
  }

  function addChip(v: number) {
    const t = tableRef.current;
    if (ended.current || t.phase !== "bet" || t.bet + v > t.bankroll) return;
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
        setTable({ ...t, dealer: [...t.dealer, draw()], cardsLeft: shoeRef.current!.length });
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
        else if (k === "d") { e.preventDefault(); doubleDown(); }
      } else if (e.key === "Enter") {
        if (t.phase === "bet" && t.bet > 0) { e.preventDefault(); deal(); }
        else if (t.phase === "settled" && t.bankroll > 0) { e.preventDefault(); nextHand(); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const { phase, bankroll, bet, player, dealer, holeShown, outcome, elo, delta } = table;
  const broke = phase === "settled" && bankroll <= 0;

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
        {/* Rating rail — the actual score of this game */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="games-display text-[10px] text-helios-dim">ELO</span>
            <span className="games-num text-lg font-bold text-asu-gold">{Math.round(elo)}</span>
            {delta !== null && (
              <span className={`games-num text-[11px] ${delta >= 0 ? "text-asu-gold" : "text-red-300"}`}>
                {delta >= 0 ? "+" : ""}{delta.toFixed(1)}
              </span>
            )}
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
          {phase === "bet" && <span className="text-helios-dim">PLACE YOUR BET</span>}
          {phase === "player" && <span className="text-helios-dim">HIT · STAND · DOUBLE</span>}
          {phase === "dealer" && <span className="games-pulse text-helios-dim">DEALER DRAWS…</span>}
          {phase === "settled" && outcomeLine && <span className={outcomeLine.cls}>{outcomeLine.text}</span>}
        </div>

        {/* Money rail */}
        <div className="games-num flex items-center justify-between text-[10px] text-helios-dim">
          <span>BANK <span className="font-bold text-helios-text">{bankroll}</span></span>
          <span>BET <span className="font-bold text-asu-gold">{bet}</span></span>
          <span>SHOE <span className="text-helios-text">{table.cardsLeft}</span></span>
        </div>

        {/* Actions */}
        <div className="flex min-h-[40px] items-center justify-center gap-2">
          {phase === "bet" && (
            <>
              {CHIP_VALUES.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={paused || bet + v > bankroll}
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
                disabled={paused || bet === bankroll}
                onClick={() => setTable({ ...tableRef.current, bet: bankroll })}
                className={lineBtn}
              >
                ALL-IN
              </button>
              <button
                type="button"
                disabled={paused || bet === 0}
                onClick={() => setTable({ ...tableRef.current, bet: 0 })}
                className={lineBtn}
              >
                CLEAR
              </button>
              <button type="button" disabled={paused || bet === 0} onClick={deal} className={goldBtn}>
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
                disabled={paused || player.length !== 2 || bankroll < bet}
                onClick={doubleDown}
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
          <span className="text-[9px] text-helios-dim/80">
            Dealer stands on 17 · BJ pays 3:2 · score is your Elo vs the house
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
