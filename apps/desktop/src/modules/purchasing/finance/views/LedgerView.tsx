import { useEffect, useMemo, useState } from "react";
import { centsToInput, fmtCents, parseCents } from "../../lib/money";
import { Button, Card, Empty, useConfirm } from "../../components/ui";
import {
  attachDocument, deleteTxn, documentUrl, fetchEvents, insertTxn, linkEvidence, linkItem, openExternal, saveCsv, setAllocations, toCsv, updateTxn,
  RECEIPT_TYPES, type FinanceEvent, type TxnFields,
} from "../api";
import { allEvidence } from "../compute";
import { claimsACharge, type Evidence } from "../discrepancies";
import { ALL_KINDS, anchoredRunning, isSpend, splitEvenly, type Txn, type TxnAllocation, type TxnKind } from "../ledger";
import { today } from "../useFinance";
import { Badge, Money, WherePicker, accountLabel, attempt, input, shortDate, whereLabel, type FinanceProps } from "./shared";

interface Filters { account: string; car: string; subteam: string; category: string; start: string; end: string; attention: boolean; q: string }
const NO_FILTERS: Filters = { account: "", car: "", subteam: "", category: "", start: "", end: "", attention: false, q: "" };

const needsAttention = (t: Txn) => t.needs_review || t.category === "Needs category" || (isSpend(t) && t.status === "posted" && !t.txn_allocations.length);

