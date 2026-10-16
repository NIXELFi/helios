import { useMemo, useState } from "react";
import { fmtCents } from "../../lib/money";
import { Button, Empty } from "../../components/ui";
import { RECEIPT_TYPES, attachDocument, linkEvidence, linkItem, resolveDiscrepancy, setAllocations, updateTxn } from "../api";
import { allEvidence } from "../compute";
import { REQUEST_KINDS, claimsACharge, type Evidence } from "../discrepancies";
import { GAPS, GAP_LABEL, canWaiveAll, gapCounts, looseEnds, waivableKeys, type Gap, type GapInfo, type LooseEnd } from "../looseEnds";
import { Badge, Money, WherePicker, accountLabel, attempt, input, shortDate, whereLabel, type FinanceProps } from "./shared";

type Sort = "newest" | "oldest" | "biggest";
const FIX_FIRST: ReadonlySet<Gap> = new Set(["category", "split"]);

/**
 * Every ledger line that isn't squared away yet, with what's missing on each
 * and a quick way to fix it right there. Work down the list: a line drops off
 * once it has a category, a subteam, its receipt and its part (or an exec
 * says why it doesn't need them).
 */
export function LooseEndsView(props: FinanceProps) {
  const { fin, pur, openTxn } = props;
  const where = whereLabel(pur);
  const evidence = useMemo(() => allEvidence(fin, pur.items, where), [fin, pur.items]);
  const resolved = useMemo(() => new Set(fin.resolutions.map((r) => r.key)), [fin.resolutions]);
  const all = useMemo(() => looseEnds(fin.txns, evidence, resolved), [fin.txns, evidence, resolved]);
  const counts = gapCounts(all);

  const [gap, setGap] = useState<Gap | "">("");
  const [account, setAccount] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const rows = all.filter((e) => (!gap || e.gaps.some((g) => g.gap === gap))
    && (!account || String(e.txn.account_id) === account)
    && (!q || `${e.txn.description} ${e.txn.vendor ?? ""} ${e.txn.notes} ${e.txn.reference ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  if (sort === "oldest") rows.reverse();
  if (sort === "biggest") rows.sort((a, b) => Math.abs(b.txn.amount_cents) - Math.abs(a.txn.amount_cents));
  const total = rows.reduce((s, e) => s + Math.abs(e.txn.amount_cents), 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Chip on={!gap} onClick={() => setGap("")} label="Everything" n={all.length} />
        {GAPS.filter((g) => counts[g] > 0).map((g) => <Chip key={g} on={gap === g} onClick={() => setGap(gap === g ? "" : g)} label={GAP_LABEL[g]} n={counts[g]} must={FIX_FIRST.has(g)} />)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={input} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account">
          <option value="">All accounts</option>
          {fin.accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
        </select>
        <select className={input} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="biggest">Biggest first</option>
        </select>
        <input className={`${input} w-56`} placeholder="Search vendor, description..." value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="ml-auto text-xs text-helios-dim">{rows.length} line{rows.length === 1 ? "" : "s"} | {fmtCents(total)}</span>
      </div>

      {!all.length ? <Empty>Every ledger line is squared away.</Empty>
        : !rows.length ? <Empty>Nothing matches.</Empty> : (
          <div className="flex flex-col gap-2">
            {rows.map((e) => (
              <Row key={e.txn.id} {...props} end={e} evidence={evidence} open={open === e.txn.id}
                toggle={() => setOpen(open === e.txn.id ? null : e.txn.id)} openTxn={openTxn} />
            ))}
          </div>
        )}
      <p className="text-xs text-helios-dim">
        A line needs a category and a subteam before it's squared away. A missing receipt or part, a small difference, or a flag can be
        waived with a reason instead: that also resolves it on the Discrepancies page.
      </p>
    </div>
  );
}

function Chip({ on, onClick, label, n, must }: { on: boolean; onClick: () => void; label: string; n: number; must?: boolean }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${on ? "border-asu-gold bg-asu-gold/10 text-asu-gold" : "border-helios-line text-helios-text hover:bg-helios-strip"}`}>
      {must && <span className="size-1.5 rounded-full bg-helios-danger" title="Has to be fixed" />}
      {label}<span className={`rounded-full px-1.5 text-xs tabular-nums ${on ? "bg-asu-gold/20" : "bg-helios-strip text-helios-dim"}`}>{n}</span>
    </button>
  );
}

