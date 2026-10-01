import { useState } from "react";
import { centsToInput, fmtCents, parseCents } from "../../lib/money";
import { Button, Card, useConfirm } from "../../components/ui";
import { deleteAccount, saveAccount } from "../api";
import type { Account, AccountKind } from "../ledger";
import { Badge, attempt, input, shortDate, type FinanceProps } from "./shared";

const KINDS: [AccountKind, string][] = [
  ["checking", "Bank account"], ["credit_card", "Credit card"], ["holding", "Holding (Square, cash box)"],
  ["university", "ASU account"], ["crowdfunding", "Crowdfunding"],
];

/** The accounts the ledger tracks. Only the last four digits of any number are stored. */
export function AccountsView({ client, fin, pur, reload, flash }: FinanceProps) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-helios-dim">Only the last four digits of an account or card number are ever stored. A card is money owed, paid from the account it's linked to; it's never a pot of money.</p>
      {fin.accounts.map((a) => <AccountRow key={a.id} a={a} {...{ client, fin, pur, reload, flash }} />)}
      {adding ? <AccountRow a={null} {...{ client, fin, pur, reload, flash }} done={() => setAdding(false)} />
        : <div><Button kind="ghost" onClick={() => setAdding(true)}>+ Account</Button></div>}
    </div>
  );
}

function AccountRow({ a, client, fin, pur, reload, flash, done }: Pick<FinanceProps, "client" | "fin" | "pur" | "reload" | "flash"> & { a: Account | null; done?: () => void }) {
  const checking = fin.accounts.find((x) => x.kind === "checking");
  const [f, setF] = useState(() => ({
    name: a?.name ?? "", kind: a?.kind ?? ("holding" as AccountKind), last4: a?.last4 ?? "", holder: a?.holder ?? "",
    limit: centsToInput(a?.credit_limit_cents), notes: a?.notes ?? "", active: a?.active ?? true, project_id: a?.project_id ?? "",
  }));
  const statements = a ? fin.statements.filter((s) => s.account_id === a.id) : [];
  const [ask, confirmDialog] = useConfirm();
  const used = a ? fin.txns.filter((t) => t.account_id === a.id).length + fin.balances.filter((b) => b.account_id === a.id).length + statements.length : 0;
  async function save() {
    if (f.last4 && !/^\d{4}$/.test(f.last4)) { flash("Last four digits only, please.", true); return; }
    if (!f.name.trim()) { flash("Give the account a name.", true); return; }
    const ok = await attempt(flash, reload, a ? "Saved." : "Account added.", () => saveAccount(client, {
      id: a?.id, name: f.name.trim(), kind: f.kind, last4: f.last4 || null, holder: f.holder || null,
      credit_limit_cents: f.kind === "credit_card" ? parseCents(f.limit) : null, notes: f.notes, active: f.active,
      project_id: f.project_id || null,
      // a card is paid from checking; anything else isn't paid from anywhere
      ...(!a || a.kind !== f.kind ? { paid_from_account_id: f.kind === "credit_card" ? (a?.paid_from_account_id ?? checking?.id ?? null) : null } : {}),
    }));
    if (ok) done?.();
  }
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">Name<input className={`${input} w-56`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="flex flex-col gap-1">Type
          <select className={input} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as AccountKind })}>
            {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
        <label className="flex flex-col gap-1">Last 4<input className={`${input} w-16`} maxLength={4} value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value.replace(/\D/g, "") })} /></label>
        <label className="flex flex-col gap-1">{f.kind === "credit_card" ? "Cardholder" : "Holder"}<input className={`${input} w-40`} value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} /></label>
        {f.kind === "credit_card" && <label className="flex flex-col gap-1">Limit per cycle $<input className={`${input} w-24`} value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></label>}
        <label className="flex flex-col gap-1">Car
          <select className={input} value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
            <option value="">Shared</option>{pur.projects.map((p) => <option key={p.id} value={p.id}>{p.car_code}</option>)}
          </select></label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">Notes<input className={input} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        <label className="flex items-center gap-1 pb-1.5"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active</label>
        <Button onClick={() => void save()}>{a ? "Save" : "Add"}</Button>
        {!a && <Button kind="ghost" onClick={done}>Cancel</Button>}
        {a && <Button kind="danger" title={used ? "This account has lines, balances or statements: untick Active to hide it instead" : "Delete this account"}
          onClick={() => void ask({ title: `Delete ${a.name}?`, confirmLabel: "Delete", danger: true,
            body: used ? `${a.name} has ${used} ledger line(s), balance(s) or statement(s), so it can't be deleted. Untick Active to hide it instead.`
              : "It has nothing recorded against it, so it can be deleted. Add it again any time." })
            .then((ok) => { if (ok && !used) void attempt(flash, reload, `${a.name} deleted.`, () => deleteAccount(client, a.id)); })}>Delete</Button>}
      </div>
      {confirmDialog}
      {a && a.kind !== f.kind && used > 0 && (f.kind === "checking" || f.kind === "credit_card" || a.kind === "checking" || a.kind === "credit_card") && (
        <div className="mt-2 text-xs text-asu-gold">Changing a bank account or card's type changes how its {used} recorded line(s) count toward Available and the card. Check the Overview after saving.</div>
      )}
      {a?.kind === "credit_card" && a.paid_from_account_id && <div className="mt-2 text-xs text-helios-dim">Paid from {fin.accounts.find((x) => x.id === a.paid_from_account_id)?.name}.</div>}
      {statements.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          <span className="text-helios-dim">Statements:</span>
          {statements.map((s) => <Badge key={s.id} title={s.source_file}>{shortDate(s.closing_date)}{s.ending_cents !== null ? ` | ${fmtCents(s.ending_cents)}` : ` | ${fmtCents(s.net_charges_cents)}`}</Badge>)}
        </div>
      )}
    </Card>
  );
}
