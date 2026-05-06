import { describe, it, expect } from "vitest";
import { migrateConfig } from "../../src/xy-plot/migrations";

describe("migrateConfig", () => {
  it("rewrites a legacy v1 config into v2 with a single scatter overlay", () => {
    const legacy = {
      xChannelId: "throttle",
      yChannelId: "rpm",
      xMin: 0, xMax: 100, yMin: 0, yMax: 14000,
      color: "#26A69A",
      trail: true,
    };
    const v2 = migrateConfig(legacy as never);
    expect(v2.version).toBe(2);
    expect(v2.mode).toBe("simple");
    expect(v2.xChannelId).toBe("throttle");
    expect(v2.yChannelId).toBe("rpm");
    expect(v2.xMin).toBe(0); expect(v2.yMax).toBe(14000);
    expect(v2.overlays).toEqual([{
      id: "migrated-scatter",
      kind: "scatter",
      config: { color: "#26A69A", pointSize: 2, alpha: 1, trail: true },
    }]);
  });

  it("is a no-op on an already-v2 config", () => {
    const v2 = {
      version: 2 as const, mode: "advanced" as const,
      xChannelId: "a", yChannelId: "b",
      overlays: [{ id: "x", kind: "scatter" as const,
        config: { color: "#fff", pointSize: 3, alpha: 1, trail: false } }],
    };
    expect(migrateConfig(v2)).toBe(v2);
  });

  it("supplies sane defaults when legacy fields are missing", () => {
    const sparse = { xChannelId: "a", yChannelId: "b" };
    const v2 = migrateConfig(sparse as never);
    expect(v2.overlays[0]!.kind).toBe("scatter");
    const sc = v2.overlays[0]!.config as { color: string; pointSize: number; alpha: number; trail: boolean };
    expect(sc.color).toBe("#FFC627");
    expect(sc.pointSize).toBe(2);
    expect(sc.alpha).toBe(1);
    expect(sc.trail).toBe(false);
  });
});
