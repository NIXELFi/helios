import { useMemo, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import { APPROVED_OR_LATER, recordOrderLines, updateItem, type Item } from "../lib/api";
import { centsToInput, fmtCents, parseCents } from "../lib/money";
import { extrasOf, parseOrderText, splitOrder, type OrderTotals } from "../lib/orderText";
import { pdfWords, rows } from "../finance/statementPdf";
import { today } from "../lib/dates";
import { Button } from "./ui";

const input = "rounded-md border border-helios-line bg-helios-strip px-2 py-1 text-sm";
const MONEY_FIELDS = [
  ["subtotal", "Subtotal"], ["shipping", "Shipping"], ["tax", "Tax"], ["fees", "Fees / tariffs"], ["discount", "Discount"], ["total", "Order total"],
] as const;
type MoneyField = (typeof MONEY_FIELDS)[number][0];

/** A part's price before shipping and tax: qty x unit, else the estimate without its tax/shipping. */
export function partPrice(i: Item): number {
  if (i.quantity !== null && i.unit_price_cents !== null) return Math.round(i.quantity * i.unit_price_cents);
  if (i.total_estimate_cents !== null) return i.total_estimate_cents - (i.tax_shipping_cents ?? 0);
  return i.actual_total_cents ?? 0;
}

/**
 * Spread one cart's shipping, tax and fees over the parts in it. Paste the
 * order confirmation (or the cart page) or drop its PDF, and the figures are
 * read off it; anything can be typed over. Two ways to save:
 *  - as estimates: each part's Tax/ship becomes its share (members, for their
 *    own parts still in planning; execs, any);
 *  - as the order (execs): marks the parts ordered with what each really cost.
 */
export function OrderDialog({ client, items, canOrder, vendorNames, reload, flash, onClose }: {
  client: SupabaseClient; items: Item[]; canOrder: boolean; vendorNames: string[];
  reload: () => Promise<void>; flash: (msg: string, error?: boolean) => void; onClose: () => void;
}) {
  const allApproved = items.every((i) => APPROVED_OR_LATER.has(i.status));
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [f, setF] = useState<Record<MoneyField, string> & { orderId: string; date: string }>(() => ({
    subtotal: centsToInput(items.reduce((s, i) => s + partPrice(i), 0)), shipping: "", tax: "", fees: "", discount: "", total: "",
    orderId: items.find((i) => i.vendor_order_id)?.vendor_order_id ?? "",
    // an order already placed keeps its date (charges are matched to parts by it); blank keeps each part's own
    date: items.some((i) => i.ordered_at) ? (new Set(items.map((i) => i.ordered_at)).size === 1 ? items[0]!.ordered_at! : "") : today(),
  }));
  const [mode, setMode] = useState<"whole" | "share">("whole");
  const [asOrder, setAsOrder] = useState(canOrder && allApproved);
  const [payment, setPayment] = useState(items.find((i) => i.payment_method)?.payment_method || "SAE card");
  const [paidBy, setPaidBy] = useState("");
  const [busy, setBusy] = useState(false);

  function read(t: string) {
    setText(t);
    const o = parseOrderText(t, vendorNames);
    setF((x) => ({
      ...x,
      orderId: o.orderId ?? x.orderId, date: o.date ?? x.date,
      ...Object.fromEntries(MONEY_FIELDS.map(([k]) => [k, o[k] !== null ? centsToInput(o[k]) : (k === "subtotal" ? x.subtotal : "")])),
    }));
    // a cart with more in it than these parts: give them their fraction, not the whole total
    const sum = items.reduce((s, i) => s + partPrice(i), 0);
    if (o.subtotal !== null && o.subtotal > sum + items.length) setMode("share");
    const got = MONEY_FIELDS.filter(([k]) => o[k] !== null).map(([, l]) => l.toLowerCase());
    setNote(got.length ? `Read ${got.join(", ")}${o.orderId ? `, order ${o.orderId}` : ""}. Check them against the order.` : "Couldn't find any totals in that. Type them in below.");
  }
  async function readPdf(file: File) {
    try {
      const pages = await pdfWords(await file.arrayBuffer());
      const t = pages.map((p) => rows(p).map((r) => r.map((w) => w.text).join(" ")).join("\n")).join("\n");
      if (!t.trim()) {
        setNote("That PDF is a picture of the page, with no text in it to read. Open the order in your browser or email, press Ctrl+A then Ctrl+C, and paste it here. Or type the numbers in.");
        return;
      }
      read(t);
    } catch (e) { setNote(`Couldn't read that PDF: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const totals: OrderTotals = useMemo(() => {
    const c = (k: MoneyField) => (f[k].trim() ? parseCents(f[k]) : null);
    return { orderId: f.orderId || null, date: f.date || null, vendor: null, subtotal: c("subtotal"), shipping: c("shipping"),
      tax: c("tax"), fees: c("fees"), discount: c("discount") === null ? null : -Math.abs(c("discount")!), total: c("total") };
  }, [f]);
  const parts = items.map((i) => ({ id: i.id, price: partPrice(i) }));
  const sumPrices = parts.reduce((s, p) => s + p.price, 0);
  const mismatch = totals.subtotal !== null && Math.abs(totals.subtotal - sumPrices) > items.length;
  // only a cart with more in it than these parts can give them "their fraction"
  const partOfCart = mismatch && sumPrices < totals.subtotal!;
  // estimates keep each part's price and add its share of the extras (all of
  // them, unless the cart clearly had other things in it too)
  const shares = asOrder ? splitOrder(parts, totals, partOfCart ? mode : "whole")
    : splitOrder(parts, { ...totals, total: null }, partOfCart ? "share" : "whole");
  const bad = MONEY_FIELDS.find(([k]) => f[k].trim() && parseCents(f[k]) === null);

  async function save() {
    if (bad) { flash(`"${f[bad[0]]}" isn't an amount.`, true); return; }
    if (!extrasOf(totals) && !asOrder) { flash("Enter the shipping, tax or fees to spread.", true); return; }
    setBusy(true);
    try {
      if (asOrder) {
        if (!f.orderId.trim()) throw new Error("Enter the vendor's order number.");
        await recordOrderLines(client, shares.map((s) => ({ id: s.id, actual_total_cents: s.total, tax_shipping_cents: s.extra })),
          f.orderId.trim(), payment, f.date || null, mode === "whole" ? totals.total : null, paidBy);
        flash(`${items.length} part${items.length === 1 ? "" : "s"} marked ordered, each with its share of the order.`);
      } else {
        // one save per part: if one fails, say which saved, so it's clear what to redo
        const failed: string[] = [];
        let saved = 0;
        for (const s of shares) {
          try { await updateItem(client, s.id, { tax_shipping_cents: s.extra, total_estimate_cents: s.total }); saved++; }
          catch (e) { failed.push(`${items.find((i) => i.id === s.id)?.code}: ${e instanceof Error ? e.message : String(e)}`); }
        }
        if (failed.length) {
          await reload();
          throw new Error(`Saved ${saved} of ${shares.length}. Not saved: ${failed.join("; ")}`);
        }
        flash(`Tax and shipping spread over ${items.length} part${items.length === 1 ? "" : "s"}.`);
      }
      await reload();
      onClose();
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); setBusy(false); }
  }

  const waitingForApproval = items.filter((i) => i.status === "READY").length;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" role="dialog" aria-modal="true">
      <div className="flex max-h-[calc(100vh-3rem)] w-[min(1000px,94vw)] flex-col gap-3 overflow-auto rounded-xl border border-helios-line bg-helios-panel p-5 shadow-2xl">
        <div>
          <h2 className="text-base font-semibold">Split a cart's shipping and tax over {items.length} part{items.length === 1 ? "" : "s"}</h2>
          <p className="text-xs text-helios-dim">Each part gets a share in proportion to its price, so the shares add up to the cent.</p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <textarea className={`${input} h-40 font-mono text-xs`} value={text} onChange={(e) => read(e.target.value)}
              placeholder={"Paste the order confirmation email or the vendor's order page here (Ctrl+A, Ctrl+C on the page, then Ctrl+V here).\n\nOr drop the order PDF below."} />
            <label className="cursor-pointer rounded-md border border-dashed border-helios-line px-3 py-2 text-center text-sm text-helios-dim hover:bg-helios-strip"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) void readPdf(file); }}>
              Drop the order PDF here, or click to pick it
              <input type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void readPdf(file); }} />
            </label>
            {note && <p className="text-xs text-asu-gold">{note}</p>}
          </div>
          <div className="grid grid-cols-2 gap-2 self-start">
            <label className="flex flex-col gap-1 text-xs text-helios-dim">Order #<input className={input} value={f.orderId} onChange={(e) => setF({ ...f, orderId: e.target.value })} /></label>
            <label className="flex flex-col gap-1 text-xs text-helios-dim">Ordered on<input type="date" className={input} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
            {MONEY_FIELDS.map(([k, label]) => (
              <label key={k} className="flex flex-col gap-1 text-xs text-helios-dim">{label}
                <input className={`${input} text-right ${f[k].trim() && parseCents(f[k]) === null ? "border-helios-danger" : ""}`} placeholder="$0.00"
                  value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
            ))}
          </div>
        </div>

        {mismatch && (
          <div className="rounded-md border border-asu-gold/50 bg-asu-gold/10 p-2 text-xs">
            These parts add up to <b>{fmtCents(sumPrices)}</b> but the order's subtotal is <b>{fmtCents(totals.subtotal)}</b>.
            {!partOfCart ? <> That's more than the order: check these are the right parts. Prices may have changed since the estimate; {asOrder
              ? "the order total is spread over them by price." : "the shipping and tax are spread over them by price."}</>
            : asOrder ? (
              <div className="mt-1 flex flex-wrap gap-4">
                <label className="flex items-center gap-1"><input type="radio" checked={mode === "whole"} onChange={() => setMode("whole")} />These are everything in the order (prices changed): spread the whole total</label>
                <label className="flex items-center gap-1"><input type="radio" checked={mode === "share"} onChange={() => setMode("share")} />The order had other things too: give these parts only their share</label>
              </div>
            ) : <> Each part keeps its price and gets its fraction of the shipping and tax (its price over the order's subtotal).</>}
          </div>
        )}

        <div className="overflow-auto rounded-md border border-helios-line">
          <table className="w-full text-xs">
            <thead className="bg-helios-strip text-[11px] uppercase tracking-wider text-helios-dim">
              <tr><th className="p-1.5 text-left">Part</th><th className="p-1.5 text-right">Price</th><th className="p-1.5 text-right">Its tax/ship</th><th className="p-1.5 text-right">{asOrder ? "Cost" : "New estimate"}</th></tr>
            </thead>
            <tbody>
              {shares.map((s) => {
                const i = items.find((x) => x.id === s.id)!;
                return (
                  <tr key={s.id} className="border-t border-helios-line">
                    <td className="p-1.5"><span className="font-mono text-helios-dim">{i.code}</span> {i.title}</td>
                    <td className="p-1.5 text-right tabular-nums">{fmtCents(s.price)}</td>
                    <td className="p-1.5 text-right tabular-nums">{fmtCents(s.extra)}</td>
                    <td className="p-1.5 text-right font-semibold tabular-nums">{fmtCents(s.total)}</td>
                  </tr>
                );
              })}
              <tr className="border-t border-helios-line text-helios-dim">
                <td className="p-1.5 text-right">Together</td>
                <td className="p-1.5 text-right tabular-nums">{fmtCents(shares.reduce((t, s) => t + s.price, 0))}</td>
                <td className="p-1.5 text-right tabular-nums">{fmtCents(shares.reduce((t, s) => t + s.extra, 0))}</td>
                <td className="p-1.5 text-right font-semibold tabular-nums text-helios-text">{fmtCents(shares.reduce((t, s) => t + s.total, 0))}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {canOrder && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="radio" checked={!asOrder} onChange={() => setAsOrder(false)} />Save as estimates (not bought yet)</label>
            <label className={`flex items-center gap-1 ${allApproved ? "" : "opacity-50"}`} title={allApproved ? "" : "Only approved parts can be marked ordered"}>
              <input type="radio" checked={asOrder} disabled={!allApproved} onChange={() => setAsOrder(true)} />This is the order: mark them ordered with these costs
            </label>
            {asOrder && <>
              <input className={`${input} w-36`} placeholder="Paid with" value={payment} onChange={(e) => setPayment(e.target.value)} />
              <input className={`${input} w-48`} placeholder="Member who paid (if any)" value={paidBy} onChange={(e) => setPaidBy(e.target.value)} />
            </>}
          </div>
        )}
        {!asOrder && waitingForApproval > 0 && (
          <p className="text-xs text-helios-dim">{waitingForApproval} of these {waitingForApproval === 1 ? "is" : "are"} waiting for approval. A new cost restarts {waitingForApproval === 1 ? "its" : "their"} approvals, so execs approve the real price.</p>
        )}

        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy}>{busy ? "Saving..." : asOrder ? "Mark ordered" : "Save estimates"}</Button>
        </div>
      </div>
    </div>
  );
}
