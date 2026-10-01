import { useMemo, useState } from "react";
import { importItems, type Item } from "../../lib/api";
import { mapHeaders, looksLikeHeader, parseCsv, toRows, type NewRow } from "../../lib/paste";
import { guessCar, guessSubteam } from "../../lib/airtableFiles";
import { normalizeVendor } from "../importers";
import { restoreLedger, type RestoreResult } from "../api";
import { Button, Card } from "../../components/ui";
import { Badge, input, type FinanceProps } from "./shared";

type Export = Record<string, unknown[]> & { source?: string; exported_at?: string };
type Named = { program?: string; subteam?: string };

/**
 * Execs: fill Agora from what the team already has. The standalone ledger's
 * export restores everything in one go (only into an empty Agora); Airtable
 * CSV exports add parts lists, a whole folder at a time. Statements, Square
 * and invoice files are under Upload files.
 */
export function BringInDataView(p: FinanceProps & { go: (view: string) => void }) {
  const empty = !p.fin.txns.length && !p.fin.reimbursements.length && !p.pur.items.length && !p.fin.balances.length;
  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <p className="text-sm text-helios-dim">
        Bring in the books and parts lists the team kept before Agora. Bank and card statements (PDF or CSV), Square exports and invoice lists
        go in <button className="text-asu-gold hover:underline" onClick={() => p.go("import")}>Upload files</button>.
      </p>
      <RestoreCard {...p} empty={empty} />
      <AirtableCard {...p} />
    </div>
  );
}

// ---------------------------------------------------------------- restore

