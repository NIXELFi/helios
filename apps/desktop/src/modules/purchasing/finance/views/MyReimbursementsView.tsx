import { useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import { fmtCents, parseCents } from "../../lib/money";
import { can } from "../../lib/api";
import type { PurchasingData } from "../../lib/usePurchasing";
import { Button, Card, Empty, useConfirm } from "../../components/ui";
import { attachReceiptsOrUndo, deleteReceipt, requestReimbursement, uploadReceipts, withdrawReimbursement, type ReimbursementWithReceipts } from "../api";
import { today } from "../../lib/dates";
import { Badge, attempt, input, shortDate, whereLabel } from "./shared";
import { ReceiptList, ReceiptPicker, removeReceiptQuestion } from "./Receipts";

const STATUS: Record<ReimbursementWithReceipts["status"], [string, "warn" | "info" | "good" | "bad"]> = {
  requested: ["Waiting for an exec", "info"], owed: ["Approved, payment coming", "warn"], paid: ["Paid", "good"], denied: ["Declined", "bad"],
};

/** Anyone on the team: ask to be paid back for something you bought for the team, with the receipt. */
export function MyReimbursementsView({ client, pur, mine, userId, reload, flash }: {
  client: SupabaseClient; pur: PurchasingData; mine: ReimbursementWithReceipts[]; userId: string | null;
  reload: () => Promise<void>; flash: (m: string, e?: boolean) => void;
}) {
  const where = whereLabel(pur);
  // default to the member's own subteam
  const mySubteams = pur.subteams.filter((s) => can(pur.caps, "purchasing.request", s.id) && !pur.caps?.org.has("purchasing.request"));
  const [f, setF] = useState({ amount: "", reason: "", date: today(), project_id: pur.projects[0]?.id ?? "", subteam_id: mySubteams[0]?.id ?? "", item_id: "" });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const myItems = pur.items.filter((i) => i.requester_id === userId && !["DENIED", "CANCELLED", "HAVE"].includes(i.status));
  const own = mine.filter((r) => r.user_id === userId).sort((a, b) => b.id - a.id);
  const [ask, confirmDialog] = useConfirm();

  async function submit() {
    const cents = parseCents(f.amount);
    if (!cents || cents <= 0) { flash("Enter the amount you paid.", true); return; }
    if (!f.reason.trim()) { flash("Say what it was for.", true); return; }
    if (!files.length && !(await ask({
      title: "No receipt attached", body: "Execs usually need one before paying you back. Send anyway?", confirmLabel: "Send anyway",
    }))) return;
    setBusy(true);
    const ok = await attempt(flash, reload, "Sent. The execs have been told; you'll get a notification when it's decided.", async () => {
      const id = await requestReimbursement(client, {
        amount_cents: Math.abs(cents), reason: f.reason, date: f.date || null,
        project_id: f.project_id || null, subteam_id: f.subteam_id || null, item_id: f.item_id || null,
      });
      if (files.length) await attachReceiptsOrUndo(client, id, files, false);
    });
    setBusy(false);
    if (ok) { setF({ ...f, amount: "", reason: "", item_id: "" }); setFiles([]); }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {confirmDialog}
      <Card className="flex flex-col gap-3 self-start">
        <b>Ask to be paid back</b>
        <p className="text-xs text-helios-dim">Bought something for the team with your own money? Tell us what and attach the receipt. An exec checks it and you're paid back by check or in cash.</p>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="flex flex-col gap-1">Amount you paid<input className={input} placeholder="$0.00" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
          <label className="flex flex-col gap-1">When<input type="date" className={input} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label className="col-span-2 flex flex-col gap-1">What it was for
            <input className={input} placeholder="e.g. Hotel for the competition trip" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
          <label className="flex flex-col gap-1">Car
            <select className={input} value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
              <option value="">Whole team</option>{pur.projects.map((p) => <option key={p.id} value={p.id}>{p.car_code}</option>)}
            </select></label>
          <label className="flex flex-col gap-1">Subteam
            <select className={input} value={f.subteam_id} onChange={(e) => setF({ ...f, subteam_id: e.target.value })}>
              <option value="">Not sure</option>{pur.subteams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          {myItems.length > 0 && (
            <label className="col-span-2 flex flex-col gap-1">Part on the list (optional)
              <select className={input} value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })}>
                <option value="">None</option>{myItems.map((i) => <option key={i.id} value={i.id}>{i.code} {i.title}</option>)}
              </select></label>
          )}
        </div>
        <ReceiptPicker files={files} setFiles={setFiles} />
        <Button disabled={busy} onClick={() => void submit()}>{busy ? "Sending..." : "Send to the execs"}</Button>
      </Card>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-helios-dim">Your requests</h2>
        {!own.length ? <Empty>You haven't asked for anything yet.</Empty> : (
          <div className="flex flex-col gap-2">
            {own.map((r) => {
              const [label, tone] = STATUS[r.status];
              const open = r.status === "requested";
              return (
                <Card key={r.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div>{r.reason}</div>
                      <div className="text-xs text-helios-dim">{[shortDate(r.requested_date), where(r.project_id, r.subteam_id)].filter(Boolean).join(" | ")}</div>
                    </div>
                    <div className="text-right"><b className="tabular-nums">{fmtCents(r.amount_cents)}</b><div><Badge tone={tone}>{label}</Badge></div></div>
                  </div>
                  {r.status === "denied" && r.denied_reason && <div className="mt-1 text-xs text-helios-danger">{r.denied_reason}</div>}
                  {r.status === "paid" && <div className="mt-1 text-xs text-helios-dim">Paid {shortDate(r.paid_date)}{r.paid_with === "cash_box" || r.paid_with === "bank_cash" ? ", in cash" : r.check_number ? `, check #${r.check_number}` : ""}</div>}
                  <div className="mt-2"><ReceiptList client={client} receipts={r.reimbursement_receipts}
                    onDelete={open ? (x) => void ask(removeReceiptQuestion(x)).then((ok) => ok && attempt(flash, reload, "Receipt removed.", () => deleteReceipt(client, x))) : undefined} /></div>
                  {open && <AddMore {...{ client, reload, flash }} r={r} />}
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function AddMore({ client, r, reload, flash }: { client: SupabaseClient; r: ReimbursementWithReceipts; reload: () => Promise<void>; flash: (m: string, e?: boolean) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [ask, confirmDialog] = useConfirm();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {confirmDialog}
      <div className="min-w-[160px] flex-1"><ReceiptPicker compact files={files} setFiles={setFiles} /></div>
      {files.length > 0 && <Button onClick={() => void attempt(flash, reload, "Receipts added.", async () => { await uploadReceipts(client, r.id, files); setFiles([]); })}>Upload</Button>}
      <Button kind="ghost" onClick={() => void ask({ title: "Withdraw request", body: "Withdraw this request? Its receipts are removed too.", confirmLabel: "Withdraw", danger: true })
        .then((ok) => ok && attempt(flash, reload, "Withdrawn.", () => withdrawReimbursement(client, r)))}>Withdraw</Button>
    </div>
  );
}
