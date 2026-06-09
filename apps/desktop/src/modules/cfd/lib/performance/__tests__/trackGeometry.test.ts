import { describe, it, expect } from "vitest";

import {
  trackPlan,
  tightnessOf,
  TIGHTNESS_COLOR,
  boundsOf,
  visualCurvatureRadii,
  parseVisualTrack,
} from "../trackGeometry";
import { parseTrack, trackLength, type Track } from "../track";
import { AUTOCROSS_2026, ENDURANCE_2026 } from "../tracks2026";
import { AUTOCROSS_2026_VISUAL, ENDURANCE_2026_VISUAL } from "../tracksVisual2026";

const straightTrack: Track = parseTrack({
  name: "straight",
  closed: false,
  segments: [{ length: 100, radius: null }],
});

describe("trackPlan", () => {
  it("walks a single straight along the x-axis (no heading change)", () => {
    const plan = trackPlan(straightTrack, 10);
    expect(plan.points.length).toBeGreaterThan(2);
    const last = plan.points[plan.points.length - 1]!;
    expect(last.x).toBeCloseTo(100, 6); // 100 m straight → x ≈ 100
    expect(last.y).toBeCloseTo(0, 6); // stays on axis
    expect(last.cum).toBeCloseTo(100, 6);
  });

  it("cumulative distance of the last point ≈ track length", () => {
    for (const t of [AUTOCROSS_2026, ENDURANCE_2026]) {
      const plan = trackPlan(t);
      const last = plan.points[plan.points.length - 1]!;
      expect(last.cum).toBeCloseTo(trackLength(t), 0); // within ~1 m
    }
  });

  it("produces finite coordinates and a non-degenerate bbox on the real courses", () => {
    const plan = trackPlan(AUTOCROSS_2026);
    for (const p of plan.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(plan.bbox.maxX - plan.bbox.minX).toBeGreaterThan(1);
    expect(plan.bbox.maxY - plan.bbox.minY).toBeGreaterThan(0); // corners bend it off-axis
  });

  it("carries the closed flag and per-point radius", () => {
    expect(trackPlan(ENDURANCE_2026).closed).toBe(true);
    expect(trackPlan(AUTOCROSS_2026).closed).toBe(false);
    const p = trackPlan(straightTrack, 50).points[1]!;
    expect(p.radius).toBe(Infinity); // straight
  });

  it("the steering heuristic keeps the shape compact (no runaway spiral)", () => {
    // Bbox diagonal should be on the order of the track length, not many×.
    const plan = trackPlan(AUTOCROSS_2026);
    const diag = Math.hypot(plan.bbox.maxX - plan.bbox.minX, plan.bbox.maxY - plan.bbox.minY);
    expect(diag).toBeLessThan(trackLength(AUTOCROSS_2026));
  });
});

describe("visual tracks (real traced layout)", () => {
  it("parse the vendored 2026 visual tracks with matching edge/centerline counts", () => {
    for (const t of [AUTOCROSS_2026_VISUAL, ENDURANCE_2026_VISUAL]) {
      expect(t.centerline.length).toBeGreaterThan(100);
      expect(t.leftEdge.length).toBe(t.centerline.length);
      expect(t.rightEdge.length).toBe(t.centerline.length);
      expect(t.trackWidthM).toBeGreaterThan(0);
    }
    expect(AUTOCROSS_2026_VISUAL.closed).toBe(false);
    expect(ENDURANCE_2026_VISUAL.closed).toBe(true);
  });

  it("boundsOf brackets a point cloud", () => {
    const b = boundsOf([[0, 0], [10, -5], [3, 8]]);
    expect(b).toEqual({ minX: 0, minY: -5, maxX: 10, maxY: 8 });
  });

  it("visualCurvatureRadii: straight line → Infinity, circle → ~radius", () => {
    const straight = visualCurvatureRadii([[0, 0], [1, 0], [2, 0], [3, 0]]);
    expect(straight.every((r) => r === Infinity)).toBe(true);

    // Points on a radius-10 circle → recovered radius ≈ 10.
    const R = 10;
    const circle = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * 2 * Math.PI;
      return [R * Math.cos(a), R * Math.sin(a)] as const;
    });
    const radii = visualCurvatureRadii(circle);
    // Interior points (endpoints copy neighbors) should be close to R.
    for (let i = 1; i < radii.length - 1; i++) expect(radii[i]!).toBeCloseTo(R, 1);
  });

  it("parseVisualTrack maps snake_case + defaults width", () => {
    const t = parseVisualTrack({ name: "T", closed: true, centerline: [[0, 0]], left_edge: [[0, 1]], right_edge: [[0, -1]] });
    expect(t.trackWidthM).toBe(3.5);
    expect(t.name).toBe("T");
  });

  it("real layouts produce sensible curvature (some corners, some straights)", () => {
    const radii = visualCurvatureRadii(AUTOCROSS_2026_VISUAL.centerline);
    expect(radii.some((r) => r === Infinity || r > 100)).toBe(true); // straights
    expect(radii.some((r) => Number.isFinite(r) && r < 20)).toBe(true); // corners
  });
});

describe("tightnessOf", () => {
  it("buckets radius into straight/open/medium/tight/hairpin", () => {
    expect(tightnessOf(Infinity)).toBe("straight");
    expect(tightnessOf(40)).toBe("open");
    expect(tightnessOf(18)).toBe("medium");
    expect(tightnessOf(10)).toBe("tight");
    expect(tightnessOf(5)).toBe("hairpin");
  });

  it("has a color for every bucket", () => {
    for (const t of ["straight", "open", "medium", "tight", "hairpin"] as const) {
      expect(TIGHTNESS_COLOR[t]).toMatch(/^#/);
    }
  });
});
