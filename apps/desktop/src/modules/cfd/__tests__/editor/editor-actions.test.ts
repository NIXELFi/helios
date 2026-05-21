import { describe, it, expect } from "vitest";
import {
  editorReducer,
  initialEditorState,
  isDirty,
  hasFieldErrors,
  canSave,
} from "../../editor/state/editor-actions";
import { getAt } from "../../editor/lib/path-helpers";

const sdm26Like = (): Record<string, unknown> => ({
  name: "Test engine",
  n_cylinders: 4,
  firing_order: [1, 2, 4, 3],
  firing_interval: 180,
  cylinder: {
    bore: 0.067, stroke: 0.0425, con_rod_length: 0.0963,
    compression_ratio: 12.2, n_intake_valves: 2, n_exhaust_valves: 2,
  },
  combustion: {
    wiebe_a: 5.0, wiebe_m: 2.0, combustion_duration: 50,
    spark_advance: 25, ignition_delay: 7, combustion_efficiency: 0.96,
    q_lhv: 44e6, afr_stoich: 14.7, afr_target: 13.1,
  },
  restrictor: { throat_diameter: 0.020, discharge_coefficient: 0.95 },
  plenum: { volume: 0.0015, initial_pressure: 101325, initial_temperature: 300 },
  intake_pipes: [{ name: "ir1", length: 0.245, diameter: 0.038, diameter_out: null, n_points: 30, wall_temperature: 325, roughness: 3e-5 }],
  exhaust_primaries: [{ name: "p1", length: 0.308, diameter: 0.032, diameter_out: null, n_points: 30, wall_temperature: 650, roughness: 4.6e-5 }],
  exhaust_secondaries: [],
  exhaust_collector: { length: 0.1, diameter: 0.05, diameter_out: null, n_points: 20, wall_temperature: 500, roughness: 4.6e-5 },
  p_ambient: 101325, T_ambient: 300, drivetrain_efficiency: 0.85,
});

describe("editorReducer", () => {
  it("loadFromConfig sets draft + snapshot, isDirty=false", () => {
    const s = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    expect(isDirty(s)).toBe(false);
    expect(s.savedPath).toBe("x.json");
    expect(s.isExample).toBe(false);
  });

  it("setField updates draft immutably and recomputes field errors", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const next = editorReducer(loaded, { type: "setField", path: "cylinder.bore", value: 0.07 });
    expect(getAt(next.draft, "cylinder.bore")).toBe(0.07);
    expect(getAt(loaded.draft, "cylinder.bore")).toBe(0.067); // original untouched
    expect(isDirty(next)).toBe(true);
    expect(hasFieldErrors(next)).toBe(false);
  });

  it("setField below min populates fieldErrors", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const next = editorReducer(loaded, { type: "setField", path: "cylinder.bore", value: 0.001 });
    expect(next.fieldErrors["cylinder.bore"]).toMatch(/below minimum/);
    expect(canSave(next)).toBe(false);
  });

  it("setField clearing an error removes it from fieldErrors", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const bad = editorReducer(loaded, { type: "setField", path: "cylinder.bore", value: 0.001 });
    const fixed = editorReducer(bad, { type: "setField", path: "cylinder.bore", value: 0.070 });
    expect(fixed.fieldErrors["cylinder.bore"]).toBeUndefined();
  });

  it("loadTemplate sets savedSnapshot={} so the editor is dirty from start", () => {
    const s = editorReducer(initialEditorState, {
      type: "loadTemplate", raw: sdm26Like(),
    });
    expect(isDirty(s)).toBe(true);
    expect(s.savedPath).toBeNull();
    expect(s.isExample).toBe(false);
  });

  it("addPipeRow appends a defaulted intake row", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const next = editorReducer(loaded, { type: "addPipeRow", pipesKey: "intake_pipes" });
    const pipes = next.draft.intake_pipes as Array<Record<string, unknown>>;
    expect(pipes).toHaveLength(2);
    expect(pipes[1]?.diameter).toBe(0.038);
  });

  it("removePipeRow removes the given index", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const added = editorReducer(loaded, { type: "addPipeRow", pipesKey: "intake_pipes" });
    const removed = editorReducer(added, { type: "removePipeRow", pipesKey: "intake_pipes", index: 0 });
    expect((removed.draft.intake_pipes as unknown[])).toHaveLength(1);
  });

  it("duplicatePipeRow inserts a copy with name suffixed '(copy)'", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const dup = editorReducer(loaded, { type: "duplicatePipeRow", pipesKey: "intake_pipes", index: 0 });
    const pipes = dup.draft.intake_pipes as Array<Record<string, unknown>>;
    expect(pipes).toHaveLength(2);
    expect(pipes[0]?.name).toBe("ir1");
    expect(pipes[1]?.name).toBe("ir1 (copy)");
  });

  it("changeTopology to 4-2-1 adds two defaulted secondaries", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const next = editorReducer(loaded, { type: "changeTopology", topology: "4-2-1" });
    expect((next.draft.exhaust_secondaries as unknown[])).toHaveLength(2);
  });

  it("changeTopology to 4-1 empties exhaust_secondaries", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: { ...sdm26Like(), exhaust_secondaries: [{ x: 1 }, { x: 2 }] }, isExample: false,
    });
    const next = editorReducer(loaded, { type: "changeTopology", topology: "4-1" });
    expect((next.draft.exhaust_secondaries as unknown[])).toHaveLength(0);
  });

  it("changeTopology no-op when already at target", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const next = editorReducer(loaded, { type: "changeTopology", topology: "4-1" });
    expect(next).toBe(loaded);
  });

  it("saveSucceeded snapshots draft + sets path + clears errors", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const edited = editorReducer(loaded, { type: "setField", path: "cylinder.bore", value: 0.07 });
    const errored = editorReducer(edited, { type: "setGlobalError", message: "Schema error: ..." });
    const saved = editorReducer(errored, { type: "saveSucceeded", path: "y.json", isExample: false });
    expect(saved.savedPath).toBe("y.json");
    expect(isDirty(saved)).toBe(false);
    expect(saved.globalError).toBeNull();
  });

  it("discardChanges reverts draft to savedSnapshot", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const edited = editorReducer(loaded, { type: "setField", path: "cylinder.bore", value: 0.10 });
    const reverted = editorReducer(edited, { type: "discardChanges" });
    expect(isDirty(reverted)).toBe(false);
    expect(getAt(reverted.draft, "cylinder.bore")).toBe(0.067);
  });

  it("setCdTable writes to <valve>.cd_table", () => {
    const loaded = editorReducer(initialEditorState, {
      type: "loadFromConfig", path: "x.json", raw: sdm26Like(), isExample: false,
    });
    const next = editorReducer(loaded, {
      type: "setCdTable", valveKey: "intake_valve",
      table: [[0.05, 0.2], [0.1, 0.4], [0.15, 0.55]],
    });
    expect(getAt(next.draft, "intake_valve.cd_table")).toEqual([[0.05, 0.2], [0.1, 0.4], [0.15, 0.55]]);
  });
});
