import { Fragment, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { IconArrowsSort, IconChevronDown, IconColumns3, IconLayoutRows, IconPlus, IconSearch, IconUpload, IconX } from "@tabler/icons-react";
import type { SupabaseClient } from "@helios/auth";
import {
  ORDERED_STATUSES, REQUESTER_MOVES, STATUSES, addItems, addTracking, can, decide, deleteView, detectCarrier, importItems, itemCost, recordOrder,
  deleteItems, moveItems, saveView, setCarSubteam, setStatus, subteamsOfCar, undoOrder, updateItem, type Item, type Priority, type Status, type Subteam,
} from "../lib/api";
import { today } from "../lib/dates";
import { centsToInput, fmtCents, parseCents, requireCents } from "../lib/money";
import { parseCsv, parseTsv, type NewRow, type PasteField } from "../lib/paste";
import { normalizeVendor } from "../finance/importers";
import type { PurchasingData } from "../lib/usePurchasing";
import { PasteDialog } from "../components/PasteDialog";
import { OrderDialog } from "../components/OrderDialog";
import { linkHref } from "../lib/links";
import { inRange, rangeBounds, rangeSize, summarize, type CellRange, type CellValue } from "../lib/cellRange";
import { Button, Empty, PrioritySelect, StatusPill, StatusSelect, SubteamChip, useConfirm } from "../components/ui";
import { ViewBar, ViewEditor } from "../components/ViewBar";
import { BUILTIN_VIEWS, GROUP_LABEL, SORT_LABEL, applyView, type GroupBy, type SavedView, type SortBy, type ViewConfig } from "../lib/views";

// Remembered on this computer: the view and tab last open, and where new parts go.
const PREFS_KEY = "helios:agora:abacus";
interface Prefs { view?: string; tab?: string | null; addCar?: string | null; addTeam?: string | null }
function loadPrefs(): Prefs {
  try { return (JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Prefs) ?? {}; } catch { return {}; }
}

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
  { key: "justification", label: "Why", field: "justification", className: "min-w-[200px]" },
];
/** Empty cells worth filling in while a part is still being planned. */
const HINTS: Record<string, string> = { unit_price_cents: "price?", vendor: "vendor?", product_url: "link?" };
/** The checkbox, # and Item columns stay put while the sheet scrolls sideways. */
const STICK = { check: "sticky left-0 min-w-[2rem] max-w-[2rem]", code: "sticky left-8 min-w-[4rem] max-w-[4rem]", title: "sticky left-24" };
const MONEY = new Set(["unit_price_cents", "tax_shipping_cents"]);
/** Grid lines: rows read across, columns stay faint. */
const ROW = "border-b border-helios-line/70";
const COLUMN = "border-l border-helios-line/40";
/** Row hover, painted over each cell's own background so the sticky columns stay opaque. */
const HOVER = "group-hover:shadow-[inset_0_0_0_9999px_rgb(var(--helios-grid)/0.45)]";
/** The header row: a shade off the sheet, opaque so rows scroll under it. */
const HEAD = "border-b border-helios-line bg-helios-panel shadow-[inset_0_0_0_9999px_rgb(var(--helios-grid)/0.6)]";
/** Columns lined up on the right: numbers and money. */
const NUMERIC = new Set(["quantity", "unit_price_cents", "tax_shipping_cents", "total"]);
/** The checkbox and code columns come before COLS. */
const FIRST_COL = 2;

