import { afterEach, describe, expect, test } from "vitest";
import {
  WIDGET_KIND_META,
  activeTab,
  addTab,
  addWidget,
  adoptSharedTabs,
  defaultDashboardConfig,
  deleteTab,
  kindAvailable,
  makeWidget,
  moveWidget,
  normalizeSharedTabs,
  recallDashboardConfig,
  rememberDashboardConfig,
  removeWidget,
  renameTab,
  setActiveTab,
  sharedDashboardPayload,
  updateWidget,
} from "../dashboardSettings";

afterEach(() => {
  window.localStorage.clear();
});

describe("scope-aware defaults", () => {
  test("all-subteams: Overview + Team Productivity + Workflow Health", () => {
    const cfg = defaultDashboardConfig(false);
    expect(cfg.version).toBe(2);
    expect(cfg.tabs.map((t) => t.name)).toEqual(["Overview", "Team Productivity", "Workflow Health"]);
    expect(cfg.activeTabId).toBe(cfg.tabs[0]!.id);
    const kinds = cfg.tabs.flatMap((t) => t.widgets.map((w) => w.kind));
    expect(kinds).toContain("subteam_table"); // all-teams only
    expect(kinds).not.toContain("cross"); // subteam only
  });

  test("subteam: Overview + Subteam Productivity + Dependencies & Risk", () => {
    const cfg = defaultDashboardConfig(true);
    expect(cfg.tabs.map((t) => t.name)).toEqual([
      "Overview",
      "Subteam Productivity",
      "Dependencies & Risk",
    ]);
    const kinds = cfg.tabs.flatMap((t) => t.widgets.map((w) => w.kind));
    expect(kinds).toContain("cross");
    expect(kinds).not.toContain("subteam_table");
  });
});

describe("kindAvailable", () => {
  test("cross only in subteam scope, subteam_table only at root", () => {
    expect(kindAvailable("cross", true)).toBe(true);
    expect(kindAvailable("cross", false)).toBe(false);
    expect(kindAvailable("subteam_table", false)).toBe(true);
    expect(kindAvailable("subteam_table", true)).toBe(false);
    expect(kindAvailable("breakdown", false)).toBe(true);
    expect(kindAvailable("breakdown", true)).toBe(true);
  });
});

describe("persistence", () => {
  test("roundtrip preserves tabs and active id", () => {
    const cfg = addTab(defaultDashboardConfig(false), "Custom");
    rememberDashboardConfig(null, cfg);
    const back = recallDashboardConfig(null, false);
    expect(back.tabs.map((t) => t.name)).toEqual([...cfg.tabs.map((t) => t.name)]);
    expect(back.activeTabId).toBe(cfg.activeTabId);
  });

  test("scopes isolated", () => {
    rememberDashboardConfig("aero", addTab(defaultDashboardConfig(true), "X"));
    rememberDashboardConfig(null, defaultDashboardConfig(false));
    expect(recallDashboardConfig("aero", true).tabs).toHaveLength(4);
    expect(recallDashboardConfig(null, false).tabs).toHaveLength(3);
  });

  test("version gate: legacy shape discarded for defaults", () => {
    window.localStorage.setItem(
      "helios:dashboard:__project__",
      JSON.stringify({ version: 1, views: [{ id: "v", name: "Old", widgets: [] }] }),
    );
    const cfg = recallDashboardConfig(null, false);
    expect(cfg.version).toBe(2);
    expect(cfg.tabs[0]!.name).toBe("Overview");
  });

  test("malformed JSON falls back to defaults", () => {
    window.localStorage.setItem("helios:dashboard:__project__", "{nope");
    expect(recallDashboardConfig(null, false).tabs[0]!.name).toBe("Overview");
  });
});

describe("widget normalization", () => {
  test("drops unknown-kind and re-derives valid fields", () => {
    const stored = {
      version: 2,
      activeTabId: "tabX",
      tabs: [
        {
          id: "tabX",
          name: "T",
          widgets: [
            { id: "w1", kind: "bogus" }, // dropped
            { id: "w2", kind: "breakdown", groupBy: "owner", chart: "bar", set: "open", size: "lg", windowDays: 9999 },
            { id: "w3", kind: "metric", metric: "not_a_metric" }, // metric falls back to default
          ],
        },
      ],
    };
    window.localStorage.setItem("helios:dashboard:__project__", JSON.stringify(stored));
    const t = activeTab(recallDashboardConfig(null, false));
    expect(t.widgets.map((w) => w.id)).toEqual(["w2", "w3"]);
    const w2 = t.widgets[0]!;
    expect(w2.kind).toBe("breakdown");
    if (w2.kind === "breakdown") {
      expect(w2.groupBy).toBe("owner");
      expect(w2.chart).toBe("bar");
      expect(w2.windowDays).toBe(90); // clamped to max
    }
    const w3 = t.widgets[1]!;
    if (w3.kind === "metric") expect(w3.metric).toBe("completion"); // invalid → default
  });
});

