import { describe, expect, it, beforeEach } from "vitest";
import {
  serializeSnapshot,
  deserializeSnapshot,
  saveSnapshot,
  loadSnapshot,
  clearSnapshot,
  snapshotKey,
} from "../workspace-snapshot";
import type { Workspace } from "../data";

// Minimal Workspace — serialize/deserialize only require projects (array) +
// projectData (object); the rest round-trips opaquely.
function ws(over: Partial<Workspace> = {}): Workspace {
  return {
    projects: [{ id: "p1", name: "Proj", description: null, car_code: "C1" }],
    projectData: { p1: { foo: "bar" } },
    baselineOrg: { subteams: [], subsystems: [], users: [] },
    roles: { p1: "admin" },
    ...over,
  } as unknown as Workspace;
}

describe("serialize/deserialize snapshot", () => {
  it("round-trips a workspace for the same user", () => {
    const json = serializeSnapshot(ws(), "u1", "2026-06-06T00:00:00Z");
    expect(json).not.toBeNull();
    const out = deserializeSnapshot(json, "u1");
    expect(out).toEqual(ws());
  });

  it("returns null for a different user (no cross-account bleed)", () => {
    const json = serializeSnapshot(ws(), "u1", "2026-06-06T00:00:00Z");
    expect(deserializeSnapshot(json, "u2")).toBeNull();
  });

  it("returns null on a version mismatch", () => {
    const json = serializeSnapshot(ws(), "u1", "t")!;
    const bumped = JSON.parse(json);
    bumped.version = 999;
    expect(deserializeSnapshot(JSON.stringify(bumped), "u1")).toBeNull();
  });

  it("returns null on corrupt / non-object / null input", () => {
    expect(deserializeSnapshot("not json", "u1")).toBeNull();
    expect(deserializeSnapshot("123", "u1")).toBeNull();
    expect(deserializeSnapshot(null, "u1")).toBeNull();
  });

  it("returns null when required workspace fields are missing", () => {
    const json = serializeSnapshot(ws(), "u1", "t")!;
    const broken = JSON.parse(json);
    delete broken.workspace.projects;
    expect(deserializeSnapshot(JSON.stringify(broken), "u1")).toBeNull();
  });

  it("refuses to serialize an oversize snapshot (skips persistence, no throw)", () => {
    const huge = ws({ projectData: { p1: { blob: "x".repeat(3_100_000) } } as unknown as Workspace["projectData"] });
    expect(serializeSnapshot(huge, "u1", "t")).toBeNull();
  });
});

describe("localStorage wrappers", () => {
  beforeEach(() => localStorage.clear());

  it("save then load round-trips, namespaced by user", () => {
    saveSnapshot(ws(), "u1", "2026-06-06T00:00:00Z");
    expect(localStorage.getItem(snapshotKey("u1"))).not.toBeNull();
    expect(loadSnapshot("u1")).toEqual(ws());
    expect(loadSnapshot("u2")).toBeNull(); // different user → miss
  });

  it("clearSnapshot removes the user's snapshot", () => {
    saveSnapshot(ws(), "u1", "t");
    clearSnapshot("u1");
    expect(loadSnapshot("u1")).toBeNull();
  });

  it("loadSnapshot is null when nothing is stored", () => {
    expect(loadSnapshot("u1")).toBeNull();
  });
});