/** The ledger: every statement line and hand-entered transaction, newest first. */
export function LedgerView(props: FinanceProps & { selected: number | null; select: (id: number | null) => void }) {
  const { fin, pur, selected, select, flash } = props;
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [adding, setAdding] = useState(false);
  const running = useMemo(() => anchoredRunning(fin.txns, fin.accounts, fin.balances), [fin.txns, fin.accounts, fin.balances]);
  const where = whereLabel(pur);
  const evidence = useMemo(() => allEvidence(fin, pur.items, where), [fin, pur.items]);
  const evCount = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of evidence) if (e.txn_id !== null) m.set(e.txn_id, (m.get(e.txn_id) ?? 0) + 1);
    return m;
  }, [evidence]);

  const rows = fin.txns.filter((t) =>
    (!f.account || String(t.account_id) === f.account)
    && (!f.car || (f.car === "unassigned" ? !t.txn_allocations.length : t.txn_allocations.some((a) => (a.project_id ?? "team") === f.car)))
    && (!f.subteam || t.txn_allocations.some((a) => a.subteam_id === f.subteam))
    && (!f.category || t.category === f.category)
    && (!f.start || t.date >= f.start) && (!f.end || t.date <= f.end)
    && (!f.attention || needsAttention(t))
    && (!f.q || `${t.description} ${t.vendor ?? ""} ${t.notes} ${t.reference ?? ""}`.toLowerCase().includes(f.q.toLowerCase())),
  ).sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
  const spend = rows.filter((t) => isSpend(t) || t.kind === "credit").reduce((s, t) => s - t.amount_cents, 0);
  const income = rows.filter((t) => t.kind === "deposit").reduce((s, t) => s + t.amount_cents, 0);
  const open = selected !== null ? fin.txns.find((t) => t.id === selected) ?? null : null;
  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));

  async function exportCsv() {
    const acct = new Map(fin.accounts.map((a) => [a.id, a]));
    const csv = toCsv([...rows].reverse().map((t) => ({
      id: t.id, date: t.date, account: acct.get(t.account_id)?.name ?? "", kind: t.kind, status: t.status,
      description: t.description, vendor: t.vendor ?? "", category: t.category, reference: t.reference ?? "",
      amount: (t.amount_cents / 100).toFixed(2), running_balance: ((running.get(t.id) ?? 0) / 100).toFixed(2),
      split: t.txn_allocations.map((a) => `${where(a.project_id, a.subteam_id)} ${(a.amount_cents / 100).toFixed(2)}`).join("; "),
      cleared: t.cleared_date ?? "", needs_review: t.needs_review ? "yes" : "", notes: t.notes,
    })));
    if (await saveCsv(`sdm-ledger-${today()}.csv`, csv)) flash("Ledger exported.");
  }

  return (
    <div className="flex min-h-0 gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select className={input} value={f.account} onChange={(e) => set({ account: e.target.value })}>
            <option value="">All accounts</option>
            {fin.accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
          </select>
          <select className={input} value={f.car} onChange={(e) => set({ car: e.target.value })}>
            <option value="">Both cars</option>
            {pur.projects.map((p) => <option key={p.id} value={p.id}>{p.car_code}</option>)}
            <option value="team">Team (shared)</option>
            <option value="unassigned">No subteam yet</option>
          </select>
          <select className={input} value={f.subteam} onChange={(e) => set({ subteam: e.target.value })}>
            <option value="">All subteams</option>
            {pur.subteams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className={input} value={f.category} onChange={(e) => set({ category: e.target.value })}>
            <option value="">All categories</option>
            {fin.categories.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
          <input type="date" className={input} value={f.start} onChange={(e) => set({ start: e.target.value })} title="From" />
          <input type="date" className={input} value={f.end} onChange={(e) => set({ end: e.target.value })} title="To" />
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.attention} onChange={(e) => set({ attention: e.target.checked })} />Needs attention</label>
          <input className={`${input} w-44`} placeholder="Search..." value={f.q} onChange={(e) => set({ q: e.target.value })} />
          {JSON.stringify(f) !== JSON.stringify(NO_FILTERS) && <Button kind="ghost" onClick={() => setF(NO_FILTERS)}>Clear</Button>}
          <div className="ml-auto flex gap-2">
            <Button kind="ghost" onClick={() => void exportCsv()}>Export CSV</Button>
            <Button onClick={() => { setAdding(true); select(null); }}>+ Transaction</Button>
          </div>
        </div>
        <div className="text-xs text-helios-dim">{rows.length} transactions | spending {fmtCents(spend)} | money in {fmtCents(income)}</div>

        {rows.length ? (
          <div className="overflow-auto rounded-lg border border-helios-line bg-helios-panel">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-helios-strip text-[11px] uppercase tracking-wider text-helios-dim">
                <tr><th className="p-2 text-left">Date</th><th className="p-2 text-left">Account</th><th className="p-2 text-left">What</th><th className="p-2 text-left">Category</th>
                  <th className="p-2 text-left">Subteam</th><th className="p-2 text-center" title="Invoices, emails and parts attached">Docs</th><th className="p-2 text-right">Amount</th><th className="p-2 text-right">Balance</th></tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} onClick={() => { select(t.id); setAdding(false); }}
                    className={`cursor-pointer border-t border-helios-line hover:bg-helios-strip ${selected === t.id ? "bg-asu-gold/10" : ""} ${t.status === "expected" ? "opacity-60" : ""}`}>
                    <td className="whitespace-nowrap p-2 text-helios-dim">{shortDate(t.date)}</td>
                    <td className="whitespace-nowrap p-2 text-xs">{fin.accounts.find((a) => a.id === t.account_id)?.name}</td>
                    <td className="p-2">
                      {t.vendor || t.description}
                      {t.kind === "check" && <span className="text-xs text-helios-dim"> | check {t.reference}{t.cleared_date ? "" : " (uncashed)"}</span>}
                      {t.status === "expected" && <> <Badge>expected</Badge></>}
                      {t.kind === "transfer" && <> <Badge tone="info">transfer</Badge></>}
                      {t.needs_review && <> <Badge tone="warn" title={t.review_note}>review</Badge></>}
                    </td>
                    <td className="p-2 text-xs">{t.category === "Needs category" ? <Badge tone="warn">needs category</Badge> : t.category}</td>
                    <td className="p-2 text-xs">{t.txn_allocations.length ? t.txn_allocations.map((a) => where(a.project_id, a.subteam_id)).join(", ")
                      : isSpend(t) ? <span className="text-helios-muted">-</span> : ""}</td>
                    <td className="p-2 text-center text-xs text-helios-dim">{evCount.get(t.id) ?? ""}</td>
                    <td className="p-2 text-right"><Money cents={t.amount_cents} signed /></td>
                    <td className="p-2 text-right text-xs tabular-nums text-helios-dim">{fmtCents(running.get(t.id))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No transactions match.</Empty>}
      </div>

      {(open || adding) && (
        <aside className="w-[440px] shrink-0">
          {adding ? <NewTxn {...props} done={(id) => { setAdding(false); if (id) select(id); }} />
            : open && <TxnPanel key={open.id} {...props} t={open} evidence={evidence} close={() => select(null)} />}
        </aside>
      )}
    </div>
  );
}

/** A share's amount: free text while typing, read as cents when you leave the box. */
function ShareAmount({ cents, onChange }: { cents: number; onChange: (cents: number) => void }) {
  const [text, setText] = useState(() => centsToInput(cents));
  useEffect(() => { setText(centsToInput(cents)); }, [cents]);
  return (
    <input className={`${input} w-20 shrink-0 text-right`} value={text} onChange={(e) => setText(e.target.value)}
      onBlur={() => { const c = parseCents(text); if (c === null) setText(centsToInput(cents)); else onChange(Math.abs(c)); }} />
  );
}

function TxnPanel({ client, fin, pur, reload, flash, t, evidence, close }: FinanceProps & { t: Txn; evidence: Evidence[]; close: () => void }) {
  const [form, setForm] = useState(() => ({
    date: t.date, amount: centsToInput(Math.abs(t.amount_cents)), kind: t.kind, account_id: t.account_id, description: t.description,
    vendor: t.vendor ?? "", category: t.category, reference: t.reference ?? "", cleared_date: t.cleared_date ?? "", status: t.status,
    notes: t.notes, needs_review: t.needs_review, review_note: t.review_note,
  }));
  const [split, setSplit] = useState<TxnAllocation[]>(() => t.txn_allocations.map((a) => ({ project_id: a.project_id, subteam_id: a.subteam_id, amount_cents: a.amount_cents })));
  const [history, setHistory] = useState<FinanceEvent[] | null>(null);
  const [ask, confirmDialog] = useConfirm();
  const abs = Math.abs(t.amount_cents);
  const splitSum = split.reduce((s, a) => s + a.amount_cents, 0);
  const linked = evidence.filter((e) => e.txn_id === t.id);
  const candidates = evidence.filter((e) => e.txn_id === null && claimsACharge(e)
    && ((t.vendor && e.vendor === t.vendor) || e.total_cents === abs)).slice(0, 12);

  useEffect(() => { setHistory(null); }, [t.id]);

  function signed(kind: TxnKind, cents: number) {
    return kind === "transfer" ? cents : kind === "deposit" || kind === "credit" ? Math.abs(cents) : -Math.abs(cents);
  }
  async function save() {
    const cents = parseCents(form.amount);
    if (cents === null) { flash("Amount not understood.", true); return; }
    // Keep the line's sign unless its type changed: a fee reversal or a
    // returned charge is positive and must stay that way on an unrelated edit.
    const amount = form.kind === t.kind && t.amount_cents !== 0
      ? Math.sign(t.amount_cents) * Math.abs(cents)
      : signed(form.kind, form.kind === "transfer" && t.amount_cents < 0 ? -Math.abs(cents) : cents);
    const fields: TxnFields = {
      date: form.date, amount_cents: amount,
      kind: form.kind, account_id: Number(form.account_id), description: form.description, vendor: form.vendor || null,
      category: form.category, reference: form.reference || null, cleared_date: form.cleared_date || null, status: form.status,
      notes: form.notes, needs_review: form.needs_review, review_note: form.review_note,
    };
    await attempt(flash, reload, "Saved.", () => updateTxn(client, t.id, fields));
  }
  async function saveSplit() {
    const rows = split.filter((a) => a.subteam_id && a.amount_cents > 0);
    await attempt(flash, reload, rows.length ? "Split saved." : "Split cleared.", () => setAllocations(client, t.id, rows));
  }
  const evenly = () => setSplit((s) => { const parts = splitEvenly(abs, s.map(() => 1)); return s.map((a, i) => ({ ...a, amount_cents: parts[i]! })); });
  const f = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <Card className="sticky top-0 flex max-h-[calc(100vh-140px)] flex-col gap-3 overflow-auto">
      <div className="flex items-start justify-between">
        <div>
          <b>{t.vendor || t.description || "Transaction"}</b>
          <div className="text-xs text-helios-dim">#{t.id} | {t.source === "manual" ? "entered by hand" : `from ${t.source}`}{t.statement_id ? " | on a statement" : ""}</div>
        </div>
        <button className="text-helios-dim hover:text-helios-text" onClick={close} aria-label="Close">x</button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <label className="flex flex-col gap-1">Date<input type="date" className={input} value={form.date} onChange={f("date")} /></label>
        <label className="flex flex-col gap-1">Amount $<input className={input} value={form.amount} onChange={f("amount")} /></label>
        <label className="flex flex-col gap-1">Type<select className={input} value={form.kind} onChange={f("kind")}>{ALL_KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
        <label className="flex flex-col gap-1">Account<select className={input} value={form.account_id} onChange={f("account_id")}>{fin.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="col-span-2 flex flex-col gap-1">Description<input className={input} value={form.description} onChange={f("description")} /></label>
        <label className="flex flex-col gap-1">Vendor<input className={input} value={form.vendor} onChange={f("vendor")} /></label>
        <label className="flex flex-col gap-1">Category<select className={input} value={form.category} onChange={f("category")}>{fin.categories.map((c) => <option key={c.name}>{c.name}</option>)}</select></label>
        <label className="flex flex-col gap-1">Reference / check #<input className={input} value={form.reference} onChange={f("reference")} /></label>
        {form.kind === "check"
          ? <label className="flex flex-col gap-1">Cleared on<input type="date" className={input} value={form.cleared_date} onChange={f("cleared_date")} /></label>
          : <label className="flex flex-col gap-1">Status<select className={input} value={form.status} onChange={f("status")}><option value="posted">posted</option><option value="expected">expected</option></select></label>}
        <label className="col-span-2 flex flex-col gap-1">Notes<textarea className={input} rows={2} value={form.notes} onChange={f("notes")} /></label>
        <label className="col-span-2 flex items-center gap-2"><input type="checkbox" checked={form.needs_review} onChange={(e) => setForm({ ...form, needs_review: e.target.checked })} />Flag for review</label>
        {form.needs_review && <input className={`${input} col-span-2`} placeholder="Why (e.g. addressed to someone else)" value={form.review_note} onChange={f("review_note")} />}
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void save()}>Save</Button>
        {t.source === "manual" && <Button kind="danger" onClick={() => void ask({
          title: "Delete transaction", body: "Delete this hand-entered transaction? It stays in the history.", confirmLabel: "Delete", danger: true,
        }).then((ok) => ok && attempt(flash, reload, "Deleted.", async () => { await deleteTxn(client, t.id); close(); }))}>Delete</Button>}
        {confirmDialog}
      </div>

      {t.kind !== "transfer" && (
        <div className="border-t border-helios-line pt-3">
          <div className="flex items-center justify-between"><b className="text-sm">Subteam split</b>
            <span className={`text-xs ${split.length && splitSum !== abs ? "text-helios-danger" : "text-helios-dim"}`}>{fmtCents(splitSum)} of {fmtCents(abs)}</span></div>
          {t.allocation_basis && t.allocation_basis !== "manual" && <div className="text-xs text-helios-dim">From: {t.allocation_basis}</div>}
          <div className="mt-2 flex flex-col gap-1.5">
            {split.map((a, i) => (
              <div key={i} className="flex items-center gap-1">
                <WherePicker pur={pur} value={a} onChange={(v) => setSplit((s) => s.map((x, j) => (j === i ? { ...x, ...v } : x)))} />
                <ShareAmount cents={a.amount_cents} onChange={(c) => setSplit((s) => s.map((x, j) => (j === i ? { ...x, amount_cents: c } : x)))} />
                <button className="px-1 text-helios-muted hover:text-helios-danger" onClick={() => setSplit((s) => s.filter((_, j) => j !== i))} aria-label="Remove">x</button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button kind="ghost" onClick={() => setSplit((s) => [...s, { project_id: pur.projects[0]?.id ?? null, subteam_id: "", amount_cents: s.length ? 0 : abs }])}>+ Share</Button>
            {split.length > 1 && <Button kind="ghost" onClick={evenly}>Split evenly</Button>}
            <Button onClick={() => void saveSplit()} disabled={(split.length > 0 && splitSum !== abs) || split.some((a) => !a.subteam_id)}
              title={split.some((a) => !a.subteam_id) ? "Pick a subteam for each share" : undefined}>Save split</Button>
          </div>
        </div>
      )}

      <div className="border-t border-helios-line pt-3">
        <b className="text-sm">Evidence</b>
        <p className="text-xs text-helios-dim">Invoices, order emails and parts that explain this line. They never add money.</p>
        {linked.length ? linked.map((e) => <EvidenceRowView key={e.id} e={e} action="Detach"
          onOpen={e.object_path ? () => void documentUrl(client, e.object_path!).then(openExternal).catch((x) => flash(String(x), true)) : undefined}
          onAction={() => void attempt(flash, reload, "Detached.",
          () => (e.item_id ? linkItem(client, e.item_id, null) : linkEvidence(client, e.id, null)))} />)
          : <div className="mt-1 text-xs text-helios-muted">Nothing attached.</div>}
        <label className="mt-2 inline-block cursor-pointer text-xs text-asu-gold hover:underline">
          + Attach an invoice or receipt file (PDF or photo)
          <input type="file" className="hidden" accept={RECEIPT_TYPES.join(",")} onChange={(e) => {
            const file = e.target.files?.[0]; e.target.value = "";
            if (file) void attempt(flash, reload, "Attached.", () => attachDocument(client, t, file));
          }} />
        </label>
        {candidates.length > 0 && (
          <>
            <div className="mt-2 text-xs font-semibold text-helios-dim">Could be</div>
            {candidates.map((e) => <EvidenceRowView key={e.id} e={e} action="Attach" onAction={() => void attempt(flash, reload, "Attached.",
              () => (e.item_id ? linkItem(client, e.item_id, t.id) : linkEvidence(client, e.id, t.id)))} />)}
          </>
        )}
        {linked.length === 0 && candidates.length === 0 && <div className="text-xs text-helios-muted">No unmatched invoices or parts with the same vendor or amount.</div>}
      </div>

      <div className="border-t border-helios-line pt-3">
        {history === null
          ? <button className="text-xs text-helios-dim hover:text-helios-text" onClick={() => void fetchEvents(client, "transactions", String(t.id)).then(setHistory).catch(() => setHistory([]))}>Show history</button>
          : history.length ? (
            <table className="w-full text-xs">
              <tbody>{history.map((h) => (
                <tr key={h.id} className="border-t border-helios-line align-top">
                  <td className="py-1 whitespace-nowrap text-helios-dim">{shortDate(h.at)}</td>
                  <td className="py-1 px-1">{h.field}</td>
                  <td className="py-1 break-all text-helios-dim">{h.field.startsWith("*") ? "" : `${h.old_value ?? "(none)"} -> ${h.new_value ?? "(none)"}`}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <div className="text-xs text-helios-muted">No changes recorded.</div>}
      </div>
    </Card>
  );
}

function EvidenceRowView({ e, action, onAction, onOpen }: { e: Evidence; action: string; onAction: () => void; onOpen?: () => void }) {
  return (
    <div className="mt-1 flex items-center gap-2 rounded-md border border-helios-line px-2 py-1.5 text-xs">
      <Badge tone={e.kind === "request" ? "info" : "plain"}>{e.kind === "request" ? "part" : e.kind}</Badge>
      <div className="min-w-0 flex-1">
        <div className="truncate">{e.vendor ?? "?"} {e.order_ref ? `| ${e.order_ref}` : ""} {e.kind === "request" ? `| ${e.source_file}` : ""}</div>
        <div className="truncate text-helios-dim">{shortDate(e.date)} {e.items.slice(0, 60)}</div>
      </div>
      <span className="tabular-nums">{fmtCents(e.total_cents)}</span>
      {onOpen && <button className="text-asu-gold hover:underline" onClick={onOpen}>Open</button>}
      <button className="text-asu-gold hover:underline" onClick={onAction}>{action}</button>
    </div>
  );
}

/** One short form for a check just written, a deposit, or anything the statements don't have yet. */
function NewTxn({ client, fin, pur, reload, flash, done }: FinanceProps & { done: (id: number | null) => void }) {
  const checking = fin.accounts.find((a) => a.kind === "checking");
  const [form, setForm] = useState({
    kind: "check" as TxnKind, account_id: checking?.id ?? fin.accounts[0]?.id ?? 0, date: today(), amount: "", description: "",
    vendor: "", category: "Needs category", reference: "", cleared_date: "", project_id: pur.projects[0]?.id ?? "", subteam_id: "",
  });
  const f = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  async function add() {
    const cents = parseCents(form.amount);
    if (!cents) { flash("Enter the amount.", true); return; }
    const abs = Math.abs(cents);
    let id: number | null = null;
    const ok = await attempt(flash, reload, "Transaction added.", async () => {
      id = await insertTxn(client, {
        account_id: Number(form.account_id), kind: form.kind, date: form.date,
        post_date: form.kind === "check" ? null : form.date,
        cleared_date: form.cleared_date || (form.kind === "check" ? null : form.date),
        amount_cents: form.kind === "deposit" || form.kind === "credit" ? abs : -abs,
        description: form.description, vendor: form.vendor || null, category: form.category, reference: form.reference || null, status: "posted",
      });
      if (form.subteam_id) await setAllocations(client, id, [{ project_id: form.project_id || null, subteam_id: form.subteam_id, amount_cents: abs }]);
    });
    if (ok) done(id);
  }
  return (
    <Card className="sticky top-0 flex flex-col gap-2 text-sm">
      <div className="flex items-center justify-between"><b>New transaction</b><button className="text-helios-dim" onClick={() => done(null)}>x</button></div>
      <div className="flex flex-wrap gap-1">
        {(["check", "deposit", "withdrawal", "charge", "fee"] as TxnKind[]).map((k) => (
          <button key={k} onClick={() => setForm({ ...form, kind: k })}
            className={`rounded-md border px-2 py-0.5 text-xs ${form.kind === k ? "border-asu-gold bg-asu-gold/15 text-asu-gold" : "border-helios-line"}`}>{k}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">Account<select className={input} value={form.account_id} onChange={f("account_id")}>{fin.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="flex flex-col gap-1">{form.kind === "check" ? "Written on" : "Date"}<input type="date" className={input} value={form.date} onChange={f("date")} /></label>
        <label className="flex flex-col gap-1">Amount $<input autoFocus className={input} value={form.amount} onChange={f("amount")} /></label>
        <label className="flex flex-col gap-1">{form.kind === "check" ? "Check #" : "Reference"}<input className={input} value={form.reference} onChange={f("reference")} /></label>
        <label className="col-span-2 flex flex-col gap-1">What for<input className={input} value={form.description} onChange={f("description")} placeholder={form.kind === "check" ? "e.g. Reimbursement for a member's shop supplies" : ""} /></label>
        <label className="flex flex-col gap-1">Paid to / from<input className={input} value={form.vendor} onChange={f("vendor")} /></label>
        <label className="flex flex-col gap-1">Category<select className={input} value={form.category} onChange={f("category")}>{fin.categories.map((c) => <option key={c.name}>{c.name}</option>)}</select></label>
        {form.kind === "check" && <label className="flex flex-col gap-1">Cleared on (if it has)<input type="date" className={input} value={form.cleared_date} onChange={f("cleared_date")} /></label>}
      </div>
      {form.kind !== "deposit" && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-helios-dim">For</span>
          <WherePicker pur={pur} value={{ project_id: form.project_id || null, subteam_id: form.subteam_id }}
            onChange={(v) => setForm({ ...form, project_id: v.project_id ?? "", subteam_id: v.subteam_id })} />
        </div>
      )}
      <Button onClick={() => void add()}>Add</Button>
      {form.kind === "check" && <p className="text-xs text-helios-dim">A check counts against Available as soon as it's written and clears when it hits the bank.</p>}
    </Card>
  );
}
