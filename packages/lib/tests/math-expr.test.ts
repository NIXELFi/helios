import { describe, it, expect } from "vitest";
import { parseExpr, evalAst } from "../src/math-expr";

function evalStr(src: string, ctx: Record<string, number> = {}): number {
  const r = parseExpr(src);
  if (!r.ast) throw new Error(`parse failed: ${r.error}`);
  return evalAst(r.ast, (n) => ctx[n]);
}

describe("math-expr", () => {
  it("parses and evaluates basic arithmetic", () => {
    expect(evalStr("2 + 3")).toBe(5);
    expect(evalStr("2 + 3 * 4")).toBe(14);
    expect(evalStr("(2 + 3) * 4")).toBe(20);
    expect(evalStr("10 / 4")).toBe(2.5);
    expect(evalStr("10 % 3")).toBe(1);
  });

  it("right-associative power", () => {
    expect(evalStr("2 ^ 3")).toBe(8);
    expect(evalStr("2 ^ 3 ^ 2")).toBe(512); // 2^(3^2)
  });

  it("unary minus", () => {
    expect(evalStr("-5")).toBe(-5);
    expect(evalStr("-(2 + 3)")).toBe(-5);
    expect(evalStr("--5")).toBe(5);
  });

  it("constants", () => {
    expect(evalStr("pi")).toBeCloseTo(Math.PI);
    expect(evalStr("e")).toBeCloseTo(Math.E);
  });

  it("built-in functions", () => {
    expect(evalStr("abs(-3)")).toBe(3);
    expect(evalStr("sqrt(16)")).toBe(4);
    expect(evalStr("min(5, 2, 8, 3)")).toBe(2);
    expect(evalStr("max(5, 2, 8, 3)")).toBe(8);
    expect(evalStr("pow(2, 10)")).toBe(1024);
    expect(evalStr("round(2.7)")).toBe(3);
  });

  it("comparisons return 0 or 1", () => {
    expect(evalStr("3 < 5")).toBe(1);
    expect(evalStr("3 > 5")).toBe(0);
    expect(evalStr("3 == 3")).toBe(1);
    expect(evalStr("3 != 3")).toBe(0);
  });

  it("logical ops with short-circuit-like semantics", () => {
    expect(evalStr("1 && 1")).toBe(1);
    expect(evalStr("1 && 0")).toBe(0);
    expect(evalStr("0 || 5")).toBe(1);
    expect(evalStr("!1")).toBe(0);
    expect(evalStr("!0")).toBe(1);
  });

  it("ternary", () => {
    expect(evalStr("1 ? 10 : 20")).toBe(10);
    expect(evalStr("0 ? 10 : 20")).toBe(20);
    expect(evalStr("(3 > 2) ? 100 : 0")).toBe(100);
  });

  it("identifier lookup via resolver", () => {
    expect(evalStr("rpm * 2", { rpm: 1500 })).toBe(3000);
    expect(evalStr("engine.rpm + engine.tps", { "engine.rpm": 5000, "engine.tps": 50 })).toBe(5050);
  });

  it("bracketed identifiers can contain spaces", () => {
    expect(evalStr("[Engine Speed] * 2", { "Engine Speed": 1500 })).toBe(3000);
  });

  it("returns NaN when an identifier is unknown", () => {
    expect(Number.isNaN(evalStr("foo + 1"))).toBe(true);
  });

  it("collects refs", () => {
    const r = parseExpr("engine.rpm * imu.lat_g + pi");
    expect(r.refs.sort()).toEqual(["engine.rpm", "imu.lat_g"]);
  });

  it("reports parse errors", () => {
    const r = parseExpr("2 + ");
    expect(r.ast).toBeUndefined();
    expect(r.error).toMatch(/unexpected/i);
  });

  it("MoTeC-style power formula evaluates", () => {
    // Power (kW) = RPM * Torque (Nm) / 9549
    expect(evalStr("rpm * torque / 9549", { rpm: 6000, torque: 200 }))
      .toBeCloseTo(125.66, 1);
  });
});
