import { useEffect, useRef, useState } from "react";
import { useGameLoop } from "../../lib/useGameLoop";
import type { GameProps } from "../types";
import {
  MULTIPLIER_CENTS, RISKS, RISK_LABEL, ROW_OPTIONS,
  ballTrack, bucketChance, pegRows, rtp,
  type Risk, type Rows,
} from "./logic";

// The plinko cabinet. Everything the player sees here is an ANIMATION of a
// result the server already committed: games.plinko_drop rolled the path,
// resolved the bucket, moved the chips and wrote the ledger row before this
// component learned the ball existed. Nothing on this screen can change where
// a ball lands, which is the whole point of it spending shared money.

const W = 400;
const BOARD_H = 300;
const ROWS_PER_SEC = 11; // ~1.5s for a 16-row drop
const CHIPS = [5, 25, 100] as const;

interface Ball {
  id: number;
  track: number[];
  /** Rows fallen so far, fractional. */
  t: number;
  bucket: number;
  cents: number;
  net: number;
  /** The settled balance this drop produced, held until the ball LANDS. The
   *  server answers in milliseconds but the ball takes a second or two to
   *  fall, and paying out before it lands shows the result of a drop the
   *  player is still watching. */
  balance: number;
  maxBet: number;
  /** Ordering token, so a slow drop landing late can't overwrite a newer
   *  drop's balance. Same discipline the poll uses. */
  seq: number;
  /** What this drop cost. A ball that lands while LATER balls are still in
   *  the air carries a balance from before those stakes left, so their
   *  stakes are subtracted back off at landing. */
  stake: number;
}

interface Landed {
  id: number;
  bucket: number;
  cents: number;
  net: number;
  /** Seconds left on the bucket's flash. */
  flash: number;
}

/** Bucket colour by how it pays: dim when it takes chips off you, gold when it
 *  gives them back, hot maroon out in the tail. */
function bucketColor(cents: number): string {
  if (cents < 100) return "#4a4f5c";
  if (cents < 200) return "#c9a227";
  if (cents < 600) return "#e8a33d";
  return "#8c1d40";
}
function bucketText(cents: number): string {
  return cents < 100 ? "#9aa0ad" : cents < 600 ? "#17181c" : "#f6e7ec";
}

