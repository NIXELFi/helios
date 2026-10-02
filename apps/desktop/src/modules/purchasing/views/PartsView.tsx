import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { SupabaseClient } from "@helios/auth";
import {
  ON_THE_WAY, ORDERED_STATUSES, REQUESTER_MOVES, STATUSES, addItems, addTracking, can, decide, detectCarrier, importItems, itemCost, recordOrder,
  deleteItems, setCarSubteam, setStatus, subteamsOfCar, undoOrder, updateItem, type Item, type Priority, type Status,
} from "../lib/api";
import { today } from "../lib/dates";
import { centsToInput, fmtCents, parseCents, requireCents } from "../lib/money";
import { parseCsv, parseTsv, type NewRow, type PasteField } from "../lib/paste";
import { normalizeVendor } from "../finance/importers";
import type { PurchasingData } from "../lib/usePurchasing";
import { PasteDialog } from "../components/PasteDialog";
import { OrderDialog } from "../components/OrderDialog";
import { inRange, rangeBounds, rangeSize, summarize, type CellRange, type CellValue } from "../lib/cellRange";
import { Button, Empty, PrioritySelect, StatusSelect, SubteamChip, useConfirm } from "../components/ui";

type Filter = "all" | "planning" | "moving" | "done";
const FILTERS: { id: Filter; label: string; test: (s: Status) => boolean }[] = [
  { id: "all", label: "Everything", test: () => true },
  { id: "planning", label: "Planning", test: (s) => s === "PLANNED" || s === "READY" },
  { id: "moving", label: "On the way", test: (s) => s === "APPROVED" || ON_THE_WAY.has(s) },
  { id: "done", label: "Done", test: (s) => s === "RECEIVED" || s === "RECONCILED" },
];

/** Sheet columns, in order. `field` is what a pasted column maps to. */
interface Col { key: string; label: string; field: PasteField | null; className: string }
const COLS: Col[] = [
  { key: "title", label: "Item", field: "title", className: "min-w-[260px]" },
  { key: "quantity", label: "Qty", field: "quantity", className: "min-w-[72px]" },
  { key: "unit_price_cents", label: "Unit $", field: "unit_price", className: "min-w-[90px]" },
  { key: "tax_shipping_cents", label: "Tax/ship $", field: "tax_shipping", className: "min-w-[90px]" },
  { key: "total", label: "Total", field: "total", className: "min-w-[96px]" },
  { key: "vendor", label: "Vendor", field: "vendor", className: "min-w-[130px]" },
  { key: "funding_source", label: "Funding", field: "funding_source", className: "min-w-[130px]" },
  { key: "part_number", label: "Part #", field: "part_number", className: "min-w-[150px]" },
  { key: "product_url", label: "Link", field: "product_url", className: "min-w-[160px]" },
  { key: "status", label: "Status", field: null, className: "min-w-[150px]" },
  { key: "priority", label: "Priority", field: "priority", className: "min-w-[96px]" },
  { key: "needed_by", label: "Needed by", field: "needed_by", className: "min-w-[140px]" },
  { key: "notes", label: "Notes", field: "notes", className: "min-w-[200px]" },
];
const MONEY = new Set(["unit_price_cents", "tax_shipping_cents"]);
/** The checkbox and code columns come before COLS. */
const FIRST_COL = 2;

/** What a cell holds, for the status bar's sum, average and count. */
function cellValue(i: Item, key: string): CellValue {
  if (key === "total") return { money: itemCost(i) };
  if (MONEY.has(key)) { const v = i[key as "unit_price_cents" | "tax_shipping_cents"]; return v === null ? null : { money: v }; }
  if (key === "quantity") return i.quantity === null ? null : { number: Number(i.quantity) };
  return { text: String((i as unknown as Record<string, unknown>)[key] ?? "") };
}
/** The same cell as text, for copying a range (tab-separated, like Excel). */
function cellText(i: Item, key: string): string {
  const v = cellValue(i, key);
  return !v ? "" : "money" in v ? centsToInput(v.money) : "number" in v ? String(v.number) : v.text.replace(/[\t\n]/g, " ");
}
/** The update_item patch that copies one cell's value onto another part (the fill handle). null = can't be filled. */
function fillPatch(from: Item, key: string): Record<string, unknown> | null {
  if (key === "status" || key === "total") return null;
  if (key === "quantity" || MONEY.has(key) || key === "priority" || key === "needed_by") {
    return { [key]: (from as unknown as Record<string, unknown>)[key] ?? null };
  }
  return { [key]: String((from as unknown as Record<string, unknown>)[key] ?? "") };
}