function RestoreCard({ client, pur, reload, flash, empty }: FinanceProps & { empty: boolean }) {
  const [file, setFile] = useState<{ name: string; data: Export } | null>(null);
  const [cars, setCars] = useState<{ IC: string; EV: string }>({ IC: "", EV: "" });
  const [map, setMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<RestoreResult | null>(null);

  const names = useMemo(() => {
    if (!file) return [];
    const s = new Set<string>();
    for (const k of ["allocations", "line_item_allocations", "budgets", "evidence"]) {
      for (const r of (file.data[k] ?? []) as Named[]) if (r.subteam) s.add(r.subteam);
    }
    return [...s].sort();
  }, [file]);

  async function pick(f: File) {
    setDone(null);
    try {
      const data = JSON.parse(await f.text()) as Export;
      if (data.source !== "sdm-ledger") { flash("That isn't an export from the SDM ledger (helios-export.json).", true); return; }
      setFile({ name: f.name, data });
      setCars({ IC: guessCar("IC", pur.projects) ?? "", EV: guessCar("EV", pur.projects) ?? "" });
      // the export's own subteam list knows the old tab names ("Brakess", "Accumulator")
      const aliases = new Map<string, string[]>();
      for (const r of (data.subteams ?? []) as { subteam: string; aliases?: string }[]) {
        aliases.set(r.subteam, [r.subteam, ...String(r.aliases ?? "").split("|").map((a) => a.replace(/^(IC|EV)\s+/, "").trim()).filter(Boolean)]);
      }
      const m: Record<string, string> = {};
      for (const k of ["allocations", "line_item_allocations", "budgets", "evidence"]) {
        for (const r of (data[k] ?? []) as Named[]) {
          if (!r.subteam || m[r.subteam] !== undefined) continue;
          m[r.subteam] = (aliases.get(r.subteam) ?? [r.subteam]).map((n) => guessSubteam(n, pur.subteams)).find(Boolean) ?? "";
        }
      }
      setMap(m);
    } catch (e) { flash(`Couldn't read that file: ${e instanceof Error ? e.message : String(e)}`, true); }
  }

  const count = (k: string) => (file?.data[k] ?? []).length;
  const unmapped = names.filter((n) => !map[n]);

  async function restore() {
    if (!file) return;
    setBusy(true);
    try {
      const r = await restoreLedger(client, file.data, cars, map);
      setDone(r);
      await reload();
      flash("Restored. Check the Overview and the Ledger against the old ledger.");
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
    setBusy(false);
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <b>Restore from the old ledger</b> {empty ? <Badge tone="info">Agora is empty</Badge> : <Badge>Agora already has data</Badge>}
        <p className="mt-1 text-xs text-helios-dim">
          The CFO's standalone ledger (sdm-purchasing-tool) exports everything as <b>helios-export.json</b>: accounts, statements, every
          ledger line and its split, invoices, weekly balances, reimbursements, budgets, resolved discrepancies, vendors and the Airtable parts
          list with its statuses. This loads all of it exactly as it was. It only works on an empty Agora, so it can't overwrite live books.
        </p>
      </div>
      {!empty && !done && <p className="text-xs text-asu-gold">Agora already has ledger lines, reimbursements or parts, so a restore would be refused. Use the Airtable upload below for parts lists.</p>}
      <label className="w-fit cursor-pointer rounded-md border border-helios-line px-3 py-1.5 text-sm hover:bg-helios-strip">
        {file ? `${file.name}: pick another` : "Pick helios-export.json"}
        <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} />
      </label>

      {file && !done && (
        <>
          <p className="text-sm">
            {count("accounts")} accounts, {count("statements")} statements, {count("transactions")} ledger lines, {count("evidence")} invoices,{" "}
            {count("balance_entries")} weekly balances, {count("reimbursements")} reimbursements, {count("budgets")} budget lines,{" "}
            {count("line_items")} parts{file.data.exported_at ? `, exported ${String(file.data.exported_at).slice(0, 10)}` : ""}.
          </p>
          <div className="flex flex-wrap gap-4 text-sm">
            {(["IC", "EV"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2">{k} car is
                <select className={input} value={cars[k]} onChange={(e) => setCars({ ...cars, [k]: e.target.value })}>
                  <option value="">pick...</option>{pur.projects.map((x) => <option key={x.id} value={x.id}>{x.car_code} {x.name}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div>
            <div className="mb-1 text-xs text-helios-dim">Which Helios subteam each of the old ledger's subteams is:</div>
            <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {names.map((n) => (
                <label key={n} className="flex items-center justify-between gap-2 text-sm">
                  <span className={map[n] ? "" : "text-asu-gold"}>{n}</span>
                  <select className={`${input} w-44`} value={map[n] ?? ""} onChange={(e) => setMap({ ...map, [n]: e.target.value })}>
                    <option value="">pick...</option>{pur.subteams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              ))}
            </div>
            {unmapped.length > 0 && <p className="mt-1 text-xs text-asu-gold">Pick a subteam for {unmapped.join(", ")}. If Helios doesn't have one, add it in Helios first, or pick the closest.</p>}
          </div>
          <div><Button disabled={busy || !cars.IC || !cars.EV || cars.IC === cars.EV || unmapped.length > 0} onClick={() => void restore()}>
            {busy ? "Restoring..." : "Restore everything"}</Button></div>
        </>
      )}

      {done && (
        <div className="rounded-md border border-helios-success/40 bg-helios-success/10 p-3 text-sm">
          Restored {done.accounts} accounts, {done.statements} statements, {done.transactions} ledger lines, {done.invoices} invoices,{" "}
          {done.balances} weekly balances, {done.reimbursements} reimbursements, {done.budget_lines} budget lines and {done.parts} parts.
          {done.skipped.length > 0 && <div className="mt-1 text-xs text-helios-dim">Budget lines already set up, kept as they were: {done.skipped.join(", ")}.</div>}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Airtable

interface CsvFile { path: string; rows: NewRow[]; car: string; subteam: string }

function AirtableCard({ client, pur, reload, flash }: FinanceProps) {
  const [files, setFiles] = useState<CsvFile[]>([]);
  const [busy, setBusy] = useState(false);

  async function pick(list: FileList | null) {
    const out: CsvFile[] = [];
    for (const f of Array.from(list ?? [])) {
      if (!/\.csv$/i.test(f.name)) continue;
      const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const matrix = parseCsv(await f.text());
      if (!matrix.length || !looksLikeHeader(matrix[0]!)) { flash(`${path}: no header row, skipped.`, true); continue; }
      const rows = toRows(matrix.slice(1), mapHeaders(matrix[0]!)).map((r, k) => {
        // "DATE NEEDED" in the team's sheets isn't a need-by date (it holds
        // request or order dates), so it's kept as written, not as Needed by
        const { needed_by, ...rest } = r;
        return { ...rest, vendor: r.vendor ? normalizeVendor(r.vendor, pur.vendors) : undefined,
          date_needed_raw: needed_by ?? "", source: `airtable:${path} row ${k + 2}` } as NewRow;
      });
      out.push({ path, rows, car: guessCar(path, pur.projects) ?? "", subteam: guessSubteam(path, pur.subteams) ?? "" });
    }
    setFiles(out.sort((a, b) => a.path.localeCompare(b.path)));
  }

  // what's already on each car + subteam tab, by name: those rows are skipped
  const onTab = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const i of pur.items as Item[]) for (const a of i.item_allocations) {
      const k = `${a.project_id}|${a.subteam_id}`;
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(i.title.trim().toLowerCase());
    }
    return m;
  }, [pur.items]);
  const fresh = (f: CsvFile) => {
    const seen = new Set(onTab.get(`${f.car}|${f.subteam}`) ?? []);
    return f.rows.filter((r) => { const t = r.title.trim().toLowerCase(); if (seen.has(t)) return false; seen.add(t); return true; });
  };
  const ready = files.filter((f) => f.car && f.subteam);
  const toAdd = ready.reduce((s, f) => s + fresh(f).length, 0);

  async function run() {
    setBusy(true);
    let added = 0;
    try {
      for (const f of ready) {
        const rows = fresh(f);
        if (rows.length) added += await importItems(client, f.car, f.subteam, rows);
      }
      setFiles([]);
      await reload();
      flash(`Added ${added} part${added === 1 ? "" : "s"} from Airtable.`);
    } catch (e) { await reload(); flash(`${added ? `Added ${added}, then: ` : ""}${e instanceof Error ? e.message : String(e)}`, true); }
    setBusy(false);
  }

  const statusCount = (rows: NewRow[]) => {
    const c = new Map<string, number>();
    for (const r of rows) c.set(r.status ?? "PLANNED", (c.get(r.status ?? "PLANNED") ?? 0) + 1);
    return [...c.entries()].map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ");
  };

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <b>Airtable parts lists</b>
        <p className="mt-1 text-xs text-helios-dim">
          Pick the CSV exports (one per Airtable tab), or a whole folder of them. Each file's car and subteam come from its folder and name
          ("EV Team/Brakess-Grid view.csv" is EV Brakes); change any that are wrong. Statuses carry over (Not ready, Ready to order, Ordered,
          Received), vendor spellings are fixed, and parts already on a tab with the same name are skipped, so a file can be uploaded again safely.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="cursor-pointer rounded-md border border-helios-line px-3 py-1.5 text-sm hover:bg-helios-strip">
          Pick CSV files
          <input type="file" multiple accept=".csv,text/csv" className="hidden" onChange={(e) => { void pick(e.target.files); e.target.value = ""; }} />
        </label>
        <label className="cursor-pointer rounded-md border border-helios-line px-3 py-1.5 text-sm hover:bg-helios-strip">
          Pick a folder
          <input type="file" multiple className="hidden" onChange={(e) => { void pick(e.target.files); e.target.value = ""; }}
            ref={(el) => { if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); } }} />
        </label>
      </div>

      {files.length > 0 && (
        <>
          <div className="overflow-auto rounded-md border border-helios-line">
            <table className="w-full text-xs">
              <thead className="bg-helios-strip text-[11px] uppercase tracking-wider text-helios-dim">
                <tr><th className="p-1.5 text-left">File</th><th className="p-1.5 text-left">Car</th><th className="p-1.5 text-left">Subteam</th><th className="p-1.5 text-right">New parts</th><th className="p-1.5 text-left">Statuses</th></tr>
              </thead>
              <tbody>
                {files.map((f, k) => {
                  const add = f.car && f.subteam ? fresh(f) : [];
                  const set = (patch: Partial<CsvFile>) => setFiles((fs) => fs.map((x, j) => (j === k ? { ...x, ...patch } : x)));
                  return (
                    <tr key={f.path} className="border-t border-helios-line">
                      <td className="p-1.5">{f.path}</td>
                      <td className="p-1.5"><select className={`${input} ${f.car ? "" : "border-asu-gold"}`} value={f.car} onChange={(e) => set({ car: e.target.value })}>
                        <option value="">pick...</option>{pur.projects.map((x) => <option key={x.id} value={x.id}>{x.car_code}</option>)}</select></td>
                      <td className="p-1.5"><select className={`${input} ${f.subteam ? "" : "border-asu-gold"}`} value={f.subteam} onChange={(e) => set({ subteam: e.target.value })}>
                        <option value="">pick...</option>{pur.subteams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                      <td className="p-1.5 text-right tabular-nums">{f.car && f.subteam ? <>{add.length}{add.length < f.rows.length && <span className="text-helios-muted"> of {f.rows.length}</span>}</> : "-"}</td>
                      <td className="p-1.5 text-helios-dim">{statusCount(add)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {files.length > ready.length && <p className="text-xs text-asu-gold">{files.length - ready.length} file(s) still need a car and subteam; they'll be skipped.</p>}
          <div className="flex gap-2">
            <Button disabled={busy || !toAdd} onClick={() => void run()}>{busy ? "Adding..." : `Add ${toAdd} part${toAdd === 1 ? "" : "s"}`}</Button>
            <Button kind="ghost" onClick={() => setFiles([])}>Clear</Button>
          </div>
        </>
      )}
    </Card>
  );
}