/** Multipliers read as "0.21x" / "1.7x" / "50x" — trailing zeros are noise. */
function xLabel(cents: number): string {
  const v = cents / 100;
  return `${v >= 10 ? v.toFixed(0) : v >= 1 ? String(v) : v.toFixed(2)}x`;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function PlinkoGame({ paused, money }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rows, setRows] = useState<Rows>(12);
  const [risk, setRisk] = useState<Risk>("med");
  const [stake, setStake] = useState(25);
  const [balance, setBalance] = useState(money?.balance ?? 0);
  const [maxBet, setMaxBet] = useState(money?.maxBet ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: number; cents: number; net: number }[]>([]);
  const [inFlight, setInFlight] = useState(0);

  const balls = useRef<Ball[]>([]);
  const landed = useRef<Landed[]>([]);
  const nextId = useRef(1);
  // Responses can arrive out of order, and teammates move the balance too, so
  // only the newest reply is allowed to set the displayed balance. Without
  // this a slow first drop could overwrite a fast second drop's balance and
  // show the subteam more chips than it has.
  const seq = useRef(0);
  const applied = useRef(0);

  const multipliers = MULTIPLIER_CENTS[rows][risk];
  const bucketW = W / (rows + 1);
  const rowH = BOARD_H / (rows + 1);

  // Keep the stake legal as the budget moves under us (a teammate's bad night
  // can drop the cap below what's staged here).
  useEffect(() => {
    setStake((s) => Math.max(1, Math.min(s, maxBet)));
  }, [maxBet]);

  // Shared money is only shared if you can see it move. The module polls the
  // budget while a money cabinet is open (it owns the client) and re-renders us
  // with what it finds, so a teammate playing at another desk shows up here as
  // a moving number rather than as a surprise rejection.
  //
  // A poll result must never overwrite a NEWER drop reply, so it only lands if
  // no drop has been answered since — same `applied` guard the drops use.
  useEffect(() => {
    if (!money) return;
    // While anything is falling, the parent's balance ALREADY includes the
    // payout for those balls — it banked the server's answer the moment it
    // arrived. Applying it here would pay the player before the ball lands,
    // which is the whole thing the ball is carrying its own balance to avoid.
    // The landing applies the authoritative number; the next poll re-syncs.
    if (balls.current.length > 0) return;
    const mine = ++seq.current;
    applied.current = mine;
    setBalance(money.balance);
    setMaxBet(money.maxBet);
  }, [money?.balance, money?.maxBet]); // eslint-disable-line react-hooks/exhaustive-deps

  async function drop() {
    if (!money || paused || stake <= 0 || stake > maxBet) return;
    setError(null);
    const mine = ++seq.current;
    // Spend optimistically so rapid-fire drops can't stage more chips than the
    // budget holds; the server's balance replaces this the moment it answers.
    setBalance((b) => b - stake);
    setInFlight((n) => n + 1);
    try {
      const res = await money.place({ rows, risk, stake }, crypto.randomUUID());
      // The payout rides ON the ball and is applied when it lands, not here.
      // The stake already left above, which is what a drop costs you up front.
      balls.current.push({
        id: nextId.current++,
        track: ballTrack(res.path),
        t: 0,
        bucket: res.bucket,
        cents: res.multiplierCents,
        net: res.net,
        balance: res.balance,
        maxBet: res.maxBet,
        seq: mine,
        stake,
      });
    } catch (e) {
      // The optimistic debit never happened server-side; put it back.
      setBalance((b) => b + stake);
      setError(e instanceof Error ? e.message : "the house said no");
    } finally {
      setInFlight((n) => n - 1);
    }
  }

  useGameLoop((dt) => {
    const bs = balls.current;
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i]!;
      b.t += dt * ROWS_PER_SEC;
      if (b.t >= b.track.length - 1) {
        landed.current.push({ id: b.id, bucket: b.bucket, cents: b.cents, net: b.net, flash: 0.9 });
        setHistory((h) => [{ id: b.id, cents: b.cents, net: b.net }, ...h].slice(0, 8));
        // NOW the chips arrive — same instant the bucket flashes. b.balance is
        // the server's balance as of THIS drop, so anything dropped after it
        // and still falling has already left the budget optimistically but is
        // not reflected in that number; subtract those stakes back off or the
        // balance visibly bounces up between two landings.
        if (b.seq > applied.current) {
          applied.current = b.seq;
          const staked = bs.reduce((sum, o) => (o.seq > b.seq ? sum + o.stake : sum), 0);
          setBalance(b.balance - staked);
          setMaxBet(b.maxBet);
        }
        bs.splice(i, 1);
      }
    }
    for (let i = landed.current.length - 1; i >= 0; i--) {
      const l = landed.current[i]!;
      l.flash -= dt;
      if (l.flash <= 0) landed.current.splice(i, 1);
    }
    draw();
  }, paused);

  // Redraw on board changes even while nothing is falling.
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, risk]);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, BOARD_H + 34);

    const px = (u: number) => (u + 0.5) * bucketW;

    // Pegs
    ctx.fillStyle = "#5b6070";
    for (const [i, row] of pegRows(rows).entries()) {
      const y = rowH * (i + 1);
      for (const u of row) {
        ctx.beginPath();
        ctx.arc(px(u), y, rows > 12 ? 1.6 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Buckets
    const by = BOARD_H + 4;
    const bh = 22;
    for (let k = 0; k <= rows; k++) {
      const cents = multipliers[k]!;
      const flash = landed.current.find((l) => l.bucket === k);
      const x = k * bucketW + 1;
      const w = bucketW - 2;
      ctx.fillStyle = bucketColor(cents);
      if (flash) {
        ctx.globalAlpha = 1;
        ctx.shadowColor = bucketColor(cents);
        ctx.shadowBlur = 14 * flash.flash;
      }
      ctx.fillRect(x, by - (flash ? 2 * flash.flash : 0), w, bh);
      ctx.shadowBlur = 0;
      ctx.fillStyle = bucketText(cents);
      ctx.font = `${rows > 12 ? 7 : 9}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(xLabel(cents), x + w / 2, by + bh / 2);
    }

    // Balls — a small arc between pegs so it reads as bouncing, not sliding.
    for (const b of balls.current) {
      const i = Math.min(Math.floor(b.t), b.track.length - 2);
      const f = Math.min(1, b.t - i);
      const u = b.track[i]! + (b.track[i + 1]! - b.track[i]!) * f;
      const y = rowH * (i + f) + rowH * 0.5 - Math.sin(f * Math.PI) * rowH * 0.28;
      ctx.beginPath();
      ctx.fillStyle = "#ffc627";
      ctx.shadowColor = "#ffc627";
      ctx.shadowBlur = 8;
      ctx.arc(px(u), y, rows > 12 ? 3.4 : 4.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  const chipBtn =
    "games-num h-8 rounded-sm border px-2 text-[10px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-35";
  const tabBtn =
    "games-display rounded-sm border px-2 py-1 text-[9px] tracking-wider transition-colors";
  const centreChance = bucketChance(rows, rows / 2);

  if (!money) {
    return (
      <div className="games-crt">
        <div className="games-display flex h-[510px] w-[400px] items-center justify-center text-[10px] tracking-[0.2em] text-helios-dim">
          <span className="games-pulse">OPENING THE SUBTEAM BUDGET…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="games-crt">
      <div className="flex w-[400px] flex-col gap-2 p-1">
        {/* Money rail — whose chips these are, and the ceiling on one bet */}
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="games-display text-[9px] tracking-[0.2em] text-helios-dim">
              {money.subteam.toUpperCase()}
            </span>
            <span className="games-num text-lg font-bold text-asu-gold">
              {balance.toLocaleString()}
            </span>
          </div>
          <span
            className="games-num text-[10px] text-helios-dim"
            title="One bet can never be more than 5% of the subteam budget"
          >
            MAX BET <span className="text-helios-text">{maxBet}</span>
          </span>
        </div>

        <canvas
          ref={canvasRef}
          width={W}
          height={BOARD_H + 34}
          className="w-full"
          style={{ imageRendering: "auto" }}
        />

        {/* Last few balls, newest first */}
        <div className="flex min-h-[18px] items-center gap-1 overflow-hidden">
          {history.map((h) => (
            <span
              key={h.id}
              className="games-num games-pop rounded-sm px-1.5 py-0.5 text-[9px] font-bold"
              style={{ background: bucketColor(h.cents), color: bucketText(h.cents) }}
              title={`${signed(h.net)} chips`}
            >
              {xLabel(h.cents)}
            </span>
          ))}
          {history.length === 0 && (
            <span className="text-[9px] text-helios-dim/70">no balls dropped yet</span>
          )}
        </div>

        {/* Board setup */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <span className="games-display text-[9px] text-helios-dim">RISK</span>
            {RISKS.map((r) => (
              <button
                key={r}
                type="button"
                disabled={paused}
                onClick={() => setRisk(r)}
                className={
                  tabBtn +
                  (risk === r
                    ? " border-asu-gold bg-asu-gold/15 text-asu-gold"
                    : " border-helios-line text-helios-dim hover:text-helios-text")
                }
              >
                {RISK_LABEL[r]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="games-display text-[9px] text-helios-dim">ROWS</span>
            {ROW_OPTIONS.map((r) => (
              <button
                key={r}
                type="button"
                disabled={paused}
                onClick={() => setRows(r)}
                className={
                  tabBtn +
                  (rows === r
                    ? " border-asu-gold bg-asu-gold/15 text-asu-gold"
                    : " border-helios-line text-helios-dim hover:text-helios-text")
                }
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Stake + drop */}
        <div className="flex items-center gap-2">
          <span className="games-display text-[9px] text-helios-dim">BET</span>
          {CHIPS.map((v) => (
            <button
              key={v}
              type="button"
              disabled={paused || v > maxBet}
              onClick={() => setStake(v)}
              className={
                chipBtn +
                (stake === v
                  ? " border-asu-gold bg-asu-gold text-helios-base"
                  : " border-helios-line bg-transparent text-helios-text hover:border-asu-gold")
              }
            >
              {v}
            </button>
          ))}
          <button
            type="button"
            disabled={paused || maxBet <= 0}
            onClick={() => setStake(maxBet)}
            className={
              chipBtn +
              (stake === maxBet && maxBet > 0
                ? " border-asu-maroon bg-asu-maroon/30 text-[#e8a1b8]"
                : " border-helios-line bg-transparent text-helios-dim hover:border-asu-maroon")
            }
            title="5% of the subteam budget — the most one bet is allowed to be"
          >
            MAX
          </button>
          <button
            type="button"
            disabled={paused || stake <= 0 || stake > maxBet}
            onClick={() => void drop()}
            className="games-display ml-auto rounded-sm border border-asu-gold bg-asu-gold px-4 py-1.5 text-[10px] tracking-wider text-helios-base transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
          >
            DROP {stake}
          </button>
        </div>

        {/* Status line — fixed height so the cabinet never jumps */}
        <div className="min-h-[14px] text-center text-[9px] tracking-wide">
          {error ? (
            <span className="text-red-300">{error}</span>
          ) : inFlight > 0 ? (
            <span className="games-pulse text-helios-dim">DROPPING…</span>
          ) : (
            <span className="text-helios-dim/70">
              {(rtp(rows, risk) * 100).toFixed(1)}% back over time ·{" "}
              {(centreChance * 100).toFixed(1)}% of balls land in the middle
            </span>
          )}
        </div>

        <div className="text-[9px] text-helios-dim/80">
          These are your subteam's chips, not yours · the ball is dropped by the server
        </div>
      </div>
    </div>
  );
}