function Row({ end, evidence, open, toggle, ...p }: FinanceProps & { end: LooseEnd; evidence: Evidence[]; open: boolean; toggle: () => void }) {
  const t = end.txn;
  const account = p.fin.accounts.find((a) => a.id === t.account_id);
  return (
    <div className={`overflow-hidden rounded-lg border bg-helios-panel ${open ? "border-asu-gold/60" : "border-helios-line"}`}>
      <button className="flex w-full items-center gap-4 px-4 py-2.5 text-left hover:bg-helios-grid/40" onClick={toggle} aria-expanded={open}>
        <div className="w-28 shrink-0 text-xs text-helios-dim">{shortDate(t.date)}<div className="truncate">{account?.name}</div></div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{t.vendor || t.description || "(no description)"}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {end.gaps.map((g) => <Badge key={g.gap} tone={FIX_FIRST.has(g.gap) ? "bad" : "warn"} title={g.detail}>{GAP_LABEL[g.gap]}</Badge>)}
          </div>
        </div>
        <div className="shrink-0 text-right font-semibold"><Money cents={t.amount_cents} signed /></div>
        <span className="w-3 text-helios-dim">{open ? "▾" : "▸"}</span>
      </button>
      {open && <Fixes {...p} end={end} evidence={evidence} />}
    </div>
  );
}

