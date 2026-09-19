import { describe, it, expect } from "vitest";
import { dedupePresence } from "../useHeliosPresence";
import { MODULE_ICON } from "../ModulePicker";

describe("dedupePresence", () => {
  it("collapses multiple connections of one user into a single row", () => {
    const state = {
      conn1: [{ user_id: "u1", name: "Nick Murray", subteam: "Engine", module: "logs", online_at: 100 }],
      conn2: [{ user_id: "u1", name: "Nick Murray", subteam: "Engine", module: "pm", online_at: 200 }],
    };
    const out = dedupePresence(state as any);
    expect(out).toHaveLength(1);
    expect(out[0]!.userId).toBe("u1");
    expect(out[0]!.connections).toBe(2);
    // earliest connect time is kept as "online since"
    expect(out[0]!.since).toBe(100);
    // most-recent window's module wins
    expect(out[0]!.module).toBe("pm");
  });

  it("the NEWEST window's module wins regardless of iteration order", () => {
    // Regression for the recency bug: newest connection is iterated FIRST here,
    // so a naive "last meta wins" would return the older window's module.
    const state = {
      newest: [{ user_id: "u1", name: "Nick", module: "vault", online_at: 300 }],
      middle: [{ user_id: "u1", name: "Nick", module: "cfd", online_at: 200 }],
      oldest: [{ user_id: "u1", name: "Nick", module: "logs", online_at: 100 }],
    };
    const out = dedupePresence(state as any);
    expect(out[0]!.module).toBe("vault"); // online_at 300, the most recent
    expect(out[0]!.since).toBe(100); // earliest = online since
    expect(out[0]!.connections).toBe(3);
  });

  it("coerces an unrecognized module string to a known default", () => {
    const state = { c: [{ user_id: "u1", name: "Nick", module: "spaceship", online_at: 1 }] };
    const out = dedupePresence(state as any);
    expect(out[0]!.module).toBe("logs"); // never blank / unknown
  });

  it("returns one row per distinct user, sorted alphabetically by name", () => {
    const state = {
      a: [{ user_id: "u2", name: "Tim Coughlin", module: "vault", online_at: 1 }],
      b: [{ user_id: "u1", name: "Alex Berg", module: "cfd", online_at: 1 }],
    };
    const out = dedupePresence(state as any);
    expect(out.map((u) => u.name)).toEqual(["Alex Berg", "Tim Coughlin"]);
  });

  it("ignores malformed metas (no user_id) and defaults missing fields", () => {
    const state = {
      good: [{ user_id: "u1", name: "Nick", online_at: 5 }],
      bad: [{ name: "ghost" }, null as any],
    };
    const out = dedupePresence(state as any);
    expect(out).toHaveLength(1);
    expect(out[0]!.module).toBe("logs"); // default
    expect(out[0]!.subteam).toBeNull();
  });

  it("is empty for an empty presence state", () => {
    expect(dedupePresence({})).toEqual([]);
  });

  // Every module the rail can show must survive the round trip. This started
  // as a regression test for 'org' alone, which was missing from the known
  // list and so reported as "Logs" in everyone else's presence panel; 'sim'
  // and 'amethyst' were added later and went the same way. The list is now
  // derived from the rail's icon table, and this asserts over the whole table
  // so a tenth module cannot quietly repeat it.
  it.each(Object.keys(MODULE_ICON))("recognizes '%s' as a valid module", (module) => {
    const state = { c: [{ user_id: "u1", name: "Nick", module, online_at: 1 }] };
    const out = dedupePresence(state as any);
    expect(out[0]!.module).toBe(module);
  });
});
