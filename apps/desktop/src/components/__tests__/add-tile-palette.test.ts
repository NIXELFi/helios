import { describe, it, expect } from "vitest";
import { BUILTIN_WIDGET_TYPES } from "@helios/widgets";
import { PALETTE } from "../AddTileModal";

describe("AddTileModal PALETTE", () => {
  it("covers every registered widget type", () => {
    // lap_delta and sector_table once shipped registered-but-unaddable
    // because the palette drifted from the registry; this pins the two lists
    // together.
    const paletteTypes = new Set<string>(PALETTE.map((e) => e.type));
    const missing = BUILTIN_WIDGET_TYPES.filter((t) => !paletteTypes.has(t));
    expect(missing).toEqual([]);
  });

  it("lists only registered widget types, with no duplicates", () => {
    const registered = new Set(BUILTIN_WIDGET_TYPES);
    const unknown = PALETTE.filter((e) => !registered.has(e.type)).map((e) => e.type);
    expect(unknown).toEqual([]);
    expect(new Set(PALETTE.map((e) => e.type)).size).toBe(PALETTE.length);
  });

  it("pairs every entry with the widget of its declared type", () => {
    for (const entry of PALETTE) {
      expect(entry.widget.type).toBe(entry.type);
    }
  });
});