/** The quick fix for each gap on one line. */
function Fixes({ end, evidence, ...p }: FinanceProps & { end: LooseEnd; evidence: Evidence[] }) {
  const { client, fin, pur, reload, flash, me, openTxn } = p;
  const t = end.txn;
  const abs = Math.abs(t.amount_cents);
  const [where, setWhere] = useState({ project_id: pur.projects[0]?.id ?? null, subteam_id: "" });
  const [reason, setReason] = useState("");
  const [why, setWhy] = useState("");
  const run = (label: string, fn: () => Promise<unknown>) => void attempt(flash, reload, label, fn);
  const waive = (keys: string[], note: string) => run("Marked as fine.", async () => { for (const k of keys) await resolveDiscrepancy(client, k, note, me); });
  // unmatched invoices and parts with the same vendor or amount
  const candidates = (kinds: (e: Evidence) => boolean) => evidence.filter((e) => e.txn_id === null && kinds(e) && claimsACharge(e)
    && ((t.vendor && e.vendor === t.vendor) || e.total_cents === abs)).slice(0, 6);

  const section = (g: GapInfo, body: React.ReactNode) => (
    <div key={g.gap} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="text-sm"><b>{GAP_LABEL[g.gap]}</b>{g.detail && <span className="text-helios-dim">: {g.detail}</span>}</div>
      {body}
    </div>
  );
  const waiveButton = (g: GapInfo, label: string) => (
    <Button kind="ghost" onClick={() => waive(g.keys, reason.trim() || label)} title="Uses the reason typed below, if any">{label}</Button>
  );

  return (
    <div className="border-t border-helios-line px-4 py-3">
      <div className="divide-y divide-helios-line">
        {end.gaps.map((g) => {
          switch (g.gap) {
            case "category":
              return section(g, (
                <select className={`${input} w-64`} value="" aria-label="Category"
                  onChange={(e) => e.target.value && run("Category saved.", () => updateTxn(client, t.id, { category: e.target.value }))}>
                  <option value="">Pick a category...</option>
                  {fin.categories.filter((c) => c.name !== "Needs category").map((c) => <option key={c.name}>{c.name}</option>)}
                </select>
              ));
            case "split":
              return section(g, (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex w-96 max-w-full gap-1"><WherePicker pur={pur} value={where} onChange={(v) => setWhere({ project_id: v.project_id, subteam_id: v.subteam_id })} /></div>
                  <Button disabled={!where.subteam_id} onClick={() => run("Split saved.", () => setAllocations(client, t.id, [{ ...where, amount_cents: abs }]))}>
                    All {fmtCents(abs)} to this subteam</Button>
                  <button className="text-xs text-asu-gold hover:underline" onClick={() => openTxn(t.id)}>Split between subteams in the ledger</button>
                </div>
              ));
            case "receipt": {
              const docs = candidates((e) => e.kind === "invoice" || e.kind === "email");
              return section(g, (
                <div className="flex flex-col gap-1.5">
                  {docs.map((e) => <Candidate key={e.id} e={e} onAttach={() => run("Attached.", () => linkEvidence(client, e.id, t.id))} />)}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="cursor-pointer rounded-md border border-helios-line px-3 py-1.5 text-sm font-semibold hover:bg-helios-strip">
                      Attach a file (PDF or photo)
                      <input type="file" className="hidden" accept={RECEIPT_TYPES.join(",")} onChange={(e) => {
                        const file = e.target.files?.[0]; e.target.value = "";
                        if (file) run("Receipt attached.", () => attachDocument(client, t, file));
                      }} />
                    </label>
                    {waiveButton(g, "No receipt needed")}
                  </div>
                </div>
              ));
            }
            case "part": {
              const parts = candidates((e) => REQUEST_KINDS.has(e.kind));
              return section(g, (
                <div className="flex flex-col gap-1.5">
                  {parts.length ? parts.map((e) => <Candidate key={e.id} e={e} onAttach={() => run("Part matched.",
                    () => (e.item_id ? linkItem(client, e.item_id, t.id) : linkEvidence(client, e.id, t.id)))} />)
                    : <span className="text-xs text-helios-dim">No unmatched part with this vendor or amount.</span>}
                  <div>{waiveButton(g, "No part needed")}</div>
                </div>
              ));
            }
            case "amount":
              return section(g, <div>{waiveButton(g, "Difference is fine (tax, shipping or a discount)")}</div>);
            case "review":
              return section(g, (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => run("Unflagged.", () => updateTxn(client, t.id, { needs_review: false }))}>It's a team purchase</Button>
                  {waiveButton(g, "Checked, keep the note")}
                </div>
              ));
            case "reason":
              return section(g, (
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (why.trim()) run("Saved.", () => updateTxn(client, t.id, { notes: why.trim() })); }}>
                  <input className={`${input} flex-1`} placeholder="What the check was for" value={why} onChange={(e) => setWhy(e.target.value)} />
                  <Button type="submit" disabled={!why.trim()}>Save</Button>
                </form>
              ));
          }
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-helios-line pt-3">
        <input className={`${input} min-w-[240px] flex-1`} placeholder="Reason, for anything you mark as fine (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {canWaiveAll(end) && end.gaps.length > 1 && (
          <Button kind="ghost" onClick={() => waive(waivableKeys(end), reason.trim() || "Squared away as it is")}>All of it is fine</Button>
        )}
        <Button kind="ghost" onClick={() => openTxn(t.id)}>Open in the ledger</Button>
      </div>
    </div>
  );
}

function Candidate({ e, onAttach }: { e: Evidence; onAttach: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-helios-line px-2 py-1.5 text-xs">
      <Badge tone={e.kind === "request" ? "info" : "plain"}>{e.kind === "request" ? "part" : e.kind}</Badge>
      <span className="min-w-0 flex-1 truncate">{e.vendor ?? "?"}{e.order_ref ? ` | ${e.order_ref}` : ""}{e.kind === "request" ? ` | ${e.source_file}` : ""} | {shortDate(e.date)} {e.items.slice(0, 60)}</span>
      <span className="tabular-nums">{fmtCents(e.total_cents)}</span>
      <button className="font-semibold text-asu-gold hover:underline" onClick={onAttach}>Attach</button>
    </div>
  );
}