/** A typed cell value -> the update_item patch for it. null = not a valid value. */
function toPatch(key: string, raw: string): Record<string, unknown> | null {
  if (key === "total" || MONEY.has(key)) {
    const field = key === "total" ? "total_estimate_cents" : key;
    if (raw.trim() === "") return { [field]: null };   // a cleared cell clears the price
    const cents = parseCents(raw);
    return cents === null ? null : { [field]: cents };   // a typo is refused, never saved as "no price"
  }
  if (key === "quantity") {
    if (raw.trim() === "") return { quantity: null };
    const q = Number(raw.replace(/,/g, ""));
    return Number.isFinite(q) ? { quantity: q } : null;
  }
  if (key === "priority") {
    const p = ({ high: "HIGH", medium: "Medium", low: "Low" } as Record<string, string>)[raw.trim().toLowerCase()];
    return p ? { priority: p } : null;
  }
  if (key === "needed_by") return { needed_by: raw.trim() || null };
  return { [key]: raw };
}

export function PartsView({
  client, data, projectId, reload, flash, focus,
}: {
  client: SupabaseClient;
  data: PurchasingData;
  projectId: string | null;           // null = both cars
  reload: () => Promise<void>;
  flash: (msg: string, error?: boolean) => void;
  focus?: { q: string; n: number } | null;   // show one part (from a budget breakdown)
}) {
  const { items, subteams, caps } = data;
  const exec = can(caps, "purchasing.approve");
  const [tab, setTab] = useState<string | null>(null);   // subteam id, null = All
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  // jump to one part (e.g. "Show part" from a budget breakdown)
  useEffect(() => { if (focus) { setTab(null); setFilter("all"); setQ(focus.q); } }, [focus]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paste, setPaste] = useState<{ matrix: string[][]; start: number } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  // a rectangle of cells, as in a spreadsheet: [row in `rows`, column in COLS]
  const [range, setRange] = useState<CellRange | null>(null);
  const [fillTo, setFillTo] = useState<number | null>(null);   // the row the fill handle is dragged to
  const drag = useRef<"select" | "fill" | null>(null);
  // the handlers read the range from here: a fast drag can fire before React redraws
  const rangeRef = useRef(range);
  const select = (r: CellRange | null) => { rangeRef.current = r; setRange(r); };
  const fillRef = useRef(fillTo);

  const subteamOf = (i: Item) => i.item_allocations[0]?.subteam_id;
  // a car shows its own subteams, as set in Admin > Org Structure
  const canStructure = can(caps, "org.manage_structure");
  const carTeams = subteamsOfCar(subteams, data.carSubteams, items, projectId);
  const notOnCar = projectId ? subteams.filter((s) => !data.carSubteams.some((x) => x.project_id === projectId && x.subteam_id === s.id)) : [];
  useEffect(() => { if (tab && !carTeams.some((s) => s.id === tab)) setTab(null); }, [projectId, carTeams, tab]);
  const inProject = (i: Item) => !projectId || i.item_allocations.some((a) => a.project_id === projectId);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) if (inProject(i)) for (const a of i.item_allocations) m.set(a.subteam_id, (m.get(a.subteam_id) ?? 0) + 1);
    return m;
  }, [items, projectId]);

  const test = FILTERS.find((f) => f.id === filter)!.test;
  const rows = items.filter((i) =>
    inProject(i) && test(i.status)
    && (!tab || i.item_allocations.some((a) => a.subteam_id === tab))
    && (!q || `${i.code} ${i.title} ${i.vendor ?? ""} ${i.part_number} ${i.notes}`.toLowerCase().includes(q.toLowerCase())));
  const total = rows.reduce((s, i) => s + itemCost(i), 0);
  const tabSubteam = subteams.find((s) => s.id === tab);
  const canAddHere = !!tab && !!projectId && (exec || can(caps, "purchasing.request", tab));

  const canEdit = (i: Item) =>
    exec || ((i.status === "PLANNED" || i.status === "READY") && i.item_allocations.some((a) => can(caps, "purchasing.request", a.subteam_id)));
  const statusOptions = (i: Item): Status[] => {
    // Execs may set any status the server allows: APPROVED only comes from two
    // approvals, and nothing unapproved can jump to ordered/shipped/received.
    if (exec) {
      const approved = ORDERED_STATUSES.has(i.status) || i.status === "APPROVED";
      return STATUSES.filter((s) => s === i.status || (s !== "APPROVED" && (approved || !ORDERED_STATUSES.has(s))));
    }
    if (!i.item_allocations.some((a) => can(caps, "purchasing.request", a.subteam_id))) return [i.status];
    return [i.status, ...(REQUESTER_MOVES[i.status] ?? [])];
  };

  async function run(label: string, fn: () => Promise<unknown>) {
    try { await fn(); await reload(); if (label) flash(label); } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  }

  function save(i: Item, key: string, raw: string) {
    const patch = toPatch(key, raw);
    if (!patch) { flash(`"${raw.trim()}" isn't a valid ${COLS.find((c) => c.key === key)?.label.toLowerCase() ?? "value"}. Nothing was changed.`, true); return; }
    return run("", () => updateItem(client, i.id, patch));
  }

  // ---- cell ranges: drag across cells (or shift-click) to add them up; drag
  // the corner square down to copy the cells into the rows below
  useEffect(() => { select(null); }, [tab, filter, q, projectId]);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  useEffect(() => {
    const up = () => { if (drag.current === "fill") void applyFill(); drag.current = null; };
    const outside = (e: MouseEvent) => { if (!tableRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-sheet-bar]")) select(null); };
    const copy = (e: globalThis.ClipboardEvent) => {
      const r = rangeRef.current;
      if (!r || rangeSize(r) < 2 || (document.activeElement && tableRef.current?.contains(document.activeElement))) return;
      const { r0, r1, c0, c1 } = rangeBounds(r);
      const lines = rowsRef.current.slice(r0, r1 + 1).map((i) => COLS.slice(c0, c1 + 1).map((c) => cellText(i, c.key)).join("\t"));
      e.clipboardData?.setData("text/plain", lines.join("\n"));
      e.preventDefault();
      flash(`Copied ${rangeSize(r)} cells.`);
    };
    document.addEventListener("mouseup", up);
    document.addEventListener("mousedown", outside);
    document.addEventListener("copy", copy);
    return () => { document.removeEventListener("mouseup", up); document.removeEventListener("mousedown", outside); document.removeEventListener("copy", copy); };
  });
  function cellAt(target: EventTarget): [number, number] | null {
    const td = (target as HTMLElement).closest?.("td");
    const id = (td?.parentElement as HTMLElement | null)?.dataset.id;
    if (!td || !id) return null;
    const r = rows.findIndex((x) => x.id === id), k = td.cellIndex - FIRST_COL;
    return r < 0 || k < 0 || k >= COLS.length ? null : [r, k];
  }
  function onMouseDown(e: ReactMouseEvent<HTMLTableElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("input[type=checkbox]")) return;
    const c = cellAt(e.target);
    if (!c) return;
    const r = rangeRef.current;
    if (e.shiftKey && r) { e.preventDefault(); select({ a: r.a, b: c }); return; }
    select({ a: c, b: c });
    drag.current = "select";
  }
  function onMouseOver(e: ReactMouseEvent<HTMLTableElement>) {
    if (!drag.current) return;
    if (!(e.buttons & 1)) { drag.current = null; return; }
    const c = cellAt(e.target);
    const r = rangeRef.current;
    if (!c || !r) return;
    if (drag.current === "fill") { const to = c[0] > rangeBounds(r).r1 ? c[0] : null; fillRef.current = to; setFillTo(to); return; }
    if (c[0] === r.b[0] && c[1] === r.b[1]) return;
    select({ a: r.a, b: c });
    // more than one cell: it's a range, not typing in a cell
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.getSelection()?.removeAllRanges();
  }
  async function applyFill() {
    const r = rangeRef.current, to = fillRef.current;
    fillRef.current = null;
    setFillTo(null);
    if (!r || to === null) return;
    const { r0, r1, c0, c1 } = rangeBounds(r);
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    let skipped = 0;
    for (let t = r1 + 1; t <= to; t++) {
      // like Excel: the selected rows repeat down
      const target = rows[t], from = rows[r0 + ((t - r0) % (r1 - r0 + 1))];
      if (!target || !from) continue;
      if (!canEdit(target)) { skipped++; continue; }
      const patch: Record<string, unknown> = {};
      for (let k = c0; k <= c1; k++) Object.assign(patch, fillPatch(from, COLS[k]!.key) ?? {});
      if (Object.keys(patch).length) updates.push({ id: target.id, patch });
    }
    if (!updates.length) { if (skipped) flash(`You can't edit ${skipped === 1 ? "that part" : "those parts"} (approved already, or another subteam's).`, true); return; }
    await run(`Filled ${updates.length} row${updates.length === 1 ? "" : "s"}${skipped ? `; ${skipped} you can't edit were skipped` : ""}.`, async () => {
      for (const u of updates) await updateItem(client, u.id, u.patch);
    });
    select({ a: [r0, c0], b: [to, c1] });
  }
  const bounds = range ? rangeBounds(range) : null;
  const summary = range && rangeSize(range) > 1 && bounds
    ? summarize(rows.slice(bounds.r0, bounds.r1 + 1).flatMap((i) => COLS.slice(bounds.c0, bounds.c1 + 1).map((c) => cellValue(i, c.key))))
    : null;

  // ---- keyboard: Enter / arrows move between rows like a spreadsheet
  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    if (e.key === "Escape") { select(null); return; }
    const el = e.target as HTMLElement;
    const cell = el.closest("td");
    const tr = cell?.parentElement;
    if (!cell || !tr) return;
    if (e.key === "Enter" && tr.dataset.new !== undefined) { e.preventDefault(); void addFromNewRow(); return; }
    let target: Element | null = null;
    if (e.key === "Enter" || e.key === "ArrowDown") target = tr.nextElementSibling;
    else if (e.key === "ArrowUp") target = tr.previousElementSibling;
    else return;
    if (el.tagName === "SELECT" && e.key !== "Enter") return;
    const next = target?.children[cell.cellIndex]?.querySelector<HTMLElement>("input,select");
    if (next) { e.preventDefault(); (el as HTMLInputElement).blur(); next.focus(); (next as HTMLInputElement).select?.(); }
  }

  // ---- the blank row at the bottom
  const [draft, setDraft] = useState<Record<string, string>>({});
  async function addFromNewRow() {
    if (!canAddHere || !tab || !projectId) return;
    if (!draft.title?.trim()) { flash("Give the item a name first", true); return; }
    const row: NewRow = { title: draft.title.trim() };
    if (draft.quantity) row.quantity = Number(draft.quantity);
    if (draft.quantity && !(Number(draft.quantity) > 0)) { flash(`"${draft.quantity}" isn't a valid quantity.`, true); return; }
    try {
      const unit = requireCents(draft.unit_price_cents, "unit price"); if (unit !== null) row.unit_price_cents = unit;
      const tax = requireCents(draft.tax_shipping_cents, "tax/shipping"); if (tax !== null) row.tax_shipping_cents = tax;
      const tot = requireCents(draft.total, "total"); if (tot !== null) row.total_estimate_cents = tot;
    } catch (e) { flash((e as Error).message, true); return; }
    for (const k of ["vendor", "part_number", "product_url", "notes", "needed_by", "priority"] as const) if (draft[k]) row[k] = draft[k];
    await run(`Added ${row.title}`, () => addItems(client, projectId, tab, [row], false));
    setDraft({});
    window.setTimeout(() => tableRef.current?.querySelector<HTMLInputElement>("tr[data-new] input")?.focus(), 50);
  }

  // ---- paste a block of cells
  function onPaste(e: ClipboardEvent<HTMLTableElement>) {
    const text = e.clipboardData.getData("text");
    if (!text || (!text.includes("\t") && !/\n./.test(text.trim() + "."))) return;   // one value: normal paste
    const matrix = parseTsv(text);
    if (matrix.length <= 1 && (matrix[0]?.length ?? 0) <= 1) return;
    const cell = (e.target as HTMLElement).closest("td");
    const tr = cell?.parentElement;
    if (!cell || !tr) return;
    e.preventDefault();
    if (tr.dataset.new !== undefined) { setPaste({ matrix, start: cell.cellIndex }); return; }
    // Excel-style: overwrite cells right and down; extra rows become new items.
    const start = rows.findIndex((r) => r.id === tr.dataset.id);
    const patches: Array<{ item: Item; patch: Record<string, unknown> }> = [];
    const leftover: string[][] = [];
    matrix.forEach((values, n) => {
      const item = rows[start + n];
      if (!item) { leftover.push(values); return; }
      if (!canEdit(item)) return;
      const patch: Record<string, unknown> = {};
      values.forEach((v, k) => {
        const col = COLS[cell.cellIndex - FIRST_COL + k];
        if (!col || col.key === "status") return;
        const p = toPatch(col.key, v);
        if (p) Object.assign(patch, p);
      });
      if (Object.keys(patch).length) patches.push({ item, patch });
    });
    if (patches.length) {
      void run(`Updated ${patches.length} row${patches.length === 1 ? "" : "s"}`, async () => {
        for (const { item, patch } of patches) await updateItem(client, item.id, patch);
      });
    }
    if (leftover.length) {
      if (canAddHere) setPaste({ matrix: leftover, start: cell.cellIndex });
      else flash(`${leftover.length} extra row(s) not added: open a subteam tab and pick a car first`, true);
    }
  }
  const startFields = (start: number): (PasteField | null)[] =>
    COLS.slice(Math.max(0, start - FIRST_COL)).map((c) => c.field);

  // ---- bulk actions
  const ids = [...selected].filter((id) => rows.some((r) => r.id === id));
  const [bulk, setBulk] = useState("");
  const [cart, setCart] = useState<Item[] | null>(null);
  const [ask, confirmDialog] = useConfirm();
  const [order, setOrder] = useState({ id: "", payment: "SAE card", total: "", on: today(), paidBy: "" });
  const [track, setTrack] = useState({ number: "", carrier: "", eta: "" });
  async function applyBulk() {
    if (!ids.length || !bulk) return;
    if (bulk.startsWith("status:")) {
      const s = bulk.slice(7) as Status;
      await run(`${ids.length} item(s) updated`, () => setStatus(client, ids, s));
    } else if (bulk === "approve") {
      await run(`Approved ${ids.length} item(s)`, async () => { for (const id of ids) await decide(client, id, "approve"); });
    } else if (bulk === "order") {
      await run(`${ids.length} item(s) marked ordered`, () =>
        recordOrder(client, ids, order.id, order.payment, order.on || null, requireCents(order.total, "order total"), order.paidBy));
    } else if (bulk === "tracking") {
      await run(`Tracking added to ${ids.length} item(s)`, () =>
        addTracking(client, ids, track.number, track.carrier || detectCarrier(track.number), track.eta || null));
    } else if (bulk === "delete") {
      const pick = rows.filter((r) => selected.has(r.id));
      const ok = await ask({ title: `Delete ${pick.length} part${pick.length === 1 ? "" : "s"}?`, confirmLabel: "Delete", danger: true,
        body: <>They're removed from Abacus for good (the parts history keeps a note of who deleted them). Parts matched to a ledger charge can't be deleted: unlink them in the Ledger first.
          {pick.length <= 8 && <span className="mt-2 block text-xs">{pick.map((r) => `${r.code} ${r.title}`).join(", ")}</span>}</> });
      if (!ok) return;
      await run("", async () => { const n = await deleteItems(client, ids); flash(`Deleted ${n} part${n === 1 ? "" : "s"}.`); });
    } else if (bulk === "undo-order") {
      const ok = await ask({
        title: `Undo the order on ${ids.length} part${ids.length === 1 ? "" : "s"}?`,
        body: "Approved parts go back to Approved, parts that never had approvals (imported) to Ready to order. The order number, cost, payment and tracking are cleared.",
        confirmLabel: "Undo order", danger: true,
      });
      if (ok) await run(`Order undone on ${ids.length} part(s)`, () => undoOrder(client, ids));
    } else if (bulk === "cart") {
      const pick = rows.filter((r) => selected.has(r.id));
      const locked = pick.filter((r) => !canEdit(r));
      if (locked.length) { flash(`${locked.map((r) => r.code).join(", ")} can't be changed by you (approved already, or another subteam's).`, true); return; }
      setCart(pick);
      return;
    } else if (bulk === "copy") {
      const pick = rows.filter((r) => selected.has(r.id));
      const lines = [["Item", "Qty", "Unit $", "Tax/ship $", "Vendor", "Part #", "Link", "Needed by", "Notes"].join("\t")].concat(
        pick.map((r) => [r.title, r.quantity ?? "", centsToInput(r.unit_price_cents), centsToInput(r.tax_shipping_cents), r.vendor ?? "",
          r.part_number, r.product_url, r.needed_by ?? "", r.notes].map((v) => String(v).replace(/[\t\n]/g, " ")).join("\t")));
      await navigator.clipboard.writeText(lines.join("\n"));
      flash(`Copied ${pick.length} row(s). Paste them into another tab's blank row, or into Excel.`);
      return;
    }
    setSelected(new Set());
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* sheet tabs: the car's subteams (every one on "Both cars"), even empty ones */}
      <div className="flex flex-wrap items-center gap-1 border-b border-helios-line pb-1">
        <TabButton on={!tab} onClick={() => setTab(null)}>All</TabButton>
        {carTeams.map((s) => (
          <TabButton key={s.id} on={tab === s.id} empty={!counts.get(s.id)} onClick={() => setTab(s.id)}>
            <span className="size-1.5 rounded-full" style={{ background: s.color ?? "#8d8d97" }} />
            {s.name}<span className="text-[11px] text-helios-muted">{counts.get(s.id) ?? 0}</span>
          </TabButton>
        ))}
        {canStructure && projectId && notOnCar.length > 0 && (
          <select className="ml-1 rounded-md border border-dashed border-helios-line bg-transparent px-1 py-1 text-xs text-helios-dim" value=""
            title="Put another subteam on this car (the same as Admin > Org Structure)"
            onChange={(e) => { const id = e.target.value; if (id) void run("Subteam added to this car.", () => setCarSubteam(client, projectId, id, true)).then(() => setTab(id)); }}>
            <option value="">+ subteam on {data.projects.find((p) => p.id === projectId)?.car_code}</option>
            {notOnCar.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`rounded-full border px-3 py-1 text-xs ${filter === f.id ? "border-asu-gold bg-asu-gold/10 text-asu-gold" : "border-helios-line text-helios-dim hover:bg-helios-strip"}`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-helios-dim">
          <span>{rows.length} items | {fmtCents(total)} estimated</span>
          <input className="w-56 rounded-md border border-helios-line bg-helios-strip px-2 py-1 text-sm" placeholder="Search this tab..." value={q} onChange={(e) => setQ(e.target.value)} />
          {canAddHere && (
            <label className="cursor-pointer rounded-md border border-helios-line px-2 py-1 text-sm text-helios-text hover:bg-helios-strip" title="Upload an Airtable (or Excel) CSV export into this tab">
              Upload CSV
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => {
                const f = e.target.files?.[0]; e.target.value = "";
                if (f) void f.text().then((text) => {
                  const matrix = parseCsv(text);
                  if (matrix.length) setPaste({ matrix, start: FIRST_COL }); else flash("That file has no rows.", true);
                });
              }} />
            </label>
          )}
        </div>
      </div>

      {canAddHere ? (
        <p className="text-xs text-helios-dim">Type in any cell and it saves. <b className="text-helios-text">Paste rows straight from Excel, Airtable or a Mouser/Digikey cart into the blank row</b> to add them all at once. Enter moves down; arrows move between rows.</p>
      ) : tab && !projectId ? (
        <p className="text-xs text-helios-dim">Pick a car at the top to add parts to this tab.</p>
      ) : !tab ? (
        <p className="text-xs text-helios-dim">Open a subteam tab to add or paste parts.</p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-helios-line bg-helios-panel">
        <table ref={tableRef} className="w-full select-none border-separate border-spacing-0 text-[13px] [&_input]:select-text"
          onKeyDown={onKeyDown} onPaste={onPaste} onMouseDown={onMouseDown} onMouseOver={onMouseOver}>
          <thead className="sticky top-0 z-10 bg-helios-strip text-[11px] uppercase tracking-wider text-helios-dim">
            <tr>
              <th className="w-8 border-b border-helios-line p-2">
                <input type="checkbox" aria-label="Select all" checked={allChecked}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
              </th>
              <th className="w-16 border-b border-helios-line p-2 text-left">#</th>
              {COLS.map((c) => <th key={c.key} className={`border-b border-l border-helios-line p-2 text-left ${c.className}`}>{c.label}</th>)}
              {!tab && <th className="border-b border-l border-helios-line p-2 text-left">Subteam</th>}
              <th className="border-b border-l border-helios-line p-2 text-left">Asked by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i, r) => {
              const edit = canEdit(i);
              return (
                <tr key={i.id} data-id={i.id} className={`hover:bg-white/[0.02] ${i.status === "CANCELLED" || i.status === "HAVE" ? "opacity-55" : ""}`}>
                  <td className="border-b border-helios-line text-center">
                    <input type="checkbox" aria-label={`Select ${i.code}`} checked={selected.has(i.id)}
                      onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} />
                  </td>
                  <td className="border-b border-helios-line px-2 font-mono text-[11px] text-helios-muted" title={i.code}>{i.code.slice(4)}</td>
                  {COLS.map((c, k) => {
                    const on = inRange(range, r, k);
                    const filling = fillTo !== null && bounds !== null && r > bounds.r1 && r <= fillTo && k >= bounds.c0 && k <= bounds.c1;
                    const corner = !!bounds && fillTo === null && r === bounds.r1 && k === bounds.c1;
                    return (
                    <td key={c.key} className={`relative border-b border-l border-helios-line ${c.className} ${on ? "bg-asu-gold/15" : filling ? "bg-asu-gold/[0.07] outline-dashed outline-1 -outline-offset-1 outline-asu-gold/60" : ""}`}>
                      {corner && (
                        <span title="Drag down to copy into the rows below" data-fill-handle=""
                          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); drag.current = "fill"; fillRef.current = null; setFillTo(null); }}
                          className="absolute -bottom-[3px] -right-[3px] z-20 size-[7px] cursor-crosshair border border-helios-base bg-asu-gold" />
                      )}
                      {c.key === "status" ? (
                        <div className="px-1"><StatusSelect status={i.status} options={statusOptions(i)}
                          onChange={(s) => void run(`${i.code}: ${s.toLowerCase()}`, () => setStatus(client, [i.id], s))} /></div>
                      ) : c.key === "priority" ? (
                        <div className="px-1"><PrioritySelect priority={i.priority} editable={edit}
                          onChange={(p: Priority) => void save(i, "priority", p)} /></div>
                      ) : c.key === "total" ? (
                        <div className="px-2 text-right font-semibold" title={i.actual_total_cents !== null ? "What was charged" : "Estimate"}>
                          {fmtCents(itemCost(i))}{i.actual_total_cents !== null && <span className="ml-1 text-[10px] text-helios-muted">paid</span>}
                        </div>
                      ) : (
                        <Cell item={i} col={c.key} edit={edit} onSave={(v) => void save(i, c.key, v)} />
                      )}
                    </td>
                    );
                  })}
                  {!tab && <td className="border-b border-l border-helios-line px-2">
                    <SubteamChip subteam={subteams.find((s) => s.id === subteamOf(i))} /></td>}
                  <td className="border-b border-l border-helios-line px-2 text-xs text-helios-dim">{i.requester_name}</td>
                </tr>
              );
            })}
            {canAddHere && (
              <tr data-new="" className="bg-asu-gold/[0.04]">
                <td className="border-b border-helios-line" />
                <td className="border-b border-helios-line px-2 text-helios-muted">+</td>
                {COLS.map((c) => (
                  <td key={c.key} className={`border-b border-l border-helios-line ${c.className}`}>
                    {c.key === "status" ? <span className="px-2 text-xs text-helios-muted">Not ready</span>
                      : c.key === "priority" ? (
                        <select className="h-8 w-full bg-transparent px-2" value={draft.priority ?? "Medium"}
                          onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}>
                          <option>Medium</option><option>HIGH</option><option>Low</option>
                        </select>
                      ) : (
                        <input
                          className="h-8 w-full bg-transparent px-2 outline-none placeholder:text-helios-muted focus:bg-helios-strip focus:ring-1 focus:ring-asu-gold"
                          type={c.key === "needed_by" ? "date" : "text"}
                          placeholder={c.key === "title" ? `Type or paste a new ${tabSubteam?.code ?? ""} item...` : c.key === "total" ? "auto" : ""}
                          value={draft[c.key] ?? ""}
                          onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                        />
                      )}
                  </td>
                ))}
                <td className="border-b border-l border-helios-line" />
              </tr>
            )}
            {!rows.length && !canAddHere && (
              <tr><td colSpan={COLS.length + 4} className="p-8"><Empty>Nothing here yet.</Empty></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* the status bar, as in Excel: what the selected cells add up to */}
      <div data-sheet-bar="" className="-mt-1 flex min-h-[22px] flex-wrap items-center justify-end gap-x-4 px-1 text-xs text-helios-dim">
        {summary ? <>
          {summary.moneyCount > 0 && <>
            <span>Sum <b className="tabular-nums text-helios-text">{fmtCents(summary.moneySum)}</b></span>
            <span>Average <b className="tabular-nums text-helios-text">{fmtCents(Math.round(summary.moneySum / summary.moneyCount))}</b></span>
          </>}
          {summary.numberCount > 0 && <span>{summary.moneyCount > 0 ? "Qty total" : "Sum"} <b className="tabular-nums text-helios-text">{summary.numberSum}</b></span>}
          <span>Count <b className="tabular-nums text-helios-text">{summary.count}</b></span>
        </> : range ? <span>Drag across cells (or shift-click) to add them up; drag the gold corner down to fill the rows below. Ctrl+C copies a range.</span> : null}
      </div>

      {ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-asu-gold bg-helios-strip px-4 py-2 shadow-lg">
          <b className="text-asu-gold">{ids.length} selected | {fmtCents(rows.filter((r) => selected.has(r.id)).reduce((t, r) => t + itemCost(r), 0))}</b>
          <select className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" value={bulk} onChange={(e) => setBulk(e.target.value)}>
            <option value="">Choose an action...</option>
            <option value="status:READY">Send for approval</option>
            <option value="status:PLANNED">Back to not ready</option>
            <option value="status:RECEIVED">Mark received</option>
            <option value="cart">Split one cart's shipping & tax over these</option>
            <option value="copy">Copy as spreadsheet rows</option>
            {exec && <>
              <option value="approve">Approve</option>
              <option value="order">Record order (bought together)</option>
              <option value="undo-order">Undo order</option>
              <option value="tracking">Add tracking</option>
              <option value="status:DELIVERED">Mark delivered</option>
              <option value="status:CANCELLED">Cancel</option>
              <option value="status:HAVE">Already have it</option>
              <option value="delete">Delete</option>
            </>}
          </select>
          {bulk === "order" && <>
            <input className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" placeholder="Vendor order #" value={order.id} onChange={(e) => setOrder({ ...order, id: e.target.value })} />
            <input className="w-40 rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" placeholder="Paid with" value={order.payment} onChange={(e) => setOrder({ ...order, payment: e.target.value })} />
            <input className="w-28 rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" placeholder="Order total $" value={order.total} onChange={(e) => setOrder({ ...order, total: e.target.value })} />
            <input type="date" className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" value={order.on} onChange={(e) => setOrder({ ...order, on: e.target.value })} />
            <input className="w-40 rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" placeholder="Member who paid (if any)" value={order.paidBy} onChange={(e) => setOrder({ ...order, paidBy: e.target.value })} />
          </>}
          {bulk === "tracking" && <>
            <input className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" placeholder="Tracking number" value={track.number}
              onChange={(e) => setTrack({ ...track, number: e.target.value, carrier: detectCarrier(e.target.value) || track.carrier })} />
            <select className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" value={track.carrier} onChange={(e) => setTrack({ ...track, carrier: e.target.value })}>
              <option value="">Carrier</option>{["UPS", "FedEx", "USPS", "DHL", "Amazon", "Other"].map((c) => <option key={c}>{c}</option>)}
            </select>
            <input type="date" title="Estimated delivery" className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" value={track.eta} onChange={(e) => setTrack({ ...track, eta: e.target.value })} />
          </>}
          <Button onClick={() => void applyBulk()} disabled={!bulk}>Apply</Button>
          <Button kind="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {confirmDialog}
      {cart && (
        <OrderDialog client={client} items={cart} canOrder={can(caps, "purchasing.order")} vendorNames={data.vendors.map((v) => v.name)}
          reload={reload} flash={flash} onClose={() => { setCart(null); setSelected(new Set()); }} />
      )}

      {paste && tab && projectId && (
        <PasteDialog
          matrix={paste.matrix}
          startFields={startFields(paste.start)}
          tabLabel={tabSubteam?.name ?? "this tab"}
          onCancel={() => setPaste(null)}
          existingTitles={new Set(items.filter((i) => i.item_allocations.some((a) => a.subteam_id === tab && a.project_id === projectId))
            .map((i) => i.title.trim().toLowerCase()))}
          canSetStatus={exec}
          onAdd={async (newRows, ready) => {
            const fixed = newRows.map((r) => (r.vendor ? { ...r, vendor: normalizeVendor(r.vendor, data.vendors) } : r));
            // plain rows follow the "send for approval" box; Airtable statuses carry over
            const groups = new Map<string, NewRow[]>();
            for (const r of fixed) {
              const s = r.status ?? (ready ? "READY" : "PLANNED");
              groups.set(s, [...(groups.get(s) ?? []), r]);
            }
            for (const [s, rs] of groups) {
              // rows Airtable already had as Ordered / Received come in as they were (execs only)
              if (s === "READY" || s === "PLANNED") await addItems(client, projectId, tab, rs, s === "READY");
              else if (exec) await importItems(client, projectId, tab, rs.map((r) => ({ ...r, status: s })));
            }
            setPaste(null);
            await reload();
            flash(`Added ${fixed.length} item(s)${ready ? " and sent them for approval" : ""}.`);
          }}
        />
      )}
    </div>
  );
}

