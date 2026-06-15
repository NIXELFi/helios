import { describe, it, expect, beforeEach } from "vitest";
import {
  recordBreadcrumb,
  getBreadcrumbs,
  clearBreadcrumbs,
  recordLastError,
  getLastError,
  MAX_BREADCRUMBS,
} from "../breadcrumbs";

describe("breadcrumbs", () => {
  beforeEach(() => clearBreadcrumbs());

  it("records in order, newest last", () => {
    recordBreadcrumb("nav", "a");
    recordBreadcrumb("action", "b");
    const b = getBreadcrumbs();
    expect(b.map((e) => e.message)).toEqual(["a", "b"]);
    expect(b[0]!.category).toBe("nav");
    expect(typeof b[0]!.t).toBe("string");
  });

  it("caps at MAX_BREADCRUMBS, dropping oldest", () => {
    for (let i = 0; i < MAX_BREADCRUMBS + 10; i++) recordBreadcrumb("action", `m${i}`);
    const b = getBreadcrumbs();
    expect(b.length).toBe(MAX_BREADCRUMBS);
    expect(b[0]!.message).toBe("m10");
    expect(b[b.length - 1]!.message).toBe(`m${MAX_BREADCRUMBS + 9}`);
  });

  it("never throws on unserializable data", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => recordBreadcrumb("error", "boom", circular)).not.toThrow();
    expect(getBreadcrumbs().length).toBe(1);
  });

  it("truncates long messages", () => {
    recordBreadcrumb("action", "x".repeat(1000));
    expect(getBreadcrumbs()[0]!.message.length).toBe(300);
  });

  it("recordLastError stores the latest structured error", () => {
    recordLastError({ label: "CFD", message: "x", componentStack: "..." });
    expect(getLastError()?.label).toBe("CFD");
    recordLastError({ message: "y" });
    expect(getLastError()?.message).toBe("y");
    expect(getLastError()?.label).toBeUndefined();
  });

  it("clearBreadcrumbs resets buffer and last error", () => {
    recordBreadcrumb("nav", "a");
    recordLastError({ message: "e" });
    clearBreadcrumbs();
    expect(getBreadcrumbs()).toEqual([]);
    expect(getLastError()).toBeNull();
  });
});
