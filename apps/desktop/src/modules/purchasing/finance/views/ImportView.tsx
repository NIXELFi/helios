import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { fmtCents } from "../../lib/money";
import { parseCsv } from "../../lib/paste";
import { Button, Card, Empty } from "../../components/ui";
import { fetchImports, fetchVendors, importTransactions, insertInvoices, type ImportLog } from "../api";
import {
  FORMAT_LABEL, detectFormat, guessGenericMap, matchInvoice, parseChaseCard, parseChaseChecking, parseGeneric, parseInvoices,
  parseSquare, planImport, sha256, type Format, type GenericMap, type Line, type Plan, type VendorRule,
} from "../importers";
import { Badge, accountLabel, attempt, input, shortDate, type FinanceProps } from "./shared";
import {
  StatementError, cardLines, checkingLines, parseCardWords, parseCheckingWords, pdfKind, pdfWords,
  type CardStatement, type CheckingStatement,
} from "../statementPdf";

interface Loaded {
  name: string; sha: string; matrix: string[][];
  pdf?: { card?: CardStatement; checking?: CheckingStatement };   // a statement PDF, already checked against its own totals
}
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

const ACTION: Record<string, [string, "good" | "plain" | "info" | "warn"]> = {
  add: ["new", "good"], duplicate: ["already in the ledger", "plain"], "clears-check": ["clears a check", "info"], "confirms-autopay": ["confirms autopay", "info"],
};