function TabButton({ on, empty, onClick, children }: { on: boolean; empty?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-t-md border border-b-0 px-3 py-1.5 text-[13px] ${on
        ? "border-helios-line bg-helios-panel font-semibold text-asu-gold shadow-[inset_0_2px_0_rgb(var(--asu-gold))]"
        : `border-transparent hover:bg-helios-strip ${empty ? "text-helios-muted" : "text-helios-text"}`}`}>
      {children}
    </button>
  );
}

/** One editable cell. Saves on blur (or when paste dispatches a change) if the value changed. */
function Cell({ item, col, edit, onSave }: { item: Item; col: string; edit: boolean; onSave: (v: string) => void }) {
  const initial =
    col === "quantity" ? (item.quantity ?? "").toString()
      : MONEY.has(col) ? centsToInput(item[col as "unit_price_cents" | "tax_shipping_cents"])
        : col === "needed_by" ? item.needed_by ?? ""
          : String((item as unknown as Record<string, unknown>)[col] ?? "");
  const [value, setValue] = useState(initial);
  const [shown, setShown] = useState(initial);
  if (initial !== shown) { setShown(initial); setValue(initial); }   // server refreshed
  const numeric = col === "quantity" || MONEY.has(col);
  if (!edit) {
    return col === "product_url" && initial
      ? <a className="block truncate px-2 text-asu-gold hover:underline" href={initial} target="_blank" rel="noreferrer">open</a>
      : <span className={`block truncate px-2 leading-8 ${numeric ? "text-right" : ""}`}>{initial}</span>;
  }
  return (
    <input
      data-key={col}
      className={`h-8 w-full bg-transparent px-2 outline-none hover:bg-white/[0.03] focus:bg-helios-strip focus:ring-1 focus:ring-asu-gold ${numeric ? "text-right" : ""} ${col === "title" ? "font-semibold" : ""}`}
      type={col === "needed_by" ? "date" : "text"}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => { if (e.currentTarget.value !== initial) onSave(e.currentTarget.value); }}
    />
  );
}
