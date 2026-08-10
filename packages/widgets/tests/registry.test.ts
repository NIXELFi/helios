import { describe, it, expect } from "vitest";
import { widgetRegistry } from "../src/registry";
import type { Widget } from "../src/types";

const dummy = (type: string): Widget<{}> => ({
  type,
  label: type,
  defaultConfig: {},
  ConfigEditor: () => null,
  Render: () => null,
  requiredChannels: () => [],
});

describe("widgetRegistry", () => {
  it("registers and retrieves a widget", () => {
    widgetRegistry.register(dummy("test.alpha"));
    expect(widgetRegistry.get("test.alpha").type).toBe("test.alpha");
    expect(widgetRegistry.has("test.alpha")).toBe(true);
  });

  it("duplicate registration throws", () => {
    widgetRegistry.register(dummy("test.beta"));
    expect(() => widgetRegistry.register(dummy("test.beta"))).toThrow(/already registered/);
  });

  it("unknown type throws on get", () => {
    expect(() => widgetRegistry.get("nope")).toThrow(/unknown widget type/);
  });
});
