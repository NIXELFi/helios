import { describe, it, expect } from "vitest";
import { absoluteWhen, relativeWhen, whoLabel } from "../../src/modules/vault/lib/when";

const NOW = new Date("2026-10-28T15:00:00").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("relativeWhen", () => {
  it("buckets recent times", () => {
    expect(relativeWhen(ago(10_000), NOW)).toBe("just now");
    expect(relativeWhen(ago(5 * 60_000), NOW)).toBe("5m ago");
    expect(relativeWhen(ago(3 * 3_600_000), NOW)).toBe("3h ago");
    expect(relativeWhen(ago(26 * 3_600_000), NOW)).toBe("yesterday");
    expect(relativeWhen(ago(4 * 86_400_000), NOW)).toBe("4d ago");
  });
  it("reads clock-skewed future stamps as just now", () => {
    expect(relativeWhen(ago(-5_000), NOW)).toBe("just now");
  });
  it("falls back to a date (with year only when it differs)", () => {
    expect(relativeWhen(ago(20 * 86_400_000), NOW)).not.toMatch(/2026/);
    expect(relativeWhen("2025-03-04T12:00:00", NOW)).toMatch(/2025/);
  });
  it("returns empty for garbage", () => {
    expect(relativeWhen("nope", NOW)).toBe("");
  });
});

describe("absoluteWhen", () => {
  it("is never the raw ISO string", () => {
    const iso = "2026-03-01T18:03:11.123Z";
    expect(absoluteWhen(iso)).not.toBe(iso);
    expect(absoluteWhen(iso)).toMatch(/2026/);
  });
});

describe("whoLabel", () => {
  const names = new Map([["u1", "Alice"]]);
  it("resolves names, 'You', and never a raw id", () => {
    expect(whoLabel("u1", names)).toBe("Alice");
    expect(whoLabel("u1", names, "u1")).toBe("You");
    expect(whoLabel("u-missing", names)).toBe("Unknown member");
    expect(whoLabel(null, names)).toBe("Unknown");
  });
});
