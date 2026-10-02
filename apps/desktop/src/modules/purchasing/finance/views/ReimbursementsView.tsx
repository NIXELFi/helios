import { useMemo, useState } from "react";
import { centsToInput, fmtCents, parseCents } from "../../lib/money";
import { Button, Card, Empty, useConfirm } from "../../components/ui";
import {
  addReimbursement, attachReceiptsOrUndo, decideReimbursement, deleteReceipt, deleteReimbursement, recordReimbursementPayment, updateReimbursement, uploadReceipts,
  type ReimbursementWithReceipts,
} from "../api";
import { today } from "../../lib/dates";
import { PAID_WITH_LABEL, type PaidWith } from "../ledger";
import { Badge, attempt, input, shortDate, whereLabel, type FinanceProps } from "./shared";
import { ReceiptList, ReceiptPicker, removeReceiptQuestion } from "./Receipts";

/** Execs: everyone the team owes money, per person, with receipts; review requests; pay by check or in cash; delete mistakes. */
export function ReimbursementsView({ client, fin, pur, reload, flash, openTxn }: FinanceProps) {
  const where = whereLabel(pur);
  const requests = fin.reimbursements.filter((r) => r.status === "requested");
  const [showPaid, setShowPaid] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [pay, setPay] = useState<{ date: string; method: PaidWith; check: string; addToLedger: boolean }>({ date: today(), method: "check", check: "", addToLedger: true });
  const [adding, setAdding] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<string, ReimbursementWithReceipts[]>();
    for (const r of fin.reimbursements) {
      if (r.status === "requested" || r.status === "denied") continue;
      const k = r.person_name.trim();
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()].map(([person, rows]) => ({
      person, rows: rows.sort((a, b) => Number(a.status === "paid") - Number(b.status === "paid") || a.id - b.id),
      owed: rows.filter((r) => r.status === "owed").reduce((s, r) => s + (r.amount_cents ?? 0), 0),
      paid: rows.filter((r) => r.status === "paid").reduce((s, r) => s + (r.amount_cents ?? 0), 0),
      unpaid: rows.filter((r) => r.status === "owed").length,
    })).sort((a, b) => b.owed - a.owed || a.person.localeCompare(b.person));
  }, [fin.reimbursements]);
  const totalOwed = groups.reduce((s, g) => s + g.owed, 0) + requests.reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const pickedRows = fin.reimbursements.filter((r) => picked.has(r.id));
  const pickedPeople = new Set(pickedRows.map((r) => r.person_name.trim().toLowerCase()));

  const toggle = (id: number, on: boolean) => setPicked((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm"><b className="text-lg tabular-nums">{fmtCents(totalOwed)}</b> <span className="text-helios-dim">owed to members{requests.length ? `, including ${requests.length} request${requests.length > 1 ? "s" : ""} to review` : ""}. It counts against Available until paid.</span></div>
        <div className="ml-auto flex gap-2">
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={showPaid} onChange={(e) => setShowPaid(e.target.checked)} />Show paid</label>
          <Button kind="ghost" onClick={() => setAdding((a) => !a)}>+ Add for someone</Button>
        </div>
      </div>

      {adding && <AddForm {...{ client, reload, flash }} done={() => setAdding(false)} />}

      {requests.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-helios-dim">Waiting for review ({requests.length})</h2>
          <div className="flex flex-col gap-2">
            {requests.map((r) => <RequestCard key={r.id} r={r} {...{ client, reload, flash }} where={where(r.project_id, r.subteam_id)} />)}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-helios-dim">By person</h2>
        {groups.filter((g) => showPaid || g.unpaid).length === 0 && <Empty>Nobody is owed anything.</Empty>}
        <div className="flex flex-col gap-3">
          {groups.filter((g) => showPaid || g.unpaid).map((g) => (
            <Card key={g.person} className="p-0">
              <div className="flex items-center justify-between border-b border-helios-line px-4 py-2">
                <b>{g.person}</b>
                <span className="text-sm">{g.owed ? <><b className="tabular-nums">{fmtCents(g.owed)}</b> owed ({g.unpaid})</> : <Badge tone="good">all paid</Badge>}
                  {g.paid > 0 && <span className="text-helios-dim"> | {fmtCents(g.paid)} paid</span>}</span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {g.rows.filter((r) => showPaid || r.status !== "paid").map((r) => (
                    <Row key={r.id} r={r} {...{ client, reload, flash, openTxn }} picked={picked.has(r.id)} toggle={toggle} where={where(r.project_id, r.subteam_id)} />
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      </section>

      {picked.size > 0 && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-xl border border-asu-gold bg-helios-panel px-4 py-2 shadow-lg">
          <b className="text-asu-gold">{picked.size} selected | {fmtCents(pickedRows.reduce((s, r) => s + (r.amount_cents ?? 0), 0))}</b>
          <label className="flex items-center gap-1 text-sm">Paid on<input type="date" className={input} value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></label>
          <select className={input} value={pay.method} onChange={(e) => { const method = e.target.value as PaidWith; setPay({ ...pay, method, addToLedger: method !== "bank_cash" }); }} aria-label="Paid with">
            <option value="check">by check</option>
            <option value="cash_box">in cash from the cash box</option>
            <option value="bank_cash">in cash withdrawn at Chase</option>
          </select>
          {pay.method === "check" && <input className={`${input} w-28`} placeholder="Check #" value={pay.check} onChange={(e) => setPay({ ...pay, check: e.target.value })} />}
          <label className="flex items-center gap-1 text-sm" title={LEDGER_HINT[pay.method]}>
            <input type="checkbox" checked={pay.method === "cash_box" || (pay.addToLedger && !(pay.method === "check" && pickedPeople.size !== 1))}
              disabled={pay.method === "cash_box" || (pay.method === "check" && pickedPeople.size !== 1)}
              onChange={(e) => setPay({ ...pay, addToLedger: e.target.checked })} />
            {LEDGER_LABEL[pay.method]}
          </label>
          <Button onClick={() => void attempt(flash, reload, `${picked.size} marked paid ${pay.method === "check" ? "by check" : "in cash"}.`, async () => {
            const txn = await recordReimbursementPayment(client, [...picked], pay.method, pay.date || null, pay.check,
              pay.method === "cash_box" || (pay.addToLedger && (pay.method !== "check" || pickedPeople.size === 1)));
            setPicked(new Set());
            if (txn) openTxn(txn);
          })}>Mark paid</Button>
          <Button kind="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
          {pickedPeople.size > 1 && pay.method === "check" && <span className="text-xs text-helios-dim">One check pays one person, so the ledger entry is off for several people.</span>}
        </div>
      )}
    </div>
  );
}

const LEDGER_LABEL: Record<PaidWith, string> = {
  check: "Write the check into the ledger",
  cash_box: "Take it out of the Cash Box in the ledger",
  bank_cash: "Add the withdrawal to the ledger",
};
const LEDGER_HINT: Record<PaidWith, string> = {
  check: "Adds the check to the ledger as uncashed, so Available stays right until it clears",
  cash_box: "Always added: the cash box has no statement, so this withdrawal on the Cash Box account (made if there isn't one) is its record",
  bank_cash: "Off by default: the statement's withdrawal line is the record. Tick it only if exactly this amount was withdrawn (an ATM usually gives $20s): then it's added to checking now and the statement's line of the same amount is matched to it, not added twice",
};

function RequestCard({ r, client, reload, flash, where }: Pick<FinanceProps, "client" | "reload" | "flash"> & { r: ReimbursementWithReceipts; where: string }) {
  const [note, setNote] = useState("");
  const [ask, confirmDialog] = useConfirm();
  return (
    <Card>
      {confirmDialog}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <b>{r.person_name}</b> <span className="text-helios-dim">asked {shortDate(r.created_at)}</span>
          <div className="text-sm">{r.reason}{where && <span className="text-helios-dim"> | {where}</span>}{r.requested_date && <span className="text-helios-dim"> | paid {shortDate(r.requested_date)}</span>}</div>
        </div>
        <b className="text-lg tabular-nums">{fmtCents(r.amount_cents)}</b>
      </div>
      <div className="mt-2"><ReceiptList client={client} receipts={r.reimbursement_receipts} /></div>
      {!r.reimbursement_receipts.length && <div className="mt-1 text-xs text-asu-gold">No receipt attached: ask for one before approving.</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className={`${input} min-w-[220px] flex-1`} placeholder="Note (optional, sent to them)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button kind="good" onClick={() => void attempt(flash, reload, "Approved. It's now owed.", () => decideReimbursement(client, r.id, "approve", note))}>Approve</Button>
        <Button kind="danger" onClick={() => void attempt(flash, reload, "Declined.", () => decideReimbursement(client, r.id, "deny", note))}>Decline</Button>
        <Button kind="ghost" title="Entered by mistake: remove it without telling them" onClick={() => void ask(deleteQuestion(r)).then((ok) => ok && attempt(flash, reload, "Deleted.", () => deleteReimbursement(client, r)))}>Delete</Button>
      </div>
    </Card>
  );
}

/** The confirm for deleting a reimbursement entered by mistake. */
function deleteQuestion(r: ReimbursementWithReceipts) {
  const files = r.reimbursement_receipts.length;
  return {
    title: `Delete ${r.person_name}'s ${fmtCents(r.amount_cents)}${r.reason ? ` for ${r.reason.slice(0, 60)}` : ""}?`,
    body: <>It's removed for good{files ? `, with its ${files} receipt${files === 1 ? "" : "s"}` : ""}. Use this for one entered by mistake.
      {r.check_txn_id && <span className="mt-2 block">Its {r.paid_with === "check" || !r.paid_with ? "check" : "cash withdrawal"} stays in the ledger: delete it there too if that was a mistake as well.</span>}</>,
    confirmLabel: "Delete", danger: true,
  };
}

function Row({ r, client, reload, flash, openTxn, picked, toggle, where }: Pick<FinanceProps, "client" | "reload" | "flash" | "openTxn"> & {
  r: ReimbursementWithReceipts; picked: boolean; toggle: (id: number, on: boolean) => void; where: string;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [ask, confirmDialog] = useConfirm();
  const paid = r.status === "paid";
  const saveField = (fields: Parameters<typeof updateReimbursement>[2]) => void attempt(flash, reload, "", () => updateReimbursement(client, r.id, fields));
  return (
    <tr className={`border-t border-helios-line align-top ${paid ? "opacity-60" : ""}`}>
      <td className="w-8 p-2 text-center">{confirmDialog}{!paid && <input type="checkbox" checked={picked} onChange={(e) => toggle(r.id, e.target.checked)} aria-label="Select" />}</td>
      <td className="w-28 p-2">
        {paid ? <span className="tabular-nums">{fmtCents(r.amount_cents)}</span>
          : <input className={`${input} w-24 text-right`} defaultValue={centsToInput(r.amount_cents)} placeholder="amount?"
              onBlur={(e) => {
                const text = e.target.value.trim();
                const c = text ? parseCents(text) : null;
                if (text && c === null) { flash(`"${text}" isn't an amount.`, true); e.target.value = centsToInput(r.amount_cents); return; }
                if (c !== r.amount_cents) saveField({ amount_cents: c === null ? null : Math.abs(c) });
              }} />}
      </td>
      <td className="p-2">
        {paid ? r.reason : <input className={`${input} w-full`} defaultValue={r.reason} onBlur={(e) => { if (e.target.value !== r.reason) saveField({ reason: e.target.value }); }} />}
        <div className="mt-1 text-xs text-helios-dim">{[where, r.requested_date && `dated ${shortDate(r.requested_date)}`, r.user_id && "asked in Helios"].filter(Boolean).join(" | ")}</div>
      </td>
      <td className="p-2">
        <div className="flex flex-wrap items-center gap-2">
          <ReceiptList client={client} receipts={r.reimbursement_receipts}
            onDelete={paid ? undefined : (x) => void ask(removeReceiptQuestion(x)).then((ok) => ok && attempt(flash, reload, "Receipt removed.", () => deleteReceipt(client, x)))} />
          {!paid && <ReceiptPicker compact files={files} setFiles={setFiles} />}
        </div>
        {files.length > 0 && <div className="mt-1"><Button onClick={() => void attempt(flash, reload, "Receipts added.", async () => { await uploadReceipts(client, r.id, files); setFiles([]); })}>Upload {files.length}</Button></div>}
      </td>
      <td className="w-40 p-2 text-xs">
        {paid ? <>
          <Badge tone="good">paid {shortDate(r.paid_date)}</Badge>
          {r.paid_with && r.paid_with !== "check" && <div className="mt-1">{PAID_WITH_LABEL[r.paid_with]}</div>}
          {r.check_number && <div className="mt-1">check #{r.check_number}</div>}
          {r.check_txn_id && <button className="mt-1 text-asu-gold hover:underline" onClick={() => openTxn(r.check_txn_id!)}>in the ledger</button>}
        </> : <Badge tone="warn">owed</Badge>}
        <div><button className="mt-1 text-helios-muted hover:text-helios-danger hover:underline" title="Entered by mistake"
          onClick={() => void ask(deleteQuestion(r)).then((ok) => ok && attempt(flash, reload, "Deleted.", async () => { toggle(r.id, false); await deleteReimbursement(client, r); }))}>Delete</button></div>
      </td>
    </tr>
  );
}

function AddForm({ client, reload, flash, done }: Pick<FinanceProps, "client" | "reload" | "flash"> & { done: () => void }) {
  const [f, setF] = useState({ person: "", amount: "", reason: "", date: today() });
  const [files, setFiles] = useState<File[]>([]);
  async function add() {
    if (!f.person.trim()) { flash("Who is owed?", true); return; }
    const cents = f.amount.trim() ? parseCents(f.amount) : null;
    if (f.amount.trim() && cents === null) { flash(`"${f.amount}" isn't an amount.`, true); return; }
    const ok = await attempt(flash, reload, "Added.", async () => {
      const id = await addReimbursement(client, { person_name: f.person.trim(), amount_cents: cents === null ? null : Math.abs(cents), reason: f.reason, requested_date: f.date || null });
      if (files.length) await attachReceiptsOrUndo(client, id, files, true);
    });
    if (ok) done();
  }
  return (
    <Card className="flex flex-col gap-2">
      <b>Money owed to someone</b>
      <p className="text-xs text-helios-dim">For people who paid for the team (e.g. a hotel on a competition trip). Members can also ask themselves from Agora, under Get reimbursed.</p>
      <div className="flex flex-wrap gap-2">
        <input className={input} placeholder="Person" value={f.person} onChange={(e) => setF({ ...f, person: e.target.value })} />
        <input className={`${input} w-28`} placeholder="Amount $" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <input className={`${input} min-w-[240px] flex-1`} placeholder="What for" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <input type="date" className={input} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} title="When they paid" />
      </div>
      <ReceiptPicker files={files} setFiles={setFiles} />
      <div className="flex gap-2"><Button onClick={() => void add()}>Add</Button><Button kind="ghost" onClick={done}>Cancel</Button></div>
    </Card>
  );
}
