import { describe, it, expect } from "vitest";

import { buildDesignReportHtml, type DesignReportInput } from "../../lib/export/designReport";
import {
  SDM26_VEHICLE,
  REFERENCE_2026,
  AUTOCROSS_2026_VISUAL,
  ENDURANCE_2026_VISUAL,
  computeEvents,
  simAccel,
  skidpad,
  tractiveMap,
  peakTorque,
  type TorqueCurve,
} from "../../lib/performance";

const CURVE: TorqueCurve = [
  { rpm: 6000, torqueNm: 55 },
  { rpm: 8000, torqueNm: 62 },
  { rpm: 10000, torqueNm: 58 },
  { rpm: 12000, torqueNm: 48 },
  { rpm: 14000, torqueNm: 30 },
];

function input(over: Partial<DesignReportInput> = {}): DesignReportInput {
  return {
    configName: "sdm26",
    generatedAt: "2026-06-09T15:00:00.000Z",
    vehicle: SDM26_VEHICLE,
    events: computeEvents(CURVE, SDM26_VEHICLE, REFERENCE_2026),
    accel: simAccel(CURVE, SDM26_VEHICLE),
    skid: skidpad(SDM26_VEHICLE, 4.9),
    tractive: tractiveMap(CURVE, SDM26_VEHICLE),
    peak: peakTorque(CURVE),
    autocross: AUTOCROSS_2026_VISUAL,
    endurance: ENDURANCE_2026_VISUAL,
    ...over,
  };
}

describe("buildDesignReportHtml", () => {
  it("produces a self-contained HTML doc (no external assets)", () => {
    const html = buildDesignReportHtml(input());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
    // Inline only — no remote src/href that would break a portable file.
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toMatch(/<link /);
  });

  it("includes the headline sections + the generated date", () => {
    const html = buildDesignReportHtml(input());
    expect(html).toContain("FSAE Design Review");
    expect(html).toContain("Vehicle");
    expect(html).toContain("FSAE Events");
    expect(html).toContain("Tractive Effort");
    expect(html).toContain("2026-06-09"); // date from generatedAt
    expect(html).toContain("Autocross 2026");
    expect(html).toContain("Endurance 2026");
  });

  it("embeds inline SVG for the tractive chart and both track plans", () => {
    const html = buildDesignReportHtml(input());
    const svgs = html.match(/<svg /g) ?? [];
    expect(svgs.length).toBeGreaterThanOrEqual(3); // tractive + 2 tracks
    expect(html).not.toContain("NaN");
  });

  it("degrades gracefully when there's no torque curve", () => {
    const html = buildDesignReportHtml(input({ events: null, accel: null, tractive: null, peak: null }));
    expect(html).toContain("No torque curve");
    expect(html).not.toContain("NaN");
    // Track plans still render (they don't need a curve).
    expect((html.match(/<svg /g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("escapes the config name into the title", () => {
    const html = buildDesignReportHtml(input({ configName: "a<b>&c" }));
    expect(html).toContain("a&lt;b&gt;&amp;c");
    expect(html).not.toContain("a<b>&c");
  });
});
