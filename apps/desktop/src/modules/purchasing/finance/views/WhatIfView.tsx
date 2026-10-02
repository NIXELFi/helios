import { useEffect, useMemo, useState } from "react";
import { centsToInput, fmtCents, parseCents } from "../../lib/money";
import { Button, Card } from "../../components/ui";
import { dashboard } from "../compute";
import { remaining } from "../../views/ApprovalsView";
import { today } from "../../lib/dates";
import { runWhatIf, whatIfText, type PaidFrom, type WhatIfLine, type WhatIfStart } from "../whatif";
import { Badge, Money, Tile, accountLabel, input, type FinanceProps } from "./shared";

// Scenarios are a scratchpad: kept in this computer's browser storage, never
// in the books, so trying ideas can't change anything.
const KEY = "helios:agora:whatif";
interface Saved { lines: WhatIfLine[]; cushion: number }
function load(): Saved {
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? "") as Saved; if (Array.isArray(s.lines)) return s; } catch { /* nothing saved */ }
  return { lines: [], cushion: 0 };
}
const blank = (): WhatIfLine => ({ id: Math.random().toString(36).slice(2), label: "", cents: 0, direction: "out", paidFrom: "checking", budgetLine: null, on: true });

/** Execs: what Available, the card and the budgets would look like after each big possible expense. */
export function WhatIfView({ fin, pur, flash }: FinanceProps) {
  const [saved, setSaved] = useState<Saved>(load);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* private mode */ } }, [saved]);
  const { lines, cushion } = saved;
  const setLines = (f: (ls: WhatIfLine[]) => WhatIfLine[]) => setSaved((s) => ({ ...s, lines: f(s.lines) }));
  const patch = (id: string, p: Partial<WhatIfLine>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));

  const asOf = today();
  const d = useMemo(() => dashboard(fin, asOf), [fin, asOf]);
  const start: WhatIfStart = useMemo(() => ({
    available: d.summary?.available_cents ?? null,
    cards: Object.fromEntries(d.cards.filter((c) => c.account.active && c.account.credit_limit_cents).map((c) => [c.account.id, { name: accountLabel(c.account), remaining: c.headroom.remaining_cents }])),
    accounts: Object.fromEntries(fin.accounts.filter((a) => a.active && a.kind !== "checking" && a.kind !== "credit_card")
      .map((a) => [a.id, { name: a.name, balance: d.funds.others.find((o) => o.account.id === a.id)?.balance_cents ?? null }])),
    budgets: Object.fromEntries(pur.budgets.filter((b) => b.budget_line_id).map((b) => [b.budget_line_id!, { name: `${b.project_code} ${b.name}`, remaining: remaining(b) }])),
  }), [d, fin, pur.budgets, asOf]);
  const steps = useMemo(() => runWhatIf(start, lines, cushion), [start, lines, cushion]);
  const stepOf = (id: string) => steps.find((s) => s.line.id === id);
  const last = [...steps].reverse().find((s) => !s.account);
  // every account together, as the Overview's Available to spend: each ticked line moves it by its amount
  const totalNow = d.funds.total_cents;
  const totalAfter = totalNow === null ? null : totalNow + steps.reduce((t, s) => t + (s.line.direction === "out" ? -1 : 1) * s.line.cents, 0);
  const sources: [PaidFrom, string][] = [
    ["checking", `${d.checking?.name ?? "Checking"} (cash or check)`],
    ...Object.entries(start.cards).map(([id, c]) => [`card:${id}`, c.name] as [PaidFrom, string]),
    ...Object.entries(start.accounts).map(([id, a]) => [`account:${id}`, a.name] as [PaidFrom, string]),
  ];
  const firstCard = Object.values(start.cards)[0];
  const scale = Math.max(start.available ?? 0, ...steps.map((s) => s.available ?? 0), 1);

  function move(id: string, by: number) {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.id === id), j = i + by;
      if (j < 0 || j >= ls.length) return ls;
      const out = [...ls]; [out[i], out[j]] = [out[j]!, out[i]!]; return out;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-helios-dim">
        Try out big possible expenses (or money coming in) before committing to them. Each ticked line builds on the ones above it, starting from
        today's figures on the Overview. Nothing here touches the books; the list is kept on this computer only.
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile hero label="All accounts after" value={<Money cents={totalAfter} />}
          note={totalNow !== null && totalAfter !== null ? `Available to spend now ${fmtCents(totalNow)}, ASU accounts included${totalAfter !== totalNow ? `; ${totalAfter - totalNow >= 0 ? "+" : ""}${fmtCents(totalAfter - totalNow)}` : ""}` : "No Chase balance yet"} />
        <Tile label={`${d.checking?.name ?? "Checking"} available after`} value={<Money cents={last ? last.available : start.available} />}
          note={last && start.available !== null && last.available !== null ? `${last.available - start.available >= 0 ? "+" : ""}${fmtCents(last.available - start.available)} from the ticked lines` : "Add a line below"} />
        <Tile label="Card left this cycle" value={<Money cents={firstCard?.remaining} />} note={firstCard ? firstCard.name : "No card"} />
        <div className="rounded-lg border border-helios-line bg-helios-panel p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-helios-dim">Cushion to keep</div>
          <input className={`${input} mt-2 w-32 text-right`} defaultValue={cushion ? centsToInput(cushion) : ""} placeholder="$0.00"
            onChange={(e) => { const c = e.target.value.trim() ? parseCents(e.target.value) : 0; if (c !== null) setSaved((s) => ({ ...s, cushion: Math.abs(c) })); }}
            onBlur={(e) => { if (e.target.value.trim() && parseCents(e.target.value) === null) flash(`"${e.target.value}" isn't an amount.`, true); }} />
          <div className="mt-1 text-xs text-helios-dim">Warns when Available would drop below it</div>
        </div>
      </div>

      <Card className="p-0">
        <div className="flex flex-col">
          {lines.map((l, i) => {
            const s = stepOf(l.id);
            return (
              <div key={l.id} className={`flex flex-col gap-2 border-b border-helios-line px-3 py-2.5 ${l.on ? "" : "opacity-50"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <input type="checkbox" checked={l.on} onChange={(e) => patch(l.id, { on: e.target.checked })} aria-label="Include this line" title="Include this line" />
                  <input className={`${input} min-w-[180px] flex-1`} placeholder="e.g. New engine, trailer, comp registration" value={l.label} onChange={(e) => patch(l.id, { label: e.target.value })} />
                  <select className={input} value={l.direction} onChange={(e) => patch(l.id, { direction: e.target.value as "out" | "in", budgetLine: e.target.value === "in" ? null : l.budgetLine })}>
                    <option value="out">Spend</option><option value="in">Money in</option>
                  </select>
                  <input className={`${input} w-28 text-right`} placeholder="$0.00" defaultValue={l.cents ? centsToInput(l.cents) : ""}
                    onChange={(e) => { const c = e.target.value.trim() ? parseCents(e.target.value) : 0; if (c !== null) patch(l.id, { cents: Math.abs(c) }); }}
                    onBlur={(e) => { if (e.target.value.trim() && parseCents(e.target.value) === null) flash(`"${e.target.value}" isn't an amount.`, true); }} />
                  <label className="flex items-center gap-1 text-xs text-helios-dim">{l.direction === "out" ? "from" : "into"}
                    <select className={`${input} max-w-[220px]`} value={l.paidFrom} onChange={(e) => patch(l.id, { paidFrom: e.target.value as PaidFrom })}>
                      {sources.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                    </select>
                  </label>
                  {l.direction === "out" && (
                    <label className="flex items-center gap-1 text-xs text-helios-dim">budget
                      <select className={`${input} max-w-[200px]`} value={l.budgetLine ?? ""} onChange={(e) => patch(l.id, { budgetLine: e.target.value || null })}>
                        <option value="">(none)</option>
                        {Object.entries(start.budgets).map(([k, b]) => <option key={k} value={k}>{b.name}</option>)}
                      </select>
                    </label>
                  )}
                  <span className="ml-auto whitespace-nowrap">
                    <button className="px-1 text-helios-dim hover:text-helios-text disabled:opacity-30" disabled={i === 0} onClick={() => move(l.id, -1)} title="Earlier">^</button>
                    <button className="px-1 text-helios-dim hover:text-helios-text disabled:opacity-30" disabled={i === lines.length - 1} onClick={() => move(l.id, 1)} title="Later">v</button>
                    <button className="px-1 text-helios-dim hover:text-helios-danger" onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))} title="Remove">x</button>
                  </span>
                </div>
                {s && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-6 text-xs">
                    {s.account ? <span className="text-helios-dim">Available unchanged</span> : (
                      <span className="flex items-center gap-2">Available after <b className="text-sm"><Money cents={s.available} signed={s.available !== null && s.available < 0} /></b>
                        {s.available !== null && <span className="inline-block h-1.5 w-28 overflow-hidden rounded-full bg-helios-strip">
                          <span className={`block h-full ${s.available < 0 ? "bg-helios-danger" : s.available < cushion ? "bg-asu-gold" : "bg-helios-success"}`}
                            style={{ width: `${Math.max(0, Math.min(100, (s.available / scale) * 100))}%` }} /></span>}
                      </span>
                    )}
                    {s.card && <span>{s.card.name}: <b>{fmtCents(s.card.remaining)}</b> left this cycle</span>}
                    {s.account && <span>{s.account.name}: <b>{s.account.balance === null ? "balance unknown" : fmtCents(s.account.balance)}</b> left</span>}
                    {s.budget && <span>{s.budget.name}: <b>{fmtCents(s.budget.remaining)}</b> left</span>}
                    {s.warnings.map((w) => <Badge key={w} tone={/can't afford|short|over/.test(w) ? "bad" : "warn"}>{w}</Badge>)}
                    {!s.warnings.length && <Badge tone="good">fits</Badge>}
                  </div>
                )}
              </div>
            );
          })}
          {!lines.length && <div className="p-6 text-center text-sm text-helios-dim">No scenarios yet. Add the big things you're weighing up.</div>}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-helios-line p-3">
          <Button onClick={() => setLines((ls) => [...ls, blank()])}>+ Add a line</Button>
          {lines.length > 0 && <>
            <Button kind="ghost" onClick={() => { void navigator.clipboard.writeText(whatIfText(start, steps)); flash("Copied: paste it into the meeting notes."); }}>Copy as text</Button>
            <Button kind="ghost" onClick={() => setLines(() => [])}>Clear all</Button>
          </>}
        </div>
      </Card>
      <p className="text-xs text-helios-dim">
        Spending from checking or a card lowers Available (a card charge is paid from checking). Spending from another account (dean's funding,
        the gift account) uses that account's last weekly balance instead. Budget lines show what's left after spent and committed. It's a rough
        guide: it doesn't know about money that's due but not entered yet.
      </p>
    </div>
  );
}