describe("tab CRUD", () => {
  test("addTab appends empty + activates", () => {
    const cfg = addTab(defaultDashboardConfig(false), "New");
    expect(cfg.tabs).toHaveLength(4);
    expect(activeTab(cfg).name).toBe("New");
    expect(activeTab(cfg).widgets).toHaveLength(0);
  });

  test("deleteTab keeps at least one", () => {
    let cfg = defaultDashboardConfig(false);
    cfg = deleteTab(cfg, cfg.tabs[1]!.id);
    cfg = deleteTab(cfg, cfg.tabs[0]!.id);
    expect(cfg.tabs).toHaveLength(1);
    const only = cfg.tabs[0]!.id;
    expect(deleteTab(cfg, only)).toBe(cfg); // refuses last
  });

  test("renameTab trims, empty → Untitled", () => {
    const cfg = defaultDashboardConfig(false);
    const id = cfg.tabs[0]!.id;
    expect(renameTab(cfg, id, "  Plan  ").tabs[0]!.name).toBe("Plan");
    expect(renameTab(cfg, id, "   ").tabs[0]!.name).toBe("Untitled");
  });

  test("setActiveTab ignores unknown id", () => {
    const cfg = defaultDashboardConfig(false);
    expect(setActiveTab(cfg, "nope")).toBe(cfg);
    const second = cfg.tabs[1]!.id;
    expect(setActiveTab(cfg, second).activeTabId).toBe(second);
  });
});

describe("widget CRUD on active tab", () => {
  test("add / update / remove", () => {
    let cfg = addTab(defaultDashboardConfig(false), "Blank");
    cfg = addWidget(cfg, "metric");
    const w = activeTab(cfg).widgets[0]!;
    expect(w.kind).toBe("metric");

    cfg = updateWidget(cfg, w.id, (x) => (x.kind === "metric" ? { ...x, metric: "wip" } : x));
    const updated = activeTab(cfg).widgets[0]!;
    if (updated.kind === "metric") expect(updated.metric).toBe("wip");

    cfg = removeWidget(cfg, w.id);
    expect(activeTab(cfg).widgets).toHaveLength(0);
  });

  test("moveWidget swaps and no-ops at edges", () => {
    let cfg = addTab(defaultDashboardConfig(false), "Blank");
    cfg = addWidget(cfg, "metric");
    cfg = addWidget(cfg, "deadlines");
    const [a, b] = activeTab(cfg).widgets;
    cfg = moveWidget(cfg, a!.id, 1);
    expect(activeTab(cfg).widgets.map((w) => w.id)).toEqual([b!.id, a!.id]);
    const before = cfg;
    cfg = moveWidget(cfg, b!.id, -1); // b now at front → no-op
    expect(cfg).toBe(before);
  });
});

describe("makeWidget", () => {
  test("every kind produces a unique-id widget of that kind", () => {
    const kinds = Object.keys(WIDGET_KIND_META) as Array<keyof typeof WIDGET_KIND_META>;
    const ids = new Set<string>();
    for (const k of kinds) {
      const w = makeWidget(k);
      expect(w.kind).toBe(k);
      ids.add(w.id);
    }
    expect(ids.size).toBe(kinds.length);
  });
});

describe("shared (server) payload", () => {
  test("sharedDashboardPayload carries tabs but not activeTabId", () => {
    const cfg = addTab(defaultDashboardConfig(false), "Extra");
    const payload = sharedDashboardPayload(cfg);
    expect(payload.version).toBe(2);
    expect(payload.tabs).toBe(cfg.tabs);
    expect("activeTabId" in payload).toBe(false);
  });

  test("normalizeSharedTabs roundtrips a payload through JSON", () => {
    const cfg = addTab(defaultDashboardConfig(true), "Pit Wall");
    const raw = JSON.parse(JSON.stringify(sharedDashboardPayload(cfg))) as unknown;
    const tabs = normalizeSharedTabs(raw);
    expect(tabs).not.toBeNull();
    expect(tabs!.map((t) => t.name)).toEqual(cfg.tabs.map((t) => t.name));
  });

  test("normalizeSharedTabs rejects foreign versions, non-objects, and empty tabs", () => {
    expect(normalizeSharedTabs(null)).toBeNull();
    expect(normalizeSharedTabs("x")).toBeNull();
    expect(normalizeSharedTabs({ version: 1, tabs: [] })).toBeNull();
    expect(normalizeSharedTabs({ version: 2, tabs: [] })).toBeNull();
    expect(normalizeSharedTabs({ version: 2, tabs: "nope" })).toBeNull();
  });

  test("normalizeSharedTabs drops invalid widgets but keeps the tab", () => {
    const tabs = normalizeSharedTabs({
      version: 2,
      tabs: [{ id: "t1", name: "T", widgets: [{ id: "w1", kind: "bogus" }, { id: "w2", kind: "metric" }] }],
    });
    expect(tabs).toHaveLength(1);
    expect(tabs![0]!.widgets.map((w) => w.id)).toEqual(["w2"]);
  });

  test("adoptSharedTabs keeps the active tab when it survives, else falls to first", () => {
    const cfg = defaultDashboardConfig(false);
    const shared = [cfg.tabs[1]!, cfg.tabs[2]!];
    const kept = adoptSharedTabs(setActiveTab(cfg, cfg.tabs[1]!.id), shared);
    expect(kept.activeTabId).toBe(cfg.tabs[1]!.id);
    const fallen = adoptSharedTabs(setActiveTab(cfg, cfg.tabs[0]!.id), shared);
    expect(fallen.activeTabId).toBe(shared[0]!.id);
  });
});
