import { describe, expect, it } from "vitest";
import { NO_FILTER, filterApprovals, isFiltered } from "../approvalFilter";
import type { Item } from "../api";

const item = (p: Partial<Item> & Pick<Item, "code">): Item => ({
  id: p.code, title: "Part", status: "READY", priority: "Medium", requester_id: null, requester_name: "Ana", justification: "", needed_by: null,
  vendor: "Mouser", product_url: "", part_number: "", quantity: 1, unit_price_cents: null, tax_shipping_cents: null, total_estimate_cents: 1000,
  notes: "", ready_at: null, vendor_order_id: null, actual_total_cents: null, payment_method: "", ordered_at: null, carrier: "", tracking_number: "",
  est_delivery: null, created_at: "", item_allocations: [{ project_id: "ic", subteam_id: "daq", percent: 100 }], ...p,
});
const w = (i: Item, hours: number, voted = false) => ({ i, hours, voted });

const adc = w(item({ code: "SDM-0003", title: "8 channel ADC", priority: "HIGH", total_estimate_cents: 7200 }), 30 * 24);
const imu = w(item({ code: "SDM-0012", title: "IMU IC", vendor: "Newark", requester_name: "Ben" }), 5, true);
const rotor = w(item({ code: "SDM-0020", title: "Rotor", item_allocations: [{ project_id: "ev", subteam_id: "brakes", percent: 100 }], total_estimate_cents: 25000 }), 80);

describe("approval filters", () => {
  it("keeps the usual order with no filters: not voted yet, then priority, then waiting longest", () => {
    expect(filterApprovals([imu, rotor, adc], NO_FILTER).map((x) => x.i.code)).toEqual(["SDM-0003", "SDM-0020", "SDM-0012"]);
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ ...NO_FILTER, sort: "biggest" })).toBe(false);
  });

  it("filters by search, car, subteam, vendor, who asked, waiting time and my vote", () => {
    const all = [adc, imu, rotor];
    const codes = (f: Partial<typeof NO_FILTER>) => filterApprovals(all, { ...NO_FILTER, ...f }).map((x) => x.i.code);
    expect(codes({ q: "imu" })).toEqual(["SDM-0012"]);
    expect(codes({ car: "ev" })).toEqual(["SDM-0020"]);
    expect(codes({ subteam: "daq" })).toEqual(["SDM-0003", "SDM-0012"]);
    expect(codes({ vendor: "Newark" })).toEqual(["SDM-0012"]);
    expect(codes({ requester: "Ana", priority: "Medium" })).toEqual(["SDM-0020"]);
    expect(codes({ waiting: "3d" })).toEqual(["SDM-0003", "SDM-0020"]);
    expect(codes({ waiting: "14d" })).toEqual(["SDM-0003"]);
    expect(codes({ vote: "todo" })).toEqual(["SDM-0003", "SDM-0020"]);
    expect(codes({ vote: "voted" })).toEqual(["SDM-0012"]);
  });

  it("sorts by cost or age when asked", () => {
    expect(filterApprovals([adc, imu, rotor], { ...NO_FILTER, sort: "biggest" }).map((x) => x.i.code)).toEqual(["SDM-0020", "SDM-0003", "SDM-0012"]);
    expect(filterApprovals([adc, imu, rotor], { ...NO_FILTER, sort: "newest" }).map((x) => x.i.code)).toEqual(["SDM-0012", "SDM-0020", "SDM-0003"]);
  });
});
