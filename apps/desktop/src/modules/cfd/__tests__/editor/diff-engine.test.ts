import { describe, it, expect } from "vitest";
import { diffConfigs, groupDiff } from "../../editor/diff/diff-engine";

const a = (): Record<string, unknown> => ({
  name: "A",
  n_cylinders: 4,
  cylinder: { bore: 0.067, stroke: 0.0425, compression_ratio: 12.2 },
  intake_pipes: [{ name: "ir1", length: 0.245, diameter: 0.038, diameter_out: null, n_points: 30, wall_temperature: 325, roughness: 3e-5 }],
});

describe("diffConfigs", () => {
  it("flags identical fields as same", () => {
    const d = diffConfigs(a(), a());
    expect(d.every((e) => e.kind === "same")).toBe(true);
  });

  it("identifies a changed scalar", () => {
    const right = { ...a(), cylinder: { ...((a().cylinder) as object), bore: 0.070 } };
    const d = diffConfigs(a(), right);
    const bore = d.find((e) => e.key === "cylinder.bore");
    expect(bore?.kind).toBe("changed");
    expect(bore?.raw.left).toBe(0.067);
    expect(bore?.raw.right).toBe(0.070);
  });

  it("flags a missing-in-right scalar as removed", () => {
    const right = { ...a(), cylinder: { stroke: 0.0425, compression_ratio: 12.2 } };
    const d = diffConfigs(a(), right);
    const bore = d.find((e) => e.key === "cylinder.bore");
    expect(bore?.kind).toBe("removed");
  });

  it("flags an added-in-right scalar as added", () => {
    const left = { ...a(), cylinder: { stroke: 0.0425, compression_ratio: 12.2 } };
    const d = diffConfigs(left, a());
    const bore = d.find((e) => e.key === "cylinder.bore");
    expect(bore?.kind).toBe("added");
  });

  it("descends into pipe arrays per-row", () => {
    const right = {
      ...a(),
      intake_pipes: [{ name: "ir1", length: 0.300, diameter: 0.038, diameter_out: null, n_points: 30, wall_temperature: 325, roughness: 3e-5 }],
    };
    const d = diffConfigs(a(), right);
    const len = d.find((e) => e.key === "intake_pipes[1].length");
    expect(len?.kind).toBe("changed");
  });

  it("flags differing pipe-array length", () => {
    const right = {
      ...a(),
      intake_pipes: [
        { name: "ir1", length: 0.245, diameter: 0.038, diameter_out: null, n_points: 30, wall_temperature: 325, roughness: 3e-5 },
        { name: "ir2", length: 0.245, diameter: 0.038, diameter_out: null, n_points: 30, wall_temperature: 325, roughness: 3e-5 },
      ],
    };
    const d = diffConfigs(a(), right);
    const lengthRow = d.find((e) => e.key === "intake_pipes.length");
    expect(lengthRow?.kind).toBe("changed");
  });
});

describe("groupDiff", () => {
  it("groups entries by group field in schema order", () => {
    const grouped = groupDiff(diffConfigs(a(), a()));
    // First group should be Engine (matches SDM26_GROUPS[0]).
    expect(grouped[0]?.group).toBe("Engine");
  });
});
