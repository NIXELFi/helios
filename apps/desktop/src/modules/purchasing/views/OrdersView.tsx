import { useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import { addTracking, detectCarrier, itemCost, recordOrder, setStatus, trackingUrl, type Item } from "../lib/api";
import { fmtCents, parseCents } from "../lib/money";
import type { PurchasingData } from "../lib/usePurchasing";
import { Button, Card, Empty, StatusPill, SubteamChip } from "../components/ui";

export function OrdersView({
  client, data, reload, flash,
}: {
  client: SupabaseClient;
  data: PurchasingData;
  reload: () => Promise<void>;
  flash: (msg: string, error?: boolean) => void;
}) {
  const { items, subteams } = data;
  const toOrder = items.filter((i) => i.status === "APPROVED");
  const moving = items.filter((i) => ["ORDERED", "BACKORDERED", "SHIPPED", "DELIVERED"].includes(i.status));
  const groups = new Map<string, Item[]>();
  for (const i of moving) {
    const key = i.vendor_order_id || `(no order #) ${i.vendor ?? ""} ${i.code}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState({ id: "", payment: "SAE card", total: "", on: new Date().toISOString().slice(0, 10), paidBy: "" });
  const [tracking, setTracking] = useState<Record<string, { number: string; carrier: string; eta: string }>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<unknown>) {
    try { await fn(); await reload(); flash(label); } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  }

  const sub = (i: Item) => subteams.find((s) => s.id === i.item_allocations[0]?.subteam_id);

  return (
    <div className="flex flex-col gap-6">
      {message && (
        <Card className="border-asu-gold">
          <div className="flex items-center justify-between">
            <b>Tell the requester</b>
            <Button onClick={() => { void navigator.clipboard.writeText(message); flash("Copied."); }}>Copy</Button>
          </div>
          <textarea readOnly className="mt-2 w-full rounded-md border border-helios-line bg-helios-strip p-2 text-sm" value={message} />
        </Card>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-helios-dim">To order ({toOrder.length})</h2>
        {toOrder.length ? (
          <div className="overflow-auto rounded-lg border border-helios-line bg-helios-panel">
            <table className="w-full text-[13px]">
              <thead className="bg-helios-strip text-[11px] uppercase tracking-wider text-helios-dim">
                <tr><th className="w-8 p-2" /><th className="p-2 text-left">Item</th><th className="p-2 text-left">Subteam</th><th className="p-2 text-left">Vendor</th><th className="p-2 text-right">Est.</th><th className="p-2 text-left">Needed by</th><th className="p-2" /></tr>
              </thead>
              <tbody>
                {toOrder.map((i) => (
                  <tr key={i.id} className="border-t border-helios-line">
                    <td className="p-2 text-center"><input type="checkbox" checked={picked.has(i.id)}
                      onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} /></td>
                    <td className="p-2"><b>{i.title}</b><div className="text-xs text-helios-dim"><span className="font-mono">{i.code}</span>{i.quantity !== null ? ` · qty ${i.quantity}` : ""}{i.notes ? ` · ${i.notes.slice(0, 60)}` : ""}</div></td>
                    <td className="p-2"><SubteamChip subteam={sub(i)} /></td>
                    <td className="p-2">{i.vendor ?? ""}</td>
                    <td className="p-2 text-right">{fmtCents(itemCost(i))}</td>
                    <td className="p-2 text-xs">{i.needed_by ?? ""}</td>
                    <td className="p-2">{i.product_url && <a className="text-asu-gold hover:underline" href={i.product_url} target="_blank" rel="noreferrer">Buy ↗</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Nothing approved and waiting to be bought.</Empty>}

        {picked.size > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-asu-gold bg-helios-strip px-4 py-2">
            <b className="text-asu-gold">{picked.size} bought together</b>
            <input className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" placeholder="Vendor order #" value={order.id} onChange={(e) => setOrder({ ...order, id: e.target.value })} />
            <input className="w-40 rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" placeholder="Paid with" value={order.payment} onChange={(e) => setOrder({ ...order, payment: e.target.value })} />
            <input className="w-28 rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" placeholder="Order total $" value={order.total} onChange={(e) => setOrder({ ...order, total: e.target.value })} />
            <input type="date" className="rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" value={order.on} onChange={(e) => setOrder({ ...order, on: e.target.value })} />
            <input className="w-44 rounded-md border border-helios-line bg-helios-panel px-2 py-1 text-sm" placeholder="Member who paid (if any)" value={order.paidBy} onChange={(e) => setOrder({ ...order, paidBy: e.target.value })} />
            <Button disabled={!order.id} onClick={() => void run(`${picked.size} item(s) marked ordered`, async () => {
              await recordOrder(client, [...picked], order.id, order.payment, order.on || null, parseCents(order.total), order.paidBy);
              setPicked(new Set());
            })}>Mark ordered</Button>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-helios-dim">On the way ({groups.size} orders)</h2>
        {groups.size ? [...groups.entries()].map(([key, group]) => {
          const first = group[0];
          if (!first) return null;
          const t = tracking[key] ?? { number: "", carrier: "", eta: "" };
          const ids = group.map((g) => g.id);
          const link = trackingUrl(first.carrier, first.tracking_number);
          return (
            <Card key={key} className="mb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <b>{first.vendor ?? "Vendor?"}</b> <span className="font-mono text-xs text-helios-dim">{key}</span>
                  <div className="text-xs text-helios-dim">Ordered {first.ordered_at ?? "?"} · {group.length} item(s) · {fmtCents(group.reduce((s, i) => s + itemCost(i), 0))}</div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill status={first.status} />
                  {first.tracking_number && (link
                    ? <a className="text-xs text-asu-gold hover:underline" href={link} target="_blank" rel="noreferrer">{first.carrier} {first.tracking_number} ↗</a>
                    : <span className="text-xs">{first.carrier} {first.tracking_number}</span>)}
                  {first.est_delivery && <span className="text-xs text-helios-info">ETA {first.est_delivery}</span>}
                </div>
              </div>
              <div className="my-2 flex flex-wrap gap-1">
                {group.map((i) => <span key={i.id} className="rounded-full border border-helios-line px-2 py-0.5 text-xs">{i.code} {i.title.slice(0, 40)}</span>)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input className="min-w-[220px] flex-1 rounded-md border border-helios-line bg-helios-strip px-2 py-1 text-sm"
                  placeholder={first.tracking_number ? "Replace tracking number" : "Paste tracking number"} value={t.number}
                  onChange={(e) => setTracking((m) => ({ ...m, [key]: { ...t, number: e.target.value, carrier: detectCarrier(e.target.value) || t.carrier } }))} />
                <select className="rounded-md border border-helios-line bg-helios-strip px-2 py-1 text-sm" value={t.carrier}
                  onChange={(e) => setTracking((m) => ({ ...m, [key]: { ...t, carrier: e.target.value } }))}>
                  <option value="">Carrier</option>{["UPS", "FedEx", "USPS", "DHL", "Amazon", "Other"].map((c) => <option key={c}>{c}</option>)}
                </select>
                <input type="date" title="Estimated delivery" className="rounded-md border border-helios-line bg-helios-strip px-2 py-1 text-sm" value={t.eta}
                  onChange={(e) => setTracking((m) => ({ ...m, [key]: { ...t, eta: e.target.value } }))} />
                <Button disabled={!t.number} onClick={() => void run("Tracking added. The requester and the delivery person were told.", async () => {
                  await addTracking(client, ids, t.number, t.carrier, t.eta || null);
                  const url = trackingUrl(t.carrier, t.number);
                  setMessage(`Shipped: ${group.map((g) => `${g.code} ${g.title}`).join(", ")}. ${t.carrier || "Tracking"} ${t.number}${url ? ` ${url}` : ""}${t.eta ? ` (ETA ${t.eta})` : ""}`);
                })}>Add tracking</Button>
                <Button kind="ghost" onClick={() => void run("Marked delivered. The delivery person was told.", () => setStatus(client, ids, "DELIVERED"))}>Delivered</Button>
                <Button kind="ghost" onClick={() => void run("Marked received.", () => setStatus(client, ids, "RECEIVED"))}>Received</Button>
              </div>
            </Card>
          );
        }) : <Empty>Nothing on the way.</Empty>}
      </section>
    </div>
  );
}
