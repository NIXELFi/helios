import { useMemo, useState } from "react";
import { looksLikeHeader, mapHeaders, PASTE_FIELDS, PASTE_LABELS, toRows, type NewRow, type PasteField } from "../lib/paste";
import { Button } from "./ui";

/**
 * Confirms which pasted column goes where before anything is created. Header
 * rows from Airtable, Excel and Mouser/Digikey carts are recognised; without a
 * header, columns line up with the sheet starting at the cell pasted into.
 */
export function PasteDialog({
  matrix, startFields, tabLabel, onCancel, onAdd, existingTitles, canSetStatus = false,
}: {
  matrix: string[][];
  /** Sheet fields from the pasted-into column rightward (used when there's no header). */
  startFields: (PasteField | null)[];
  tabLabel: string;
  onCancel: () => void;
  onAdd: (rows: NewRow[], ready: boolean) => Promise<void>;
  /** Item names already on this tab (lowercase): those rows are skipped unless asked. */
  existingTitles?: Set<string>;
  /** Execs may bring in rows already marked Ordered / Received. */
  canSetStatus?: boolean;
}) {
  const width = Math.max(...matrix.map((r) => r.length));
  const detectedHeader = looksLikeHeader(matrix[0] ?? []);
  const [header, setHeader] = useState(detectedHeader);
  const [mapping, setMapping] = useState<(PasteField | null)[]>(() =>
    Array.from({ length: width }, (_, k) => (detectedHeader ? mapHeaders(matrix[0] ?? [])[k] : startFields[k]) ?? null));
  const [vendor, setVendor] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const body = header ? matrix.slice(1) : matrix;
  const all = useMemo(() => toRows(body, mapping, vendor), [body, mapping, vendor]);
  const [includeDups, setIncludeDups] = useState(false);
  const dups = all.filter((r) => existingTitles?.has(r.title.trim().toLowerCase()));
  const blocked = canSetStatus ? [] : all.filter((r) => r.status && r.status !== "PLANNED" && r.status !== "READY");
  const rows = all.filter((r) => (includeDups || !dups.includes(r)) && !blocked.includes(r));

  async function add() {
    if (!mapping.includes("title")) { setProblem("Pick which column is the item name."); return; }
    if (!rows.length) { setProblem("No new rows to add."); return; }
    setBusy(true);
    try { await onAdd(rows, ready); } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" role="dialog" aria-modal="true">
      <div className="flex max-h-full w-[min(1100px,94vw)] flex-col rounded-xl border border-helios-line bg-helios-panel p-5 shadow-2xl">
        <h2 className="text-base font-semibold">Add {rows.length} item{rows.length === 1 ? "" : "s"} to {tabLabel}</h2>
        <p className="mb-3 text-xs text-helios-dim">Check each column is going to the right place. Columns set to "ignore" are skipped.</p>
        <div className="min-h-0 overflow-auto rounded-md border border-helios-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-helios-strip">
              <tr>
                {mapping.map((f, k) => (
                  <th key={k} className="p-1.5 text-left">
                    <select
                      className="w-full rounded border border-helios-line bg-helios-panel px-1 py-0.5 text-xs"
                      value={f ?? ""}
                      onChange={(e) => setMapping((m) => m.map((x, j) => (j === k ? ((e.target.value || null) as PasteField | null) : x)))}
                    >
                      <option value="">(ignore)</option>
                      {PASTE_FIELDS.map((p) => <option key={p} value={p}>{PASTE_LABELS[p]}</option>)}
                    </select>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.slice(0, 200).map((r, i) => (
                <tr key={i} className={header && i === 0 ? "text-helios-muted line-through" : ""}>
                  {mapping.map((_, k) => (
                    <td key={k} className="max-w-[240px] truncate border-t border-helios-line px-2 py-1" title={r[k] ?? ""}>{r[k] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {matrix.length > 200 && <p className="mt-1 text-xs text-helios-muted">…and {matrix.length - 200} more rows.</p>}
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row is a header</label>
          <input
            className="min-w-[260px] rounded-md border border-helios-line bg-helios-strip px-2 py-1 text-sm"
            placeholder="Vendor for rows without one (e.g. Mouser)"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          />
          <label className="flex items-center gap-2"><input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} /> Send them all for approval now</label>
        </div>
        {dups.length > 0 && (
          <label className="mt-2 flex items-center gap-2 text-sm text-helios-dim">
            <input type="checkbox" checked={includeDups} onChange={(e) => setIncludeDups(e.target.checked)} />
            {dups.length} row{dups.length > 1 ? "s are" : " is"} already on this tab (same name): add {dups.length > 1 ? "them" : "it"} again anyway
          </label>
        )}
        {blocked.length > 0 && <p className="mt-2 text-sm text-asu-gold">{blocked.length} row{blocked.length > 1 ? "s are" : " is"} marked Ordered or Received. Only execs can bring those in, so {blocked.length > 1 ? "they'll" : "it'll"} be skipped.</p>}
        {mapping.includes("status") && <p className="mt-1 text-xs text-helios-dim">Status column found: Airtable's "Not ready / Ready to order / Ordered / Received" carry over.</p>}
        <p className="mt-1 text-xs text-helios-dim">Vendor spellings are matched to the team's vendor list (e.g. "TPM Breaks" becomes TBM Brakes).</p>
        {problem && <p className="mt-2 text-sm text-helios-danger">{problem}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button kind="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={add} disabled={busy}>{busy ? "Adding…" : `Add ${rows.length} item${rows.length === 1 ? "" : "s"}`}</Button>
        </div>
      </div>
    </div>
  );
}
