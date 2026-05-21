import { describe, it, expect } from "vitest";
import {
  validateField,
  validateAll,
  validateFiringOrder,
  checkCdMonotonic,
} from "../../editor/validation/client-rules";
import type { FieldMeta } from "../../lib/sdm26Schema";

const bore: FieldMeta = {
  key: "cylinder.bore",
  label: "Bore",
  group: "Engine",
  type: "number",
  min: 0.020,
  max: 0.150,
  required: true,
  unit: "mm",
  format: (v) => (typeof v === "number" ? (v * 1000).toFixed(1) : ""),
};

const cylInt: FieldMeta = {
  key: "n_cylinders",
  label: "Cylinders",
  group: "Engine",
  type: "integer",
  min: 1,
  max: 16,
  required: true,
};

describe("validateField", () => {
  it("accepts an in-range number", () => {
    expect(validateField(bore, 0.067)).toEqual({ ok: true });
  });
  it("rejects below min with display-unit message", () => {
    const r = validateField(bore, 0.01);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/below minimum.*20\.0 mm/);
  });
  it("rejects above max", () => {
    const r = validateField(bore, 0.2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/above maximum/);
  });
  it("rejects NaN", () => {
    expect(validateField(bore, NaN).ok).toBe(false);
  });
  it("rejects empty for required fields", () => {
    expect(validateField(bore, null).ok).toBe(false);
    expect(validateField(bore, "").ok).toBe(false);
  });
  it("allows empty for non-required fields", () => {
    const opt: FieldMeta = { ...bore, required: false };
    expect(validateField(opt, null)).toEqual({ ok: true });
  });
  it("integer rejects fractional", () => {
    expect(validateField(cylInt, 4)).toEqual({ ok: true });
    expect(validateField(cylInt, 4.5).ok).toBe(false);
  });
  it("select must be one of options", () => {
    const sel: FieldMeta = {
      key: "topology",
      label: "Topology",
      group: "G",
      type: "select",
      options: [{ value: "4-1", label: "4-1" }, { value: "4-2-1", label: "4-2-1" }],
    };
    expect(validateField(sel, "4-1")).toEqual({ ok: true });
    expect(validateField(sel, "8-1").ok).toBe(false);
  });
});

describe("validateAll", () => {
  it("returns errors keyed by dot-path", () => {
    const metas: FieldMeta[] = [bore, cylInt];
    const errs = validateAll(metas, { cylinder: { bore: 0.01 }, n_cylinders: 4 });
    expect(errs["cylinder.bore"]).toMatch(/below minimum/);
    expect(errs["n_cylinders"]).toBeUndefined();
  });
  it("skips synthetic __keys", () => {
    const metas: FieldMeta[] = [
      { key: "__topology", label: "T", group: "G", type: "select", options: [{ value: "x", label: "X" }] },
    ];
    expect(validateAll(metas, {})).toEqual({});
  });
});

describe("validateFiringOrder", () => {
  it("accepts a valid permutation", () => {
    expect(validateFiringOrder([1, 2, 4, 3], 4)).toEqual({ ok: true });
  });
  it("rejects wrong length", () => {
    expect(validateFiringOrder([1, 2, 3], 4).ok).toBe(false);
  });
  it("rejects out-of-range entries", () => {
    expect(validateFiringOrder([1, 2, 5, 3], 4).ok).toBe(false);
  });
  it("rejects duplicates", () => {
    expect(validateFiringOrder([1, 2, 2, 3], 4).ok).toBe(false);
  });
  it("rejects non-integers", () => {
    expect(validateFiringOrder([1, 2.5, 4, 3], 4).ok).toBe(false);
  });
});

describe("checkCdMonotonic", () => {
  it("passes a monotonic increasing curve", () => {
    expect(checkCdMonotonic([[0.05, 0.19], [0.1, 0.38], [0.15, 0.494]])).toBeNull();
  });
  it("warns when not sorted by L/D", () => {
    expect(checkCdMonotonic([[0.1, 0.2], [0.05, 0.4]])).not.toBeNull();
  });
  it("warns on a sharp dip in Cd", () => {
    expect(checkCdMonotonic([[0.05, 0.3], [0.1, 0.2]])).not.toBeNull();
  });
  it("allows tiny non-monotonic noise (≤ 0.05)", () => {
    expect(checkCdMonotonic([[0.05, 0.35], [0.1, 0.32]])).toBeNull();
  });
});