/** Execs: upload bank, card and Square exports and invoice lists. Nothing is written until you press Import. */
export function ImportView({ client, fin, reload, flash, openTxn }: FinanceProps) {
  const [file, setFile] = useState<Loaded | null>(null);
  const [format, setFormat] = useState<Format>("generic");
  const [accountId, setAccountId] = useState<number | null>(null);
  const [map, setMap] = useState<GenericMap | null>(null);
  const [squareCategory, setSquareCategory] = useState("Dues");
  const [statement, setStatement] = useState({ on: false, start: "", closing: "" });
  const [overrides, setOverrides] = useState<Record<number, string>>({});   // row index -> category
  const [rules, setRules] = useState<VendorRule[]>([]);
  const [history, setHistory] = useState<ImportLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);

  const refresh = () => { void fetchImports(client).then(setHistory).catch(() => {}); };
  useEffect(() => { void fetchVendors(client).then(setRules).catch(() => {}); refresh(); }, [client]);

  async function load(f: File) {
    const byKind = (k: string) => fin.accounts.find((a) => a.kind === k && a.active)?.id ?? null;
    const byLast4 = (k: string, last4: string) => fin.accounts.find((a) => a.kind === k && a.last4 === last4)?.id ?? byKind(k);
    if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
      const bytes = await f.arrayBuffer();
      const sha = await sha256(bytes.slice(0));
      try {
        const pages = await pdfWords(bytes);
        const kind = pdfKind(pages);
        if (kind === "unknown") {
          flash("Helios can read Chase checking and Chase card statement PDFs. For anything else (Square), use its CSV export for now.", true);
          return;
        }
        const pdf = kind === "chase-card" ? { card: parseCardWords(pages) } : { checking: parseCheckingWords(pages) };
        setFile({ name: f.name, sha, matrix: [], pdf });
        setFormat(kind);
        setAccountId(kind === "chase-card" ? byLast4("credit_card", pdf.card!.last4) : byLast4("checking", pdf.checking!.last4));
        setOverrides({});
        setStatement({ on: false, start: "", closing: "" });
      } catch (e) {
        flash(e instanceof StatementError ? e.message : `Couldn't read that PDF: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      return;
    }
    if (!/\.csv$/i.test(f.name) && f.type !== "text/csv") { flash("Upload a PDF statement or a CSV export.", true); return; }
    const text = await f.text();
    const matrix = parseCsv(text);
    if (matrix.length < 2) { flash("That file has no rows.", true); return; }
    const fmt = detectFormat(matrix[0]!);
    setFile({ name: f.name, matrix, sha: await sha256(text) });
    setFormat(fmt);
    setMap(guessGenericMap(matrix[0]!));
    setOverrides({});
    setAccountId(fmt === "chase-checking" ? byKind("checking") : fmt === "chase-card" ? byKind("credit_card")
      : fmt === "square" ? fin.accounts.find((a) => /square/i.test(a.name))?.id ?? null : null);
    setStatement({ on: false, start: "", closing: "" });
  }

  const account = fin.accounts.find((a) => a.id === accountId) ?? null;
  const already = file ? history.find((h) => h.sha256 === file.sha)
    ?? (fin.statements.some((st) => st.sha256 === file.sha) ? ({ imported_at: "" } as ImportLog) : undefined) : undefined;
  const pdfLast4 = file?.pdf?.card?.last4 ?? file?.pdf?.checking?.last4;
  const wrongAccount = !!(pdfLast4 && account?.last4 && account.last4 !== pdfLast4);

  const lines: Line[] = useMemo(() => {
    if (!file) return [];
    if (file.pdf?.card) return cardLines(file.pdf.card);
    if (file.pdf?.checking) return checkingLines(file.pdf.checking);
    if (format === "chase-checking") return parseChaseChecking(file.matrix);
    if (format === "chase-card") return parseChaseCard(file.matrix);
    if (format === "square") return parseSquare(file.matrix);
    if (format === "generic" && map && map.date >= 0 && (map.amount >= 0 || map.debit >= 0 || map.credit >= 0)) return parseGeneric(file.matrix, map);
    return [];
  }, [file, format, map]);

  const plan: Plan | null = useMemo(() => {
    if (!file || !account || format === "invoices") return null;
    const card = file.pdf?.card;
    const p = planImport(format, lines, account, {
      fileName: file.name, rules, accounts: fin.accounts, existing: fin.txns, squareCategory,
      source: file.pdf ? `${format}-pdf` : undefined,
      cardStatement: card ? { periodStart: null, closing: card.closing_date }
        : account.kind === "credit_card" && statement.on && statement.closing ? { periodStart: statement.start || null, closing: statement.closing } : null,
    });
    const chk = file.pdf?.checking;
    if (chk) {
      // the statement's own opening and daily balances, keyed like the old ledger's so they never double up
      p.statement = {
        account_id: account.id, period_start: chk.period_start, closing_date: chk.period_end, net_charges_cents: chk.ending_cents - chk.opening_cents,
        purchases_cents: chk.totals.withdrawal + chk.totals.check, credits_cents: chk.totals.deposit, opening_cents: chk.opening_cents, ending_cents: chk.ending_cents,
      } as Plan["statement"];
      const points: [string, number, string][] = [[addDays(chk.period_start, -1), chk.opening_cents, "Opening balance"],
        ...chk.daily_balances.map(([d, c]) => [d, c, "Daily balance"] as [string, number, string])];
      p.balances = points.map(([as_of, balance_cents, what]) => ({
        account_id: account.id, as_of, balance_cents, note: `${what} from ${file.name}`, source_key: `chase-checking-balance:${chk.last4}:${as_of}`,
      }));
    }
    return p;
  }, [file, account, format, lines, rules, fin.accounts, fin.txns, squareCategory, statement]);

  const invoices = useMemo(() => {
    if (!file || format !== "invoices") return [];
    const taken = new Set(fin.evidence.filter((e) => e.txn_id !== null).map((e) => e.txn_id!));
    return parseInvoices(file.matrix, rules).map((inv) => {
      const t = matchInvoice(inv, fin.txns, taken, rules);
      if (t) taken.add(t.id);
      const key = `invoice-csv:${inv.vendor.toLowerCase()}:${inv.order_ref ?? `${inv.date}:${inv.total_cents}`}`;
      const dup = fin.evidence.some((e) => e.source_key === key || (inv.order_ref && e.order_ref === inv.order_ref && e.vendor === inv.vendor));
      return { inv, txn: t, key, dup };
    });
  }, [file, format, rules, fin.txns, fin.evidence]);

  async function run() {
    if (!file) return;
    setBusy(true);
    if (format === "invoices") {
      await attempt(flash, reload, "", async () => {
        const n = await insertInvoices(client, invoices.filter((x) => !x.dup).map(({ inv, txn, key }) => ({
          kind: "invoice", source_file: file.name, source_key: key, vendor: inv.vendor, order_ref: inv.order_ref, date: inv.date,
          total_cents: inv.total_cents, items: inv.items, record_type: "invoice", txn_id: txn?.id ?? null,
          match_method: txn ? "auto" : "", match_score: txn ? 0.9 : 0,
        })));
        flash(`${n} invoice${n === 1 ? "" : "s"} added, ${invoices.filter((x) => x.txn && !x.dup).length} matched to their charge.`);
        setFile(null);
      });
    } else if (plan && account) {
      const adds = plan.lines.filter((p) => p.action === "add").map((p, _i) => {
        const idx = plan.lines.indexOf(p);
        return overrides[idx] ? { ...p.txn, category: overrides[idx]!, needs_review: overrides[idx] === "Needs category" ? p.txn.needs_review : false } : p.txn;
      });
      const pairs = plan.lines.flatMap((p) => (p.action === "add" && p.pair ? [p.pair] : []));
      await attempt(flash, reload, "", async () => {
        const r = await importTransactions(client, {
          file: { sha256: file.sha, file_name: file.name, format, account_id: account.id },
          statement: plan.statement, rows: [...adds, ...pairs, ...plan.extra],
          clears: plan.lines.filter((p) => p.action === "clears-check").map((p) => ({ txn_id: p.matchId!, cleared_date: p.line.date })),
          confirms: plan.lines.filter((p) => p.action === "confirms-autopay").map((p) => ({ transfer_group: p.group!, date: p.line.date, amount_cents: p.amount_cents })),
          balances: plan.balances,
        });
        flash(`Imported: ${r.added} new line${r.added === 1 ? "" : "s"}${r.cleared ? `, ${r.cleared} check${r.cleared > 1 ? "s" : ""} cleared` : ""}`
          + `${r.confirmed ? ", autopay confirmed" : ""}${r.balances ? `, ${r.balances} bank balance${r.balances > 1 ? "s" : ""}` : ""}. New lines needing a category or subteam are under Ledger -> Needs attention.`);
        setFile(null);
      });
    }
    setBusy(false);
    refresh();
  }

  const counts = plan ? plan.lines.reduce<Record<string, number>>((m, p) => ({ ...m, [p.action]: (m[p.action] ?? 0) + 1 }), {}) : {};
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void load(f); };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
          onClick={() => pick.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") pick.current?.click(); }}
          className={`cursor-pointer rounded-lg border border-dashed p-6 text-center ${over ? "border-asu-gold bg-asu-gold/10" : "border-helios-line hover:bg-helios-strip"}`}>
          <div className="font-semibold">Drop a CSV here or <span className="text-asu-gold">choose a file</span></div>
          <div className="mt-1 text-xs text-helios-dim">Chase checking or card statement (PDF) | Chase CSV export | Square transactions export (dues, sales) | a list of invoices | any other bank CSV</div>
          <input ref={pick} type="file" accept=".csv,text/csv,.pdf,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ""; }} />
        </div>
        <p className="mt-2 text-xs text-helios-dim">Nothing is saved until you press Import. The same file can't be imported twice, and lines already in the ledger (for example from a PDF statement) are skipped.</p>
      </Card>

      {file && (
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <div><div className="text-xs text-helios-dim">File</div><b>{file.name}</b> <span className="text-xs text-helios-dim">
              ({file.pdf?.card ? `card statement closing ${shortDate(file.pdf.card.closing_date)}, ${file.pdf.card.lines.length} lines, adds up`
                : file.pdf?.checking ? `checking statement ${shortDate(file.pdf.checking.period_start)} to ${shortDate(file.pdf.checking.period_end)}, ${file.pdf.checking.lines.length} lines, adds up`
                : `${file.matrix.length - 1} rows`})</span></div>
            <label className="flex flex-col gap-1">What it is
              <select className={input} value={format} disabled={!!file.pdf} onChange={(e) => setFormat(e.target.value as Format)}>
                {(Object.keys(FORMAT_LABEL) as Format[]).map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
              </select></label>
            {format !== "invoices" && (
              <label className="flex flex-col gap-1">Into account
                <select className={input} value={accountId ?? ""} onChange={(e) => setAccountId(Number(e.target.value) || null)}>
                  <option value="">Pick...</option>{fin.accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
                </select></label>
            )}
            {format === "square" && (
              <label className="flex flex-col gap-1">Payments are
                <select className={input} value={squareCategory} onChange={(e) => setSquareCategory(e.target.value)}>
                  {fin.categories.filter((c) => c.direction === "in").map((c) => <option key={c.name}>{c.name}</option>)}
                </select></label>
            )}
            {account?.kind === "credit_card" && !file.pdf && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex items-center gap-1 pb-1.5"><input type="checkbox" checked={statement.on} onChange={(e) => setStatement({ ...statement, on: e.target.checked })} />This is a full statement</label>
                {statement.on && <>
                  <label className="flex flex-col gap-1">From<input type="date" className={input} value={statement.start} onChange={(e) => setStatement({ ...statement, start: e.target.value })} /></label>
                  <label className="flex flex-col gap-1">Closed on<input type="date" className={input} value={statement.closing} onChange={(e) => setStatement({ ...statement, closing: e.target.value })} /></label>
                </>}
              </div>
            )}
          </div>

          {already && <div className="rounded-md border border-helios-danger/40 bg-helios-danger/10 px-3 py-2 text-sm text-helios-danger">This exact file was already imported{already.imported_at ? ` on ${shortDate(already.imported_at)}` : ""}.</div>}
          {wrongAccount && <div className="rounded-md border border-helios-danger/40 bg-helios-danger/10 px-3 py-2 text-sm text-helios-danger">This statement is for the account ending {pdfLast4}, but the account picked ends {account?.last4}.</div>}

          {format === "generic" && map && file && <MapPicker headers={file.matrix[0]!} map={map} setMap={setMap} />}

          {format === "invoices" ? (
            invoices.length ? (
              <div className="max-h-[420px] overflow-auto rounded-md border border-helios-line">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-helios-strip text-helios-dim"><tr><th className="p-2 text-left">Vendor</th><th className="p-2 text-left">Date</th><th className="p-2 text-left">Order #</th><th className="p-2 text-right">Total</th><th className="p-2 text-left">Matches</th></tr></thead>
                  <tbody>{invoices.map(({ inv, txn, dup }) => (
                    <tr key={inv.n} className={`border-t border-helios-line ${dup ? "opacity-50" : ""}`}>
                      <td className="p-2">{inv.vendor}</td><td className="p-2">{inv.date}</td><td className="p-2">{inv.order_ref}</td>
                      <td className="p-2 text-right tabular-nums">{fmtCents(inv.total_cents)}</td>
                      <td className="p-2">{dup ? <Badge>already added</Badge> : txn ? <button className="text-asu-gold hover:underline" onClick={() => openTxn(txn.id)}>{shortDate(txn.date)} {txn.vendor || txn.description}</button> : <Badge tone="warn">no charge found yet</Badge>}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            ) : <Empty>No rows with a vendor. The file needs Vendor, Date, Total and (ideally) Order # columns.</Empty>
          ) : !account ? <Empty>Pick the account this file belongs to.</Empty>
            : !plan?.lines.length ? <Empty>No lines read. {format === "generic" ? "Pick the date and amount columns above." : "Check it's the right kind of file."}</Empty>
            : (
              <>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge tone="good">{counts.add ?? 0} new</Badge>
                  {counts.duplicate ? <Badge>{counts.duplicate} already in the ledger</Badge> : null}
                  {counts["clears-check"] ? <Badge tone="info">{counts["clears-check"]} checks cleared</Badge> : null}
                  {counts["confirms-autopay"] ? <Badge tone="info">autopay confirmed</Badge> : null}
                  {plan.balances.length ? <Badge tone="info">{plan.balances.length} bank balances</Badge> : null}
                  {plan.statement ? <Badge tone="info">statement closing {shortDate(plan.statement.closing_date)}: {fmtCents(plan.statement.net_charges_cents)}</Badge> : null}
                  {plan.extra.length ? <Badge tone="info">+{plan.extra.length} linked lines (autopay / Square payouts)</Badge> : null}
                </div>
                <div className="max-h-[460px] overflow-auto rounded-md border border-helios-line">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-helios-strip text-helios-dim"><tr><th className="p-2 text-left">Date</th><th className="p-2 text-left">From the file</th><th className="p-2 text-right">Amount</th><th className="p-2 text-left">Will be</th><th className="p-2 text-left">Category</th></tr></thead>
                    <tbody>{plan.lines.map((p, i) => (
                      <tr key={i} className={`border-t border-helios-line align-top ${p.action === "duplicate" ? "opacity-50" : ""}`}>
                        <td className="whitespace-nowrap p-2">{shortDate(p.line.date)}</td>
                        <td className="p-2">{p.line.description}{p.line.reference ? <span className="text-helios-dim"> | {p.line.reference}</span> : null}</td>
                        <td className={`p-2 text-right tabular-nums ${p.line.amount_cents < 0 ? "text-helios-danger" : "text-helios-success"}`}>{fmtCents(p.line.amount_cents)}</td>
                        <td className="p-2">
                          <Badge tone={ACTION[p.action]![1]}>{ACTION[p.action]![0]}</Badge>
                          {p.action === "add" && <span className="ml-1 text-helios-dim">{p.txn.kind}{p.txn.vendor ? ` | ${p.txn.vendor}` : ""}</span>}
                          {p.matchId && <button className="ml-1 text-asu-gold hover:underline" onClick={() => openTxn(p.matchId!)}>#{p.matchId}</button>}
                          {p.pair && <div className="text-helios-dim">and -{fmtCents(p.line.amount_cents)} out of Square</div>}
                          {p.action === "add" && p.txn.review_note && <div className="text-asu-gold">{p.txn.review_note}</div>}
                        </td>
                        <td className="p-2">{p.action === "add" && p.txn.kind !== "transfer" ? (
                          <select className={`${input} text-xs`} value={overrides[i] ?? p.txn.category} onChange={(e) => setOverrides({ ...overrides, [i]: e.target.value })}>
                            {fin.categories.map((c) => <option key={c.name}>{c.name}</option>)}
                          </select>) : <span className="text-helios-dim">{p.txn.category}</span>}</td>
                      </tr>))}</tbody>
                  </table>
                </div>
              </>
            )}

          <div className="flex gap-2">
            <Button disabled={busy || !!already || wrongAccount || (format === "invoices" ? !invoices.some((x) => !x.dup) : !plan?.lines.length)} onClick={() => void run()}>
              {busy ? "Importing..." : "Import"}</Button>
            <Button kind="ghost" onClick={() => setFile(null)}>Cancel</Button>
          </div>
        </Card>
      )}

      <Card className="p-0">
        <div className="border-b border-helios-line px-4 py-2 font-semibold">Past uploads</div>
        {history.length ? (
          <table className="w-full text-sm">
            <tbody>{history.map((h) => (
              <tr key={h.id} className="border-t border-helios-line">
                <td className="p-2 text-xs text-helios-dim">{shortDate(h.imported_at)}</td><td className="p-2">{h.file_name}</td>
                <td className="p-2 text-xs">{FORMAT_LABEL[h.format as Format] ?? h.format}</td>
                <td className="p-2 text-xs">{accountLabel(fin.accounts.find((a) => a.id === h.account_id))}</td>
                <td className="p-2 text-right text-xs">{h.rows_added} lines added</td>
              </tr>))}</tbody>
          </table>
        ) : <div className="p-4 text-sm text-helios-muted">Nothing uploaded yet.</div>}
      </Card>
    </div>
  );
}

function MapPicker({ headers, map, setMap }: { headers: string[]; map: GenericMap; setMap: (m: GenericMap) => void }) {
  const field = (k: keyof Omit<GenericMap, "flip">, label: string) => (
    <label className="flex flex-col gap-1 text-xs">{label}
      <select className={input} value={map[k]} onChange={(e) => setMap({ ...map, [k]: Number(e.target.value) })}>
        <option value={-1}>-</option>{headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
      </select></label>
  );
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-helios-line p-2">
      {field("date", "Date")}{field("description", "Description")}{field("amount", "Amount (+ in, - out)")}
      <span className="pb-1.5 text-xs text-helios-dim">or</span>{field("debit", "Money out")}{field("credit", "Money in")}
      {field("reference", "Reference")}{field("balance", "Balance")}
      <label className="flex items-center gap-1 pb-1.5 text-xs"><input type="checkbox" checked={map.flip} onChange={(e) => setMap({ ...map, flip: e.target.checked })} />Amounts are reversed (charges positive)</label>
    </div>
  );
}
