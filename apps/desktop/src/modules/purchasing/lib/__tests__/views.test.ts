import { describe, expect, it } from "vitest";
import { BUILTIN_VIEWS, applyView, describeView, inView, missingInfo } from "../views";
import type { Item, Subteam } from "../api";

let n = 0;
function item(p: Partial<Item>): Item {
  n++;
  return {
    id: `i${n}`, code: `SDM-${String(n).padStart(4, "0")}`, title: `Part ${n}`, status: "PLANNED", priority: "Medium",
    requester_id: "lead", requester_name: "Demo Lead", justification: "", needed_by: null, vendor: "Mouser", product_url: "https://x.test",
    part_number: "", quantity: 1, unit_price_cents: 100, tax_shipping_cents: null, total_estimate_cents: 100, notes: "", ready_at: null,
    vendor_order_id: null, actual_total_cents: null, payment_method: "", ordered_at: null, carrier: "", tracking_number: "", est_delivery: null,
    created_at: `2026-09-${String(n).padStart(2, "0")}`, item_allocations: [{ project_id: "car", subteam_id: "daq", percent: 100 }], ...p,
  } as Item;
}
const subteams: Subteam[] = [
  { id: "aero", name: "Aero", code: "AERO", color: null, sort_order: 1 },
  { id: "daq", name: "Data AQ", code: "DAQ", color: null, sort_order: 4 },
];
const ctx = { userId: "lead", subteams, today: "2026-10-02" };

describe("Abacus views", () => {
  const a = item({ status: "READY", priority: "HIGH", unit_price_cents: 5000, total_estimate_cents: 5000 });
  const b = item({ status: "PLANNED", vendor: null, requester_id: "other", requester_name: "Someone" });
  const c = item({ status: "ORDERED", needed_by: "2026-09-30", item_allocations: [{ project_id: "car", subteam_id: "aero", percent: 100 }] });
  const d = item({ status: "PLANNED", priority: "Low", needed_by: "2026-10-05", unit_price_cents: null, total_estimate_cents: null });
  const all = [a, b, c, d];

  it("groups by status in pipeline order, with counts and totals", () => {
    const { groups, rows } = applyView(all, { groupBy: "status" }, ctx);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([["Not ready to order", 2], ["Ready to order", 1], ["Ordered", 1]]);
    expect(groups[1]!.total_cents).toBe(5000);
    expect(rows.map((r) => r.id)).toEqual([b.id, d.id, a.id, c.id]);
  });

  it("a collapsed group keeps its count but its rows aren't on screen", () => {
    const { groups, rows } = applyView(all, { groupBy: "status" }, { ...ctx, collapsed: new Set(["status:Not ready to order"]) });
    expect(groups[0]!.items).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([a.id, c.id]);
  });

  it("filters: ready to order, mine, missing info", () => {
    const ready = BUILTIN_VIEWS.find((v) => v.id === "builtin:ready")!.config;
    expect(all.filter((i) => inView(i, ready, "lead"))).toEqual([a]);
    expect(all.filter((i) => inView(i, { mine: true }, "lead")).map((i) => i.id)).toEqual([a.id, c.id, d.id]);
    expect(all.filter((i) => inView(i, { mine: true }, null))).toEqual([]);
    expect(missingInfo(b)).toEqual(["vendor"]);
    expect(missingInfo(d)).toEqual(["price"]);
    expect(applyView(all, BUILTIN_VIEWS.find((v) => v.id === "builtin:missing")!.config, ctx).rows).toEqual([b, d]);
  });

  it("groups by subteam in the org's order and by needed-by bucket", () => {
    expect(applyView(all, { groupBy: "subteam" }, ctx).groups.map((g) => g.label)).toEqual(["Aero", "Data AQ"]);
    expect(applyView(all, { groupBy: "needed_by" }, ctx).groups.map((g) => g.label)).toEqual(["Overdue", "This week", "No date"]);
    expect(applyView(all, { groupBy: "vendor" }, ctx).groups.map((g) => g.label)).toEqual(["Mouser", "No vendor"]);
  });

  it("sorts within the view, keeping sheet order for ties", () => {
    expect(applyView(all, { sortBy: "priority" }, ctx).rows.map((r) => r.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(applyView(all, { sortBy: "total" }, ctx).rows[0]).toBe(a);
    expect(applyView(all, { sortBy: "needed_by" }, ctx).rows.slice(0, 2)).toEqual([c, d]);
  });

  it("describes itself", () => {
    expect(describeView({})).toBe("Every part");
    expect(describeView({ statuses: ["READY"], groupBy: "vendor", hidden: ["notes"] })).toBe("Ready to order; grouped by vendor; 1 column hidden");
  });
});
