import { describe, expect, it } from "vitest";
import { allocate, extrasOf, parseOrderText, splitOrder } from "../orderText";

// Made-up orders, laid out the way the vendors' pages and emails come out.
const AMAZON = `Order Summary
Order placed March 3, 2026   Order # 111-0000000-0000001
Item(s) Subtotal: $50.00
Shipping & Handling: $4.99
Free Shipping: -$4.99
Total before tax: $50.00
Estimated tax to be collected: $4.05
Grand Total: $54.05`;

const MOUSER = `Web Order #: 12345678
Order Date: 04/10/2026
Merchandise Total
$120.00
Freight
$8.50
Tariff Charge
$3.10
Sales Tax
$9.72
Invoice Total
$141.32`;

describe("parseOrderText", () => {
  it("reads an Amazon order page, with free shipping cancelling the shipping", () => {
    const o = parseOrderText(AMAZON, ["Amazon", "Mouser"]);
    expect(o).toMatchObject({ orderId: "111-0000000-0000001", date: "2026-03-03", subtotal: 5000, shipping: 0, tax: 405, total: 5405 });
    expect(extrasOf(o)).toBe(405);
  });

  it("takes an amount from the next line when the label stands alone", () => {
    const o = parseOrderText(MOUSER, ["Amazon", "Mouser"]);
    expect(o).toMatchObject({ orderId: "12345678", date: "2026-04-10", subtotal: 12000, shipping: 850, fees: 310, tax: 972, total: 14132 });
    expect(o.vendor).toBeNull();   // the text never names the vendor
  });

  it("works out the total from the parts when the page has no total", () => {
    const o = parseOrderText("Subtotal $20.00\nShipping $5.00\nTax $2.00", []);
    expect(o.total).toBe(2700);
  });

  it("finds nothing in text that isn't an order", () => {
    const o = parseOrderText("Hi team, see you at the shop", []);
    expect([o.subtotal, o.total, o.tax, o.shipping]).toEqual([null, null, null, null]);
  });
});

describe("allocate", () => {
  it("splits by weight and adds up to the cent", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1001, [200, 100])).toEqual([667, 334]);
    expect(allocate(-10, [1, 2])).toEqual([-3, -7]);
    expect(allocate(9, [0, 0, 0])).toEqual([3, 3, 3]);
  });
});

describe("splitOrder", () => {
  const order = { orderId: "A1", date: null, vendor: null, subtotal: 10000, shipping: 1000, tax: 810, fees: null, discount: null, total: 11810 };
  it("spreads shipping and tax over the whole cart by price", () => {
    const s = splitOrder([{ id: "a", price: 7500 }, { id: "b", price: 2500 }], order, "whole");
    expect(s).toEqual([{ id: "a", price: 7500, extra: 1358, total: 8858 }, { id: "b", price: 2500, extra: 452, total: 2952 }]);
    expect(s.reduce((t, x) => t + x.total, 0)).toBe(11810);
  });
  it("keeps the charged total when prices changed since the estimate", () => {
    const s = splitOrder([{ id: "a", price: 6000 }, { id: "b", price: 3000 }], order, "whole");
    expect(s.reduce((t, x) => t + x.total, 0)).toBe(11810);
  });
  it("gives parts only their fraction when the order had other things in it", () => {
    const s = splitOrder([{ id: "a", price: 2500 }], order, "share");
    expect(s).toEqual([{ id: "a", price: 2500, extra: 453, total: 2953 }]);
  });

  it("a dash between the label and the amount isn't a minus sign", () => {
    const o = parseOrderText("Subtotal - $20.00\nShipping - $5.00\nTax - $1.62\nTotal - $26.62", []);
    expect(o).toMatchObject({ subtotal: 2000, shipping: 500, tax: 162, total: 2662 });
  });
});
