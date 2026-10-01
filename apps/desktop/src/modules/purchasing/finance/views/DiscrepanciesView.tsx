import { useMemo, useState } from "react";
import { fmtCents } from "../../lib/money";
import { Button, Card, Empty } from "../../components/ui";
import { reopenDiscrepancy, resolveDiscrepancy, saveCsv, toCsv } from "../api";
import { allEvidence, discrepancies } from "../compute";
import type { Discrepancy, Evidence } from "../discrepancies";
import { today } from "../useFinance";
import { Badge, attempt, input, shortDate, whereLabel, type FinanceProps } from "./shared";

const TONE = { high: "bad", medium: "warn", low: "plain" } as const;

/** Anything that doesn't add up, grouped, each with the lines and documents behind it. */
export function DiscrepanciesView({ client, fin, pur, reload, flash, me, openTxn }: FinanceProps) {
  const where = whereLabel(pur);
  const evidence = useMemo(() => allEvidence(fin, pur.items, where), [fin, pur.items]);
  const { open, resolved } = useMemo(() => discrepancies(fin, evidence), [fin, evidence]);
  const evById = new Map(evidence.map((e) => [e.id, e]));
  const [showResolved, setShowResolved] = useState(false);

  const groups = new Map<string, Discrepancy[]>();
  for (const d of open) groups.set(`${d.severity}|${d.kind}`, [...(groups.get(`${d.severity}|${d.kind}`) ?? []), d]);

  async function exportCsv() {
    const rows = [...open.map((d) => ({ d, status: "open", note: "" })), ...resolved.map((r) => ({ d: r.d, status: "resolved", note: r.note }))];
    const csv = toCsv(rows.map(({ d, status, note }) => ({
      severity: d.severity, kind: d.kind, message: d.message, amount: d.amount_cents === null ? "" : (d.amount_cents / 100).toFixed(2),
      transactions: d.txn_ids.join(" "), status, note, key: d.key,
    })));
    if (await saveCsv(`sdm-discrepancies-${today()}.csv`, csv)) flash("Exported.");
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-helios-dim">{open.length} open. Each flag links to what it's based on, so you can check the reasoning. Marking one resolved keeps it resolved when the data is recomputed.</p>
        <Button kind="ghost" onClick={() => void exportCsv()}>Export CSV</Button>
      </div>
      {!open.length && <Empty>Everything ties out.</Empty>}
      {[...groups.entries()].map(([k, ds]) => (
        <Card key={k} className="p-0">
          <div className="flex items-center gap-2 border-b border-helios-line px-4 py-2">
            <Badge tone={TONE[ds[0]!.severity]}>{ds[0]!.severity}</Badge><b>{ds[0]!.kind}</b><span className="text-xs text-helios-dim">({ds.length})</span>
          </div>
          <div className="divide-y divide-helios-line">
            {ds.map((d) => <Item key={d.key} d={d} evById={evById} {...{ client, reload, flash, me, openTxn }} />)}
          </div>
        </Card>
      ))}
      {resolved.length > 0 && (
        <Card className="p-0">
          <button className="w-full px-4 py-2 text-left font-semibold" onClick={() => setShowResolved((s) => !s)}>{showResolved ? "v" : ">"} Resolved ({resolved.length})</button>
          {showResolved && (
            <div className="divide-y divide-helios-line border-t border-helios-line">
              {resolved.map(({ d, note, by, at }) => (
                <div key={d.key} className="flex items-start gap-3 px-4 py-2 text-sm">
                  <div className="flex-1">
                    <div className="text-helios-dim">{d.message}</div>
                    <div className="text-xs">Resolved by {by || "?"} {shortDate(at)}{note ? `: ${note}` : ""}</div>
                  </div>
                  <Button kind="ghost" onClick={() => void attempt(flash, reload, "Reopened.", () => reopenDiscrepancy(client, d.key))}>Reopen</Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Item({ d, evById, client, reload, flash, me, openTxn }: Pick<FinanceProps, "client" | "reload" | "flash" | "me" | "openTxn"> & { d: Discrepancy; evById: Map<number, Evidence> }) {
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="px-4 py-2 text-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div>{d.message}</div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
            {d.txn_ids.map((id) => <button key={id} className="rounded border border-helios-line px-1.5 py-0.5 hover:border-asu-gold hover:text-asu-gold" onClick={() => openTxn(id)}>ledger line #{id}</button>)}
            {d.evidence_ids.slice(0, 8).map((id) => {
              const e = evById.get(id);
              return <span key={id} className="rounded border border-helios-line px-1.5 py-0.5 text-helios-dim" title={e?.items}>
                {e ? `${e.kind === "request" ? e.source_file : e.kind} | ${e.vendor ?? ""} ${fmtCents(e.total_cents)}` : `#${id}`}</span>;
            })}
            {d.evidence_ids.length > 8 && <span className="text-helios-muted">+{d.evidence_ids.length - 8} more</span>}
          </div>
        </div>
        {!resolving && <Button kind="ghost" onClick={() => setResolving(true)}>Resolve</Button>}
      </div>
      {resolving && (
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void attempt(flash, reload, "Marked resolved.", () => resolveDiscrepancy(client, d.key, note, me)); }}>
          <input autoFocus className={`${input} flex-1`} placeholder="Why it's fine (e.g. two hotel rooms, refunded)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button type="submit">Resolve</Button><Button kind="ghost" onClick={() => setResolving(false)}>Cancel</Button>
        </form>
      )}
    </div>
  );
}
