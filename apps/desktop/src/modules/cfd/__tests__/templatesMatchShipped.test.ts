// Finding 0032: editor templates must carry the SAME calibrated `physics`
// block as the shipped example configs, otherwise a config started from a
// template silently runs different physics than the dyno-validated example.
import { describe, expect, it } from "vitest";
import tpl26 from "../editor/templates/sdm26.json";
import tpl25 from "../editor/templates/sdm25.json";
import ship26 from "../../../../src-tauri/resources/cfd/configs/sdm26.json";
import ship25 from "../../../../src-tauri/resources/cfd/configs/sdm25.json";

describe("CFD editor templates", () => {
  it("SDM26 template equals the shipped SDM26 config", () => {
    expect(tpl26).toEqual(ship26);
  });
  it("SDM25 template equals the shipped SDM25 config", () => {
    expect(tpl25).toEqual(ship25);
  });
  it("templates carry the full calibrated physics block", () => {
    const phys = (tpl26 as { physics?: Record<string, unknown> }).physics ?? {};
    for (const k of ["limiter", "cfl", "intake_lift_flat_top_ramp", "exhaust_collector_reflection_coef", "knock_tau_scale"]) {
      expect(phys).toHaveProperty(k);
    }
  });
});
