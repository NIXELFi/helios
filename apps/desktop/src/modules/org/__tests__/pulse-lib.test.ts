import { describe, expect, it } from "vitest";
import {
  deltaAbs,
  deltaPct,
  filterPeople,
  formatBytes,
  formatCount,
  lastDays,
  niceMax,
  presenceBucket,
  relativeTime,
  rolling7,
  shortDay,
  sortPeople,
  toHeatGrid,
  toPoints,
} from "../pulse/pulse-lib";
import type { OpsDay, OpsPerson } from "../pulse/types";

function day(iso: string, over: Partial<OpsDay> = {}): OpsDay {
  return {
    day: iso,
    users_total: 0,
    users_new: 0,
    active_users: 0,
    vault_actions: 0,
    pm_actions: 0,
    games_plays: 0,
    notify_sent: 0,
    notify_failed: 0,
    files_total: 0,
    versions_total: 0,
    content_bytes: 0,
    storage_bytes: null,
    db_bytes: null,
    vault_files: {},
    computed_at: "",
    ...over,
  };
}

function person(over: Partial<OpsPerson>): OpsPerson {
  return {
    user_id: over.user_id ?? Math.random().toString(36),
    email: null,
    display_name: null,
    subteam: null,
    role: null,
    created_at: "2026-06-01T00:00:00Z",
    last_sign_in_at: null,
    last_active: null,
    online: false,
    vault_actions_30d: 0,
    pm_actions_30d: 0,
    games_30d: 0,
    ...over,
  };
}

describe("shortDay / toPoints", () => {
  it("formats a UTC day string without timezone drift", () => {
    expect(shortDay("2026-09-14")).toBe("Sep 14");
    expect(shortDay("2026-01-01")).toBe("Jan 1");
  });
  it("maps a metric to points, coercing strings", () => {
    const pts = toPoints([day("2026-09-13", { users_total: "10" as unknown as number }), day("2026-09-14", { users_total: 12 })], "users_total");
    expect(pts.map((p) => p.value)).toEqual([10, 12]);
    expect(pts[1]!.label).toBe("Sep 14");
  });
});

describe("deltas", () => {
  const pts = toPoints([day("a", { files_total: 100 }), day("b", { files_total: 130 })], "files_total");
  it("computes absolute and percent change first -> last", () => {
    expect(deltaAbs(pts)).toBe(30);
    expect(deltaPct(pts)).toBeCloseTo(30);
  });
  it("returns null percent when the start is zero or the series is short", () => {
    expect(deltaPct(toPoints([day("a"), day("b", { files_total: 5 })], "files_total"))).toBeNull();
    expect(deltaPct(pts.slice(0, 1))).toBeNull();
  });
});

describe("rolling7", () => {
  it("averages a trailing window that shrinks at the start", () => {
    const pts = toPoints(
      [1, 2, 3, 4, 5, 6, 7, 8].map((v, i) => day(`2026-09-0${i + 1}`, { active_users: v })),
      "active_users",
    );
    const r = rolling7(pts).map((p) => p.value);
    expect(r[0]).toBe(1);
    expect(r[1]).toBe(1.5);
    expect(r[6]).toBe(4); // mean 1..7
    expect(r[7]).toBe(5); // mean 2..8
  });
});

describe("lastDays", () => {
  it("clips to the trailing n rows and never throws on a short list", () => {
    const rows = [1, 2, 3, 4, 5];
    expect(lastDays(rows, 2)).toEqual([4, 5]);
    expect(lastDays(rows, 10)).toEqual(rows);
  });
});

describe("formatters", () => {
  it("formats bytes with sensible precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(23_807_465_172)).toBe("22.2 GB");
    expect(formatBytes(-5)).toBe("0 B");
  });
  it("abbreviates large counts", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(15315)).toBe("15.3k");
  });
  it("renders relative time buckets", () => {
    const now = Date.parse("2026-09-15T00:00:00Z");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("2026-09-14T23:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-09-14T23:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-09-14T12:00:00Z", now)).toBe("12h ago");
    expect(relativeTime("2026-09-10T00:00:00Z", now)).toBe("5d ago");
    expect(relativeTime("2026-05-01T00:00:00Z", now)).toBe("5mo ago");
  });
  it("picks nice axis maxima", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(73)).toBe(100);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(2400)).toBe(2500);
  });
});

describe("people", () => {
  const now = Date.parse("2026-09-15T00:00:00Z");
  it("buckets presence by recency", () => {
    expect(presenceBucket(person({ online: true }), now)).toBe("online");
    expect(presenceBucket(person({ last_active: "2026-09-14T20:00:00Z" }), now)).toBe("today");
    expect(presenceBucket(person({ last_active: "2026-09-10T00:00:00Z" }), now)).toBe("week");
    expect(presenceBucket(person({ last_active: "2026-08-20T00:00:00Z" }), now)).toBe("month");
    expect(presenceBucket(person({ last_active: "2026-06-01T00:00:00Z" }), now)).toBe("idle");
    expect(presenceBucket(person({}), now)).toBe("never");
  });
  it("sorts online first, then by last active, nulls last", () => {
    const a = person({ user_id: "a", last_active: "2026-09-14T00:00:00Z" });
    const b = person({ user_id: "b", online: true, last_active: "2026-09-01T00:00:00Z" });
    const c = person({ user_id: "c" });
    const d = person({ user_id: "d", last_active: "2026-09-14T12:00:00Z" });
    expect(sortPeople([a, c, b, d]).map((p) => p.user_id)).toEqual(["b", "d", "a", "c"]);
  });
  it("filters across name, email, subteam, role", () => {
    const ps = [
      person({ user_id: "1", display_name: "Nick", subteam: "DAQ" }),
      person({ user_id: "2", email: "x@asu.edu", role: "editor" }),
    ];
    expect(filterPeople(ps, "daq").map((p) => p.user_id)).toEqual(["1"]);
    expect(filterPeople(ps, "EDIT").map((p) => p.user_id)).toEqual(["2"]);
    expect(filterPeople(ps, "")).toHaveLength(2);
  });
});

describe("toHeatGrid", () => {
  it("fills a 7x24 grid and shifts UTC hours into local time with day wrap", () => {
    // Monday 02:00 UTC with a UTC-7 viewer (offset +420) lands on Sunday 19:00.
    const g = toHeatGrid([{ source: "vault", dow: 0, hour: 2, n: 5 }], 420);
    expect(g[6]![19]).toBe(5);
    expect(g[0]![2]).toBe(0);
    // Sunday 22:00 UTC with a UTC+3 viewer (offset -180) wraps to Monday 01:00.
    const g2 = toHeatGrid([{ source: "pm", dow: 6, hour: 22, n: 2 }], -180);
    expect(g2[0]![1]).toBe(2);
  });
  it("drops sources the include filter rejects", () => {
    const g = toHeatGrid(
      [
        { source: "games", dow: 2, hour: 10, n: 400 },
        { source: "vault", dow: 2, hour: 10, n: 3 },
      ],
      0,
      (src) => src !== "games",
    );
    expect(g[2]![10]).toBe(3);
  });
});
