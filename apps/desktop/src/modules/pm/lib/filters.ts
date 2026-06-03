import type { ReadonlyURLSearchParams } from "@pm/lib/router";
import type { TaskRow, TaskStatus, TaskType } from "@helios/pm-ui";

export type FilterShowMode = "dim" | "hide";

// The task types that represent physical fabrication work. The Build workspace's
// calendar and gantt are scoped to these.
export const MANUFACTURING_TYPES: ReadonlyArray<TaskType> = ["part", "assembly", "drawing"];

export function isManufacturingType(t: TaskType): boolean {
  return MANUFACTURING_TYPES.includes(t);
}

export interface TaskFilters {
  status: ReadonlyArray<TaskStatus>;
  subteamIds: ReadonlyArray<string>;
  types: ReadonlyArray<TaskType>;
  ownerIds: ReadonlyArray<string>;
  dueFrom: string | null;
  dueTo: string | null;
  search: string;
  // What to do with rows that don't match subteam/type filters.
  // "dim" keeps them visible but faded; "hide" removes them.
  showMode: FilterShowMode;
}

export interface TaskSort {
  key: "title" | "subsystem" | "owner" | "status" | "priority" | "due_date";
  dir: "asc" | "desc";
}

export const EMPTY_FILTERS: TaskFilters = {
  status: [],
  subteamIds: [],
  types: [],
  ownerIds: [],
  dueFrom: null,
  dueTo: null,
  search: "",
  showMode: "dim",
};

export function parseFilters(sp: ReadonlyURLSearchParams): TaskFilters {
  const list = (key: string) => sp.get(key)?.split(",").filter(Boolean) ?? [];
  return {
    status: list("status") as TaskStatus[],
    subteamIds: list("team"),
    types: list("type") as TaskType[],
    ownerIds: list("owner"),
    dueFrom: sp.get("from"),
    dueTo: sp.get("to"),
    search: sp.get("q") ?? "",
    showMode: sp.get("mode") === "hide" ? "hide" : "dim",
  };
}

export function parseSort(sp: ReadonlyURLSearchParams): TaskSort {
  const key = (sp.get("sort") as TaskSort["key"]) || "due_date";
  const dir = sp.get("dir") === "desc" ? "desc" : "asc";
  return { key, dir };
}

export function filtersToParams(filters: TaskFilters, sort: TaskSort): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status.length > 0) params.set("status", filters.status.join(","));
  if (filters.subteamIds.length > 0) params.set("team", filters.subteamIds.join(","));
  if (filters.types.length > 0) params.set("type", filters.types.join(","));
  if (filters.ownerIds.length > 0) params.set("owner", filters.ownerIds.join(","));
  if (filters.dueFrom) params.set("from", filters.dueFrom);
  if (filters.dueTo) params.set("to", filters.dueTo);
  if (filters.search) params.set("q", filters.search);
  if (filters.showMode !== "dim") params.set("mode", filters.showMode);
  if (sort.key !== "due_date") params.set("sort", sort.key);
  if (sort.dir !== "asc") params.set("dir", sort.dir);
  return params;
}

// Filters that don't depend on the dim/hide toggle (always applied)
export function applyHardFilters(tasks: ReadonlyArray<TaskRow>, filters: TaskFilters): TaskRow[] {
  return tasks.filter((t) => {
    if (filters.status.length > 0 && !filters.status.includes(t.status)) return false;
    if (filters.ownerIds.length > 0) {
      if (filters.ownerIds.includes("__unassigned__")) {
        if (t.owner_id !== null && !filters.ownerIds.includes(t.owner_id)) return false;
      } else if (!t.owner_id || !filters.ownerIds.includes(t.owner_id)) {
        return false;
      }
    }
    if (filters.dueFrom && (!t.due_date || t.due_date < filters.dueFrom)) return false;
    if (filters.dueTo && (!t.due_date || t.due_date > filters.dueTo)) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      if (!t.title.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

// Returns whether a task matches the dim/hide-controlled filters (subteam + type).
// If no such filters are active, returns true for everything.
export function taskMatchesScopeFilters(task: TaskRow, filters: TaskFilters): boolean {
  const teamMatch = filters.subteamIds.length === 0 || filters.subteamIds.includes(task.subteam_id);
  const typeMatch = filters.types.length === 0 || filters.types.includes(task.type);
  return teamMatch && typeMatch;
}

export function hasScopeFilters(filters: TaskFilters): boolean {
  return filters.subteamIds.length > 0 || filters.types.length > 0;
}

// Compatibility: the old applyFilters API merged everything. Keep a wrapper
// that combines hard filters with hide-mode scope filtering.
export function applyFilters(tasks: ReadonlyArray<TaskRow>, filters: TaskFilters): TaskRow[] {
  const hard = applyHardFilters(tasks, filters);
  if (filters.showMode === "hide" && hasScopeFilters(filters)) {
    return hard.filter((t) => taskMatchesScopeFilters(t, filters));
  }
  return hard;
}

export function applySort(tasks: ReadonlyArray<TaskRow>, sort: TaskSort): TaskRow[] {
  const priorityRank: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  const statusRank: Record<string, number> = {
    not_started: 0,
    in_progress: 1,
    needs_review: 2,
    blocked: 3,
    done: 4,
  };
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  const dir = sort.dir === "asc" ? 1 : -1;

  const get = (t: TaskRow): string | number => {
    switch (sort.key) {
      case "title": return t.title;
      case "subsystem": return t.subteam.name;
      case "owner": return t.owner?.name ?? "";
      case "status": return statusRank[t.status] ?? 0;
      case "priority": return priorityRank[t.priority] ?? 0;
      case "due_date": return t.due_date ?? "9999-12-31";
    }
  };

  return [...tasks].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (typeof av === "number" && typeof bv === "number") return dir * (av - bv);
    return dir * collator.compare(String(av), String(bv));
  });
}