/** What a cell holds, for the status bar's sum, average and count. */
function cellValue(i: Item, key: string): CellValue {
  // an unpriced part shows a blank Total, so it isn't a $0.00 in the sum, count and average
  if (key === "total") return i.actual_total_cents === null && i.total_estimate_cents === null && (i.quantity === null || i.unit_price_cents === null)
    ? null : { money: itemCost(i) };
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
  client, data, projectId, reload, flash, focus, userId = null,
}: {
  client: SupabaseClient;
  data: PurchasingData;
  /** The viewer, for "My parts". */
  userId?: string | null;
  projectId: string | null;           // null = both cars
  reload: () => Promise<void>;
  flash: (msg: string, error?: boolean) => void;
  focus?: { q: string; n: number } | null;   // show one part (from a budget breakdown)
}) {
  const { items, subteams, caps } = data;
  const exec = can(caps, "purchasing.approve");
  // the CFO: approves alone (approvals given in person), any status, moves and deletes any part
  const override = can(caps, "purchasing.override");
  const prefs = useMemo(loadPrefs, []);
  // the subteams this person asks for parts in (not every subteam, for an exec)
  const myTeams = subteams.filter((s) => !!caps?.bySubteam.get(s.id)?.has("purchasing.request"));
  // the subteam tab: the one open last time; the first time, a lead's own subteam
  const [tab, setTabState] = useState<string | null>(prefs.tab ?? null);   // subteam id, null = All
  const tabChosen = useRef(prefs.tab !== undefined);
  const setTab = (t: string | null) => { tabChosen.current = true; setTabState(t); };
  useEffect(() => {
    if (tabChosen.current || !caps) return;
    tabChosen.current = true;
    if (!exec && myTeams.length === 1) setTabState(myTeams[0]!.id);
  }, [caps]);   // eslint-disable-line react-hooks/exhaustive-deps

  // views, as in Airtable: the built-in ones, then the team's
  const allViews: SavedView[] = [...BUILTIN_VIEWS, ...data.views];
  const [viewId, setViewId] = useState(prefs.view ?? BUILTIN_VIEWS[0]!.id);
  const view = allViews.find((v) => v.id === viewId) ?? BUILTIN_VIEWS[0]!;
  // grouping, sorting and columns changed from the toolbar, not saved to the view (yet)
  const [tweak, setTweak] = useState<ViewConfig>({});
  const config: ViewConfig = { ...view.config, ...tweak };
  const tweaked = (Object.keys(tweak) as (keyof ViewConfig)[]).some((k) => JSON.stringify(tweak[k] ?? null) !== JSON.stringify(view.config[k] ?? null));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const pickView = (id: string) => { setViewId(id); setTweak({}); setCollapsed(new Set()); };
  const [editingView, setEditingView] = useState<{ id: string | null; name: string; config: ViewConfig; shared: boolean } | null>(null);
  const canEditView = (v: SavedView) => !v.id.startsWith("builtin:") && (v.owner_id === userId || exec);
  const cols = COLS.filter((c) => c.key === "title" || !config.hidden?.includes(c.key));
  const colsRef = useRef(cols); colsRef.current = cols;

  const [q, setQ] = useState("");
  // jump to one part (e.g. "Show part" from a budget breakdown)
  useEffect(() => { if (focus) { setTab(null); pickView(BUILTIN_VIEWS[0]!.id); setQ(focus.q); } }, [focus]);   // eslint-disable-line react-hooks/exhaustive-deps
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
  useEffect(() => { if (tab && subteams.length && !carTeams.some((s) => s.id === tab)) setTab(null); }, [projectId, carTeams, tab]);   // eslint-disable-line react-hooks/exhaustive-deps
  const inProject = (i: Item) => !projectId || i.item_allocations.some((a) => a.project_id === projectId);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) if (inProject(i)) for (const a of i.item_allocations) m.set(a.subteam_id, (m.get(a.subteam_id) ?? 0) + 1);
    return m;
  }, [items, projectId]);

  const base = items.filter((i) =>
    inProject(i)
    && (!tab || i.item_allocations.some((a) => a.subteam_id === tab))
    && (!q || `${i.code} ${i.title} ${i.vendor ?? ""} ${i.part_number} ${i.notes} ${i.requester_name}`.toLowerCase().includes(q.toLowerCase())));
  const { groups, rows } = applyView(base, config, { userId, subteams, today: today(), collapsed });
  const grouped = (config.groupBy ?? "none") !== "none";
  const shownCount = groups.reduce((t, g) => t + g.items.length, 0);
  const total = groups.reduce((t, g) => t + g.total_cents, 0);

  // where a new part goes: the open car and tab, or (on Both cars / All) the
  // car and subteam picked beside the new-part row, remembered
  const [addCarPick, setAddCar] = useState<string | null>(prefs.addCar ?? null);
  const [addTeamPick, setAddTeam] = useState<string | null>(prefs.addTeam ?? null);
  const addCar = projectId ?? (data.projects.find((p) => p.id === addCarPick) ?? data.projects[0])?.id ?? null;
  const addTeams = addCar ? subteamsOfCar(subteams, data.carSubteams, items, addCar).filter((s) => exec || can(caps, "purchasing.request", s.id)) : [];
  const addTeam = (tab && addTeams.some((s) => s.id === tab) ? tab : null)
    ?? (addTeams.find((s) => s.id === addTeamPick) ?? addTeams.find((s) => myTeams.some((m) => m.id === s.id)) ?? addTeams[0])?.id ?? null;
  const canAdd = !!addCar && !!addTeam;
  const addTeamName = subteams.find((s) => s.id === addTeam)?.name ?? "";
  const addCarCode = data.projects.find((p) => p.id === addCar)?.car_code ?? "";
  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ view: viewId, tab, addCar: addCarPick, addTeam: addTeamPick } satisfies Prefs)); } catch { /* private mode */ }
  }, [viewId, tab, addCarPick, addTeamPick]);

  const canEdit = (i: Item) =>
    exec || ((i.status === "PLANNED" || i.status === "READY") && i.item_allocations.some((a) => can(caps, "purchasing.request", a.subteam_id)));
  const statusOptions = (i: Item): Status[] => {
    if (override) return STATUSES;
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

  // A cell's save runs when it loses focus. The fill handle blurs the cell it
  // starts from, so it waits for that save and copies what was just typed.
  const pendingSave = useRef<Promise<unknown>>(Promise.resolve());
  const savedPatch = useRef(new Map<string, Record<string, unknown>>());
  useEffect(() => { savedPatch.current.clear(); }, [data.items]);
  function save(i: Item, key: string, raw: string) {
    const patch = toPatch(key, raw);
    if (!patch) { flash(`"${raw.trim()}" isn't a valid ${COLS.find((c) => c.key === key)?.label.toLowerCase() ?? "value"}. Nothing was changed.`, true); return; }
    savedPatch.current.set(i.id, { ...savedPatch.current.get(i.id), ...patch });
    // a refused save leaves nothing for a fill to copy
    const p = run("", async () => { try { await updateItem(client, i.id, patch); } catch (e) { savedPatch.current.delete(i.id); throw e; } });
    pendingSave.current = p;
    return p;
  }

  // ---- cell ranges: drag across cells (or shift-click) to add them up; drag
  // the corner square down to copy the cells into the rows below
  useEffect(() => { select(null); }, [tab, viewId, tweak, collapsed, q, projectId]);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const applyFillRef = useRef<() => Promise<void>>(async () => {});
  const flashRef = useRef(flash); flashRef.current = flash;
  useEffect(() => {
    // the module stays mounted while hidden: only act while the sheet is on screen
    const shown = () => !!tableRef.current && tableRef.current.offsetParent !== null;
    const up = () => { if (drag.current === "fill") void applyFillRef.current(); drag.current = null; };
    const outside = (e: MouseEvent) => { if (!tableRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-sheet-bar]")) select(null); };
    // Escape clears a range wherever focus is (a drag blurs the cell), unless
    // it's in a box outside the sheet (a dialog, the search)
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !rangeRef.current || !shown()) return;
      const a = document.activeElement;
      if (a && a !== document.body && !tableRef.current!.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      select(null);
    };
    // a range of 2+ cells is copied as a range even while a cell in it has focus
    const copy = (e: globalThis.ClipboardEvent) => {
      const r = rangeRef.current;
      if (!r || rangeSize(r) < 2 || !shown()) return;
      const { r0, r1, c0, c1 } = rangeBounds(r);
      const lines = rowsRef.current.slice(r0, r1 + 1).map((i) => colsRef.current.slice(c0, c1 + 1).map((c) => cellText(i, c.key)).join("\t"));
      e.clipboardData?.setData("text/plain", lines.join("\n"));
      e.preventDefault();
      flashRef.current(`Copied ${rangeSize(r)} cells.`);
    };
    document.addEventListener("mouseup", up);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key);
    document.addEventListener("copy", copy);
    return () => {
      document.removeEventListener("mouseup", up); document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", key); document.removeEventListener("copy", copy);
    };
  }, []);
  function cellAt(target: EventTarget): [number, number] | null {
    const td = (target as HTMLElement).closest?.("td");
    const id = (td?.parentElement as HTMLElement | null)?.dataset.id;
    if (!td || !id) return null;
    const r = rows.findIndex((x) => x.id === id), k = td.cellIndex - FIRST_COL;
    return r < 0 || k < 0 || k >= cols.length ? null : [r, k];
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
  const filling = useRef(false);
  async function applyFill() {
    const r = rangeRef.current, to = fillRef.current;
    fillRef.current = null;
    setFillTo(null);
    if (!r || to === null || filling.current) return;
    filling.current = true;
    try { await fillDown(r, to); } finally { filling.current = false; }
  }
  applyFillRef.current = applyFill;
  async function fillDown(r: CellRange, to: number) {
    // the cell the fill started from may still be saving what was typed in it
    await pendingSave.current.catch(() => {});
    const rows = rowsRef.current;
    const { r0, r1, c0, c1 } = rangeBounds(r);
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    let skipped = 0;
    for (let t = r1 + 1; t <= to; t++) {
      // like Excel: the selected rows repeat down
      const target = rows[t], src = rows[r0 + ((t - r0) % (r1 - r0 + 1))];
      if (!target || !src) continue;
      const from = { ...src, ...savedPatch.current.get(src.id) } as Item;
      if (!canEdit(target)) { skipped++; continue; }
      const patch: Record<string, unknown> = {};
      for (let k = c0; k <= c1; k++) Object.assign(patch, fillPatch(from, cols[k]!.key) ?? {});
      if (Object.keys(patch).length) updates.push({ id: target.id, patch });
    }
    if (!updates.length) { if (skipped) flash(`You can't edit ${skipped === 1 ? "that part" : "those parts"} (approved already, or another subteam's).`, true); return; }
    flash(`Filling ${updates.length} row${updates.length === 1 ? "" : "s"}...`);
    let done = 0;
    try {
      for (const u of updates) { await updateItem(client, u.id, u.patch); done++; }
      flash(`Filled ${done} row${done === 1 ? "" : "s"}${skipped ? `; ${skipped} you can't edit were skipped` : ""}.`);
    } catch (e) {
      const code = rows.find((x) => x.id === updates[done]?.id)?.code ?? "a part";
      flash(`Filled ${done} of ${updates.length}, then ${code}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    await reload();
    select({ a: [r0, c0], b: [to, c1] });
  }
  const bounds = range ? rangeBounds(range) : null;
  const summary = range && rangeSize(range) > 1 && bounds
    ? summarize(rows.slice(bounds.r0, bounds.r1 + 1).flatMap((i) => cols.slice(bounds.c0, bounds.c1 + 1).map((c) => cellValue(i, c.key))))
    : null;

  // ---- keyboard: Enter / arrows move between rows like a spreadsheet
  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    if (e.key === "Escape") { select(null); return; }
    const el = e.target as HTMLElement;
    const cell = el.closest("td");
    const tr = cell?.parentElement;
    if (!cell || !tr) return;
    if (e.key === "Enter" && tr.dataset.new !== undefined) { e.preventDefault(); void addFromNewRow(); return; }
    const all = [...(tableRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-new], tr[data-id]") ?? [])];
    const at = all.indexOf(tr as HTMLTableRowElement);
    let target: Element | null = null;
    if (e.key === "Enter" || e.key === "ArrowDown") target = all[at + 1] ?? null;
    else if (e.key === "ArrowUp") target = all[at - 1] ?? null;
    else return;
    if (el.tagName === "SELECT" && e.key !== "Enter") return;
    const next = target?.children[cell.cellIndex]?.querySelector<HTMLElement>("input,select");
    if (next) { e.preventDefault(); (el as HTMLInputElement).blur(); next.focus(); (next as HTMLInputElement).select?.(); }
  }

  // ---- the new-part row, pinned at the top of the sheet
  const [draft, setDraft] = useState<Record<string, string>>({});
  const focusNewRow = () => window.setTimeout(() => tableRef.current?.querySelector<HTMLInputElement>("tr[data-new] input[data-new-title]")?.focus(), 50);
  async function addFromNewRow() {
    if (!canAdd || !addCar || !addTeam) { flash("Pick the car and subteam it's for first.", true); return; }
    if (!draft.title?.trim()) { flash("Give the item a name first", true); return; }
    const row: NewRow = { title: draft.title.trim() };
    if (draft.quantity) row.quantity = Number(draft.quantity);
    if (draft.quantity && !(Number(draft.quantity) > 0)) { flash(`"${draft.quantity}" isn't a valid quantity.`, true); return; }
    try {
      const unit = requireCents(draft.unit_price_cents, "unit price"); if (unit !== null) row.unit_price_cents = unit;
      const tax = requireCents(draft.tax_shipping_cents, "tax/shipping"); if (tax !== null) row.tax_shipping_cents = tax;
      const tot = requireCents(draft.total, "total"); if (tot !== null) row.total_estimate_cents = tot;
    } catch (e) { flash((e as Error).message, true); return; }
    for (const k of ["vendor", "funding_source", "part_number", "product_url", "notes", "justification", "needed_by", "priority"] as const) if (draft[k]) row[k] = draft[k];
    const ready = draft.status === "READY";
    await run(`Added ${row.title} to ${addCarCode} ${addTeamName}${ready ? " and sent it for approval" : ""}`, () => addItems(client, addCar, addTeam, [row], ready));
    // keep the priority, status and vendor for the next one: parts usually come in batches
    setDraft((d) => ({ priority: d.priority ?? "", status: d.status ?? "", vendor: d.vendor ?? "" }));
    focusNewRow();
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
      if (canAdd) setPaste({ matrix: leftover, start: cell.cellIndex });
      else flash(`${leftover.length} extra row(s) not added: pick the car and subteam they're for first`, true);
    }
  }
  const startFields = (start: number): (PasteField | null)[] =>
    cols.slice(Math.max(0, start - FIRST_COL)).map((c) => c.field);

  // ---- bulk actions
  const ids = [...selected].filter((id) => rows.some((r) => r.id === id));
  const [bulk, setBulk] = useState("");
  const [cart, setCart] = useState<Item[] | null>(null);
  const [ask, confirmDialog] = useConfirm();
  const [order, setOrder] = useState({ id: "", payment: "SAE card", total: "", on: today(), paidBy: "" });
  const [track, setTrack] = useState({ number: "", carrier: "", eta: "" });
  const [move, setMove] = useState("");   // car id and subteam id, joined by |
  async function applyBulk() {
    if (!ids.length || !bulk) return;
    if (bulk.startsWith("status:")) {
      const s = bulk.slice(7) as Status;
      await run(`${ids.length} item(s) updated`, () => setStatus(client, ids, s));
    } else if (bulk === "approve-now") {
      await run(`Approved ${ids.length} item(s)`, () => setStatus(client, ids, "APPROVED", "approved in person"));
    } else if (bulk === "move") {
      const [p, st] = move.split("|");
      if (!p || !st) { flash("Pick the car and subteam to move them to.", true); return; }
      await run("", async () => { const n = await moveItems(client, ids, p, st); flash(`Moved ${n} part${n === 1 ? "" : "s"}.`); });
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
        body: <>They're removed from Abacus for good (the parts history keeps the whole part and who deleted it). {override
          ? "Approved and ordered parts go too, and stop counting toward budgets. Parts matched to a ledger charge can't be deleted: unmatch them in the ledger first."
          : "Approved and ordered parts can't be deleted (they count toward budgets): cancel them, or undo the order, first. Nor can parts matched to a ledger charge or a reimbursement."}
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
      const lines = [["Item", "Qty", "Unit $", "Tax/ship $", "Vendor", "Funding", "Part #", "Link", "Needed by", "Notes"].join("\t")].concat(
        pick.map((r) => [r.title, r.quantity ?? "", centsToInput(r.unit_price_cents), centsToInput(r.tax_shipping_cents), r.vendor ?? "",
          r.funding_source ?? "", r.part_number, r.product_url, r.needed_by ?? "", r.notes].map((v) => String(v).replace(/[\t\n]/g, " ")).join("\t")));
      await navigator.clipboard.writeText(lines.join("\n"));
      flash(`Copied ${pick.length} row(s). Paste them into another tab's blank row, or into Excel.`);
      return;
    }
    setSelected(new Set());
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));

  async function storeView(v: { id: string | null; name: string; config: ViewConfig; shared: boolean }) {
    try {
      const id = await saveView(client, v);
      await reload();
      pickView(id);
      setEditingView(null);
      flash(`View "${v.name.trim()}" saved${v.shared ? " for the team" : " (only you see it)"}.`);
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  }
  async function removeView(v: SavedView) {
    const ok = await ask({ title: `Delete the view "${v.name}"?`, body: `${v.shared ? "It goes for everyone." : "Only you had it."} No parts change.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try { await deleteView(client, v.id); await reload(); pickView(BUILTIN_VIEWS[0]!.id); setEditingView(null); flash("View deleted."); }
    catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  }

  // one part's row; r is its place in `rows` (for cell ranges)
  const renderRow = (i: Item, r: number) => {
    const edit = canEdit(i);
    const planning = i.status === "PLANNED" || i.status === "READY";
    // a ticked row is tinted across, over each cell's own background
    // (both tints are inset shadows, so a ticked row keeps gold on hover rather than falling back to grey)
    const hl = selected.has(i.id) ? "shadow-[inset_0_0_0_9999px_rgb(var(--asu-gold)/0.08)] group-hover:shadow-[inset_0_0_0_9999px_rgb(var(--asu-gold)/0.14)]" : HOVER;
    return (
      <tr key={i.id} data-id={i.id} className={`group ${i.status === "CANCELLED" || i.status === "HAVE" ? "opacity-55" : ""}`}>
        <td className={`${STICK.check} z-[1] ${ROW} bg-helios-panel ${hl} text-center`}>
          <input type="checkbox" aria-label={`Select ${i.code}`} checked={selected.has(i.id)}
            onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} />
        </td>
        <td className={`${STICK.code} z-[1] ${ROW} bg-helios-panel ${hl} px-2 font-mono text-[11px] text-helios-muted`} title={i.code}>{i.code.slice(4)}</td>
        {cols.map((c, k) => {
          const on = inRange(range, r, k);
          const filling = fillTo !== null && bounds !== null && r > bounds.r1 && r <= fillTo && k >= bounds.c0 && k <= bounds.c1;
          const corner = !!bounds && fillTo === null && r === bounds.r1 && k === bounds.c1;
          const stuck = c.key === "title";
          const mark = on ? "bg-asu-gold/15" : filling ? "bg-asu-gold/[0.07] outline-dashed outline-1 -outline-offset-1 outline-asu-gold/60" : "";
          return (
          <td key={c.key} className={`${stuck ? `${STICK.title} z-[1] bg-helios-panel` : `relative ${mark}`} ${hl} ${ROW} ${COLUMN} ${c.className}`}>
            {stuck && mark && <span className={`pointer-events-none absolute inset-0 ${mark}`} />}
            {corner && (
              <span title="Drag down to copy into the rows below" data-fill-handle=""
                onMouseDown={(e) => {
                  // save what's being typed in the cell first: the fill copies it
                  (document.activeElement as HTMLElement | null)?.blur?.();
                  e.stopPropagation(); e.preventDefault(); drag.current = "fill"; fillRef.current = null; setFillTo(null);
                }}
                className="absolute -bottom-[3px] -right-[3px] z-20 size-[7px] cursor-crosshair border border-helios-base bg-asu-gold" />
            )}
            {c.key === "status" ? (
              <div className="flex h-10 items-center px-2"><StatusSelect status={i.status} options={statusOptions(i)}
                onChange={(s) => void run(`${i.code}: ${s.toLowerCase()}`, () => setStatus(client, [i.id], s))} /></div>
            ) : c.key === "priority" ? (
              <div className="flex h-10 items-center px-2"><PrioritySelect priority={i.priority} editable={edit}
                onChange={(p: Priority) => void save(i, "priority", p)} /></div>
            ) : c.key === "total" ? (
              <div className="px-3 text-right font-semibold tabular-nums leading-10" title={i.actual_total_cents !== null ? "What was charged" : "Estimate"}>
                {cellValue(i, "total") === null ? <span className="font-normal text-helios-muted">-</span> : fmtCents(itemCost(i))}
                {i.actual_total_cents !== null && <span className="ml-1 rounded bg-helios-success/15 px-1 text-[10px] font-semibold text-helios-success">paid</span>}
              </div>
            ) : (
              <Cell item={i} col={c.key} edit={edit} hint={planning ? HINTS[c.key] : undefined} onSave={(v) => void save(i, c.key, v)} />
            )}
          </td>
          );
        })}
        {!tab && <td className={`${ROW} ${COLUMN} ${hl} px-3`}>
          <SubteamChip subteam={subteams.find((s) => s.id === subteamOf(i))} /></td>}
        <td className={`${ROW} ${COLUMN} ${hl} whitespace-nowrap px-3 text-xs text-helios-dim`}>{i.requester_name}</td>
      </tr>
    );
  };
  const span = cols.length + (tab ? 3 : 4);
  let rowAt = -1;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* sheet tabs: the subteams with parts (and your own), the rest a click away */}
      <SubteamTabs teams={carTeams} counts={counts} all={items.filter(inProject).length} tab={tab} setTab={setTab} pinned={myTeams.map((s) => s.id)}
        addOnCar={canStructure && projectId && notOnCar.length > 0 ? {
          car: data.projects.find((p) => p.id === projectId)?.car_code ?? "",
          teams: notOnCar,
          add: (id: string) => void run("Subteam added to this car.", () => setCarSubteam(client, projectId, id, true)).then(() => setTab(id)),
        } : null} />

      <ViewBar views={allViews} active={view.id} onPick={pickView} canEdit={canEditView}
        onNew={() => setEditingView({ id: null, name: "", config, shared: true })}
        onEdit={(v) => setEditingView({ id: v.id, name: v.name, config: v.config, shared: v.shared })} />

      {/* the toolbar: find, arrange, add */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-helios-line bg-helios-panel px-2 py-1.5">
        <label className="flex h-8 min-w-[8rem] max-w-[16rem] flex-1 items-center gap-2 rounded-md border border-helios-line bg-helios-base px-2 focus-within:border-asu-gold/70">
          <IconSearch size={15} className="shrink-0 text-helios-muted" />
          <input className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-helios-muted" placeholder="Search parts, vendors, part #..."
            aria-label="Search parts" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button aria-label="Clear the search" className="text-helios-muted hover:text-helios-text" onClick={() => setQ("")}><IconX size={14} /></button>}
        </label>
        <span className="mx-1 h-5 w-px bg-helios-line" />
        <ToolSelect icon={<IconLayoutRows size={15} />} label="Group" value={config.groupBy ?? "none"} active={(config.groupBy ?? "none") !== "none"}
          onChange={(v) => { setTweak((t) => ({ ...t, groupBy: v as GroupBy })); setCollapsed(new Set()); }}
          options={(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => [g, GROUP_LABEL[g]])} />
        <ToolSelect icon={<IconArrowsSort size={15} />} label="Sort" value={config.sortBy ?? "sheet"} active={(config.sortBy ?? "sheet") !== "sheet"}
          onChange={(v) => setTweak((t) => ({ ...t, sortBy: v as SortBy }))}
          options={(Object.keys(SORT_LABEL) as SortBy[]).map((x) => [x, SORT_LABEL[x]])} />
        <details className="relative">
          <summary className={`${TOOL} list-none ${config.hidden?.length ? "text-asu-gold" : ""}`}>
            <IconColumns3 size={15} />Columns{config.hidden?.length ? <span className="text-xs">({config.hidden.length} hidden)</span> : null}
          </summary>
          <div className="absolute left-0 z-30 mt-1 flex w-52 flex-col gap-0.5 rounded-lg border border-helios-line bg-helios-panel p-1.5 text-sm text-helios-text shadow-xl">
            {COLS.map((c) => (
              <label key={c.key} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-helios-strip"><input type="checkbox" checked={!config.hidden?.includes(c.key)} disabled={c.key === "title"}
                onChange={(e) => setTweak((t) => {
                  const h = config.hidden ?? [];
                  return { ...t, hidden: e.target.checked ? h.filter((x) => x !== c.key) : [...h, c.key] };
                })} />{c.label}</label>
            ))}
          </div>
        </details>

        {canAdd && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="flex items-center gap-1 text-xs text-helios-dim" title="Where parts typed or pasted into the new-part row go">
              to
              {projectId ? <b className="text-helios-text">{addCarCode}</b> : (
                <select aria-label="Car for new parts" className={SMALL_SELECT} value={addCar ?? ""} onChange={(e) => setAddCar(e.target.value)}>
                  {data.projects.map((p) => <option key={p.id} value={p.id}>{p.car_code}</option>)}
                </select>
              )}
              {tab && addTeam === tab ? <b className="text-helios-text">{addTeamName}</b> : (
                <select aria-label="Subteam for new parts" className={`${SMALL_SELECT} max-w-[8rem]`} value={addTeam ?? ""} onChange={(e) => setAddTeam(e.target.value)}>
                  {addTeams.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </select>
              )}
            </span>
            <label className={`${TOOL} cursor-pointer`} title={`Upload an Airtable (or Excel) CSV export into ${addCarCode} ${addTeamName}`}>
              <IconUpload size={15} /><span className="sr-only">Upload CSV</span>
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => {
                const f = e.target.files?.[0]; e.target.value = "";
                if (f) void f.text().then((text) => {
                  const matrix = parseCsv(text);
                  if (matrix.length) setPaste({ matrix, start: FIRST_COL }); else flash("That file has no rows.", true);
                });
              }} />
            </label>
            <Button onClick={focusNewRow} title="Type in the new-part row at the top and press Enter; it stays there for the next one. Paste rows from Excel, Airtable or a Mouser/Digikey cart into it to add them all at once.">
              <span className="flex items-center gap-1"><IconPlus size={15} stroke={2.2} />New part</span></Button>
          </div>
        )}
      </div>

      {tweaked && (
        <div className="-mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-asu-gold/10 px-3 py-1.5 text-xs">
          <span className="text-helios-dim">You've changed how "{view.name}" groups, sorts or shows columns. Only you see this until it's saved.</span>
          {canEditView(view) && <button className="font-semibold text-asu-gold hover:underline" onClick={() => void storeView({ id: view.id, name: view.name, config, shared: view.shared })}>Save to "{view.name}"</button>}
          <button className="font-semibold text-asu-gold hover:underline" onClick={() => setEditingView({ id: null, name: "", config, shared: true })}>Save as a new view</button>
          <button className="text-helios-dim hover:text-helios-text hover:underline" onClick={() => setTweak({})}>Undo</button>
        </div>
      )}

      {!canAdd && <p className="rounded-md border border-helios-line bg-helios-panel px-3 py-2 text-xs text-helios-dim">You can see every part here. Adding parts needs a subteam role: ask an exec.</p>}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-helios-line bg-helios-panel">
        <table ref={tableRef} className="w-full select-none border-separate border-spacing-0 text-[13.5px] [&_input]:select-text"
          onKeyDown={onKeyDown} onPaste={onPaste} onMouseDown={onMouseDown} onMouseOver={onMouseOver}>
          <thead className="sticky top-0 z-10">
            <tr className="text-[12px] font-medium text-helios-dim">
              <th className={`${STICK.check} z-[2] ${HEAD} p-2`}>
                <input type="checkbox" aria-label="Select all" checked={allChecked}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
              </th>
              <th className={`${STICK.code} z-[2] ${HEAD} px-2 text-left font-medium`}>#</th>
              {cols.map((c) => <th key={c.key} className={`${c.key === "title" ? `${STICK.title} z-[2]` : ""} ${HEAD} ${COLUMN} h-10 px-3 font-medium ${NUMERIC.has(c.key) ? "text-right" : "text-left"} ${c.className}`}>{c.label}</th>)}
              {!tab && <th className={`${HEAD} ${COLUMN} px-3 text-left font-medium`}>Subteam</th>}
              <th className={`${HEAD} ${COLUMN} px-3 text-left font-medium`}>Asked by</th>
            </tr>
            {canAdd && (
              <tr data-new="" className="text-[13px] text-helios-text">
                <td className={`${STICK.check} z-[2] ${ROW} bg-helios-panel shadow-[inset_2px_0_0_rgb(var(--asu-gold))]`} />
                <td className={`${STICK.code} z-[2] ${ROW} bg-helios-panel px-2 text-asu-gold`} title={`New part for ${addCarCode} ${addTeamName}`}><IconPlus size={16} stroke={2.2} /></td>
                {cols.map((c) => (
                  <td key={c.key} className={`${c.key === "title" ? `${STICK.title} z-[2]` : ""} ${ROW} ${COLUMN} bg-helios-panel ${c.className}`}>
                    <div className="bg-asu-gold/[0.05]">
                    {c.key === "status" ? (
                      <select aria-label="Status for the new part" className="h-10 w-full bg-transparent px-2 text-xs" value={draft.status || "PLANNED"}
                        onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}>
                        <option value="PLANNED">Not ready to order</option><option value="READY">Ready: send for approval</option>
                      </select>
                    ) : c.key === "priority" ? (
                      <select aria-label="Priority for the new part" className="h-10 w-full bg-transparent px-2 text-xs" value={draft.priority || "Medium"}
                        onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}>
                        <option value="Medium">Medium</option><option value="HIGH">High</option><option value="Low">Low</option>
                      </select>
                    ) : (
                      <input
                        {...(c.key === "title" ? { "data-new-title": "" } : {})}
                        aria-label={`New part: ${c.label}`}
                        className={`h-10 w-full bg-transparent px-3 outline-none placeholder:text-helios-muted focus:ring-1 focus:ring-inset focus:ring-asu-gold ${NUMERIC.has(c.key) ? "text-right" : ""} ${c.key === "needed_by" ? DATE_EMPTY : ""}`}
                        type={c.key === "needed_by" ? "date" : "text"}
                        required={c.key === "needed_by"}
                        placeholder={c.key === "title" ? `Add a part to ${addCarCode} ${addTeamName}, or paste rows` : c.key === "total" ? "auto" : ""}
                        value={draft[c.key] ?? ""}
                        onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                      />
                    )}
                    </div>
                  </td>
                ))}
                <td colSpan={tab ? 1 : 2} className={`${ROW} ${COLUMN} bg-helios-panel px-3 text-xs text-helios-dim`}>
                  <button className="whitespace-nowrap rounded-md bg-asu-gold/15 px-2 py-1 font-semibold text-asu-gold hover:bg-asu-gold/25" title="Or press Enter" onClick={() => void addFromNewRow()}>Add</button>
                </td>
              </tr>
            )}
          </thead>
          <tbody>
            {groups.map((g) => {
              const open = !collapsed.has(g.key);
              const ids = g.items.map((i) => i.id);
              const allIn = ids.length > 0 && ids.every((id) => selected.has(id));
              return (
                <Fragment key={g.key}>
                  {grouped && (
                    <tr data-group="">
                      <td colSpan={span} className={`${HEAD} p-0`}>
                        <div className="sticky left-0 inline-flex items-center gap-2 px-2 py-2">
                          <input type="checkbox" aria-label={`Select every part in ${g.label}`} checked={allIn}
                            onChange={(e) => setSelected((s) => { const n = new Set(s); for (const id of ids) { if (e.target.checked) n.add(id); else n.delete(id); } return n; })} />
                          <button className="flex items-center gap-2 text-left" aria-expanded={open}
                            onClick={() => setCollapsed((c) => { const n = new Set(c); if (open) n.add(g.key); else n.delete(g.key); return n; })}>
                            <span className="w-3 text-helios-dim">{open ? "\u25BE" : "\u25B8"}</span>
                            {config.groupBy === "status" && g.items[0] ? <StatusPill status={g.items[0].status} /> : <b className="text-[13.5px]">{g.label}</b>}
                            <span className="rounded-full bg-helios-base px-2 py-0.5 text-xs tabular-nums text-helios-dim">{g.items.length} part{g.items.length === 1 ? "" : "s"} · {fmtCents(g.total_cents)}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {open && g.items.map((i) => { rowAt++; return renderRow(i, rowAt); })}
                </Fragment>
              );
            })}
            {!groups.length && (
              <tr><td colSpan={span} className="p-8"><Empty>{base.length ? `Nothing in "${view.name}" here.` : "Nothing here yet."}</Empty></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* the status bar, as in Excel: what the selected cells add up to */}
      <div data-sheet-bar="" className="-mt-1 flex min-h-[22px] flex-wrap items-center gap-x-4 px-1 text-xs text-helios-dim">
        <span><b className="tabular-nums text-helios-text">{shownCount}</b> part{shownCount === 1 ? "" : "s"} · <b className="tabular-nums text-helios-text">{fmtCents(total)}</b> estimated</span>
        <span className="ml-auto flex flex-wrap items-center gap-x-4">
        {summary ? <>
          {summary.moneyCount > 0 && <>
            <span>Sum <b className="tabular-nums text-helios-text">{fmtCents(summary.moneySum)}</b></span>
            <span>Average <b className="tabular-nums text-helios-text">{fmtCents(Math.round(summary.moneySum / summary.moneyCount))}</b></span>
          </>}
          {summary.numberCount > 0 && <span>{summary.moneyCount > 0 ? "Qty total" : "Sum"} <b className="tabular-nums text-helios-text">{summary.numberSum}</b></span>}
          <span>Count <b className="tabular-nums text-helios-text">{summary.count}</b></span>
        </> : range ? <span>Drag across cells (or shift-click) to add them up; drag the gold corner down to fill the rows below. Ctrl+C copies a range.</span> : null}
        </span>
      </div>

      {ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-asu-gold/70 bg-helios-panel px-4 py-2.5 shadow-[0_8px_30px_rgb(0_0_0/0.35)]">
          <b className="mr-1 text-asu-gold">{ids.length} selected · {fmtCents(rows.filter((r) => selected.has(r.id)).reduce((t, r) => t + itemCost(r), 0))}</b>
          <select className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" value={bulk} onChange={(e) => setBulk(e.target.value)}>
            <option value="">Choose an action...</option>
            <option value="status:READY">Send for approval</option>
            <option value="status:PLANNED">Back to not ready</option>
            <option value="status:RECEIVED">Mark received</option>
            <option value="cart">Split one cart's shipping & tax over these</option>
            <option value="copy">Copy as spreadsheet rows</option>
            {override && <>
              <option value="approve-now">Approve now (in person, no second exec)</option>
              <option value="move">Move to another subteam or car</option>
            </>}
            {exec && <>
              <option value="approve">{override ? "Approve (one vote of two)" : "Approve"}</option>
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
          {bulk === "move" && (
            <select className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" value={move} onChange={(e) => setMove(e.target.value)} aria-label="Move to">
              <option value="">Move to...</option>
              {data.projects.map((p) => (
                <optgroup key={p.id} label={p.car_code}>
                  {subteamsOfCar(subteams, data.carSubteams, items, p.id).map((st) => <option key={st.id} value={`${p.id}|${st.id}`}>{p.car_code} {st.name}</option>)}
                </optgroup>
              ))}
            </select>
          )}
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
      {editingView && (
        <ViewEditor initial={editingView} columns={COLS} onCancel={() => setEditingView(null)} onSave={storeView}
          onDelete={editingView.id ? async () => { const v = allViews.find((x) => x.id === editingView.id); if (v) await removeView(v); } : undefined} />
      )}
      {cart && (
        <OrderDialog client={client} items={cart} canOrder={can(caps, "purchasing.order")} canOverride={override} vendorNames={data.vendors.map((v) => v.name)}
          reload={reload} flash={flash} onClose={() => { setCart(null); setSelected(new Set()); }} />
      )}

      {paste && addCar && addTeam && (
        <PasteDialog
          matrix={paste.matrix}
          startFields={startFields(paste.start)}
          tabLabel={`${addCarCode} ${addTeamName}`}
          onCancel={() => setPaste(null)}
          existingTitles={new Set(items.filter((i) => i.item_allocations.some((a) => a.subteam_id === addTeam && a.project_id === addCar))
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
              if (s === "READY" || s === "PLANNED") await addItems(client, addCar, addTeam, rs, s === "READY");
              else if (exec) await importItems(client, addCar, addTeam, rs.map((r) => ({ ...r, status: s })));
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

/** A toolbar button's look (Columns, CSV). */
const TOOL = "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm text-helios-text hover:bg-helios-grid/60 focus-within:ring-1 focus-within:ring-asu-gold";
const SMALL_SELECT = "h-7 cursor-pointer rounded-md bg-transparent px-1 text-xs font-semibold text-helios-text hover:bg-helios-base";

/** A toolbar dropdown that reads as a button: "Group: Status". */
function ToolSelect({ icon, label, value, options, onChange, active }: {
  icon: React.ReactNode; label: string; value: string; options: [string, string][]; onChange: (v: string) => void; active: boolean;
}) {
  return (
    <label className={`${TOOL} relative ${active ? "text-asu-gold" : ""}`} title={active ? `${label}: ${options.find(([v]) => v === value)?.[1]}` : label}>
      {icon}<span>{active ? <b>{options.find(([v]) => v === value)?.[1]}</b> : label}</span>
      <IconChevronDown size={13} className="text-helios-muted" />
      <select aria-label={label} className="absolute inset-0 cursor-pointer opacity-0" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

/**
 * The subteam tabs, like a workbook's sheets. Subteams with parts, your own
 * and the open one show; the empty ones wait in "more", so a car with twenty
 * subteams doesn't bury the five that are in use.
 */
function SubteamTabs({ teams, counts, all, tab, setTab, pinned, addOnCar }: {
  teams: Subteam[]; counts: Map<string, number>; all: number; tab: string | null; setTab: (id: string | null) => void; pinned: string[];
  addOnCar: { car: string; teams: Subteam[]; add: (id: string) => void } | null;
}) {
  const shown = teams.filter((s) => (counts.get(s.id) ?? 0) > 0 || s.id === tab || pinned.includes(s.id));
  const rest = teams.filter((s) => !shown.includes(s));
  const tabClass = (on: boolean) => `-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 pb-2 pt-1 text-[13.5px] transition-colors ${on
    ? "border-asu-gold font-semibold text-helios-text" : "border-transparent text-helios-dim hover:border-helios-line hover:text-helios-text"}`;
  const count = (n: number, on: boolean) => <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? "bg-asu-gold/15 text-asu-gold" : "bg-helios-strip text-helios-muted"}`}>{n}</span>;
  return (
    <div className="flex flex-wrap items-end gap-x-1 border-b border-helios-line" role="tablist" aria-label="Subteams">
      <button role="tab" aria-selected={!tab} className={tabClass(!tab)} onClick={() => setTab(null)}>All parts {count(all, !tab)}</button>
      {shown.map((s) => (
        <button key={s.id} role="tab" aria-selected={tab === s.id} className={tabClass(tab === s.id)} onClick={() => setTab(s.id)}>
          <span className="size-2 rounded-full" style={{ background: s.color ?? "#8d8d97" }} />{s.name}{count(counts.get(s.id) ?? 0, tab === s.id)}
        </button>
      ))}
      {rest.length > 0 && (
        <label className="relative mb-1.5 ml-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-helios-dim focus-within:ring-1 focus-within:ring-asu-gold hover:bg-helios-grid/60 hover:text-helios-text">
          {rest.length} more<IconChevronDown size={13} />
          <select aria-label="Subteams with no parts yet" className="absolute inset-0 cursor-pointer opacity-0" value=""
            onChange={(e) => { if (e.target.value) setTab(e.target.value); }}>
            <option value="">No parts yet...</option>
            {rest.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      {addOnCar && (
        <label className="relative mb-1.5 ml-1 inline-flex items-center gap-1 rounded-md border border-dashed border-helios-line px-2 py-1 text-xs text-helios-dim focus-within:ring-1 focus-within:ring-asu-gold hover:text-helios-text"
          title="Put another subteam on this car (the same as Admin > Org Structure)">
          <IconPlus size={12} />subteam on {addOnCar.car}
          <select aria-label={`Add a subteam to ${addOnCar.car}`} className="absolute inset-0 cursor-pointer opacity-0" value=""
            onChange={(e) => { if (e.target.value) addOnCar.add(e.target.value); }}>
            <option value="">Add a subteam...</option>
            {addOnCar.teams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

/** "open" beside a product link; a click opens it without starting a cell selection. */
function OpenLink({ href, className = "" }: { href: string; className?: string }) {
  return (
    <a className={`text-xs text-asu-gold hover:underline ${className}`} href={href} target="_blank" rel="noreferrer" title={href}
      onMouseDown={(e) => e.stopPropagation()}>open</a>
  );
}

/** An empty date box shows nothing (not mm/dd/yyyy in every row) until it's clicked. */
const DATE_EMPTY = "[&:invalid:not(:focus)]:text-transparent [&:not(:focus)::-webkit-calendar-picker-indicator]:opacity-0 [&:hover::-webkit-calendar-picker-indicator]:opacity-60";

/** One editable cell. Saves on blur (or when paste dispatches a change) if the value changed. */
function Cell({ item, col, edit, hint, onSave }: { item: Item; col: string; edit: boolean; hint?: string; onSave: (v: string) => void }) {
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
    const href = col === "product_url" ? linkHref(initial) : null;
    return href
      ? <div className="flex items-center gap-2 px-3 leading-10"><OpenLink href={href} /><span className="truncate text-helios-dim">{initial.replace(/^https?:\/\/(www\.)?/i, "")}</span></div>
      : <span className={`block truncate px-3 leading-10 ${numeric ? "text-right tabular-nums" : ""} ${col === "title" ? "font-medium" : ""}`}>{initial}</span>;
  }
  const href = col === "product_url" ? linkHref(value) : null;
  const field = (
    <input
      data-key={col}
      placeholder={hint}
      className={`h-10 w-full truncate bg-transparent px-3 ${href ? "pr-12" : ""} outline-none placeholder:text-[12px] placeholder:italic placeholder:text-helios-muted/70 focus:bg-helios-base focus:ring-1 focus:ring-inset focus:ring-asu-gold ${numeric ? "text-right tabular-nums" : ""} ${col === "title" ? "font-medium" : ""} ${col === "needed_by" ? DATE_EMPTY : ""}`}
      type={col === "needed_by" ? "date" : "text"}
      required={col === "needed_by"}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => { if (e.currentTarget.value !== initial) onSave(e.currentTarget.value); }}
    />
  );
  return href ? <div className="relative">{field}<OpenLink href={href} className="absolute right-2 top-1/2 -translate-y-1/2" /></div> : field;
}
