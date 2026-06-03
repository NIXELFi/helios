// View nav helpers. When inside a /team/[slug]/* route, the view nav stays
// inside that subteam. When at the project root, the view nav points to global
// /[view] routes.

export const VIEW_SEGMENTS = ["table", "board", "calendar", "gantt", "graph", "pages", "activity"] as const;
export type ViewSegment = (typeof VIEW_SEGMENTS)[number];

// --- Workspaces -------------------------------------------------------------
// The PDM is organized into three connected workspaces for the same project:
// Design (all the PM views), Build (manufacturing workflow), and Compete
// (scaffolded placeholder for now).

export const WORKSPACES = ["design", "build", "compete"] as const;
export type Workspace = (typeof WORKSPACES)[number];

export const WORKSPACE_LABELS: Record<Workspace, string> = {
  design: "Design",
  build: "Build",
  compete: "Compete",
};

export const BUILD_SEGMENTS = ["desk", "vendors", "calendar", "gantt"] as const;
export type BuildSegment = (typeof BUILD_SEGMENTS)[number];

export const BUILD_LABELS: Record<BuildSegment, string> = {
  desk: "The desk",
  vendors: "Vendors",
  calendar: "Calendar",
  gantt: "Gantt",
};

export function activeWorkspace(pathname: string): Workspace {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "build") return "build";
  if (parts[0] === "compete") return "compete";
  return "design";
}

export function activeBuildSegment(pathname: string): BuildSegment | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "build") return null;
  const candidate = parts[1];
  if (candidate && (BUILD_SEGMENTS as readonly string[]).includes(candidate)) {
    return candidate as BuildSegment;
  }
  return null;
}

// Home href for each workspace. Design reopens the project's last-used view
// (falling back to the table); Build opens the desk; Compete its placeholder.
export function workspaceHomeHref(ws: Workspace): string {
  if (ws === "build") return "/build/desk";
  if (ws === "compete") return "/compete";
  return `/${recallScopeView(null) ?? "table"}`;
}

export function activeTeamSlug(pathname: string): string | null {
  if (!pathname.startsWith("/team/")) return null;
  const parts = pathname.split("/").filter(Boolean);
  return parts[1] ?? null;
}

export function activeViewSegment(pathname: string): ViewSegment | null {
  const parts = pathname.split("/").filter(Boolean);
  // global: /[view]/...
  // team: /team/[slug]/[view]/...
  const candidate = parts[0] === "team" ? parts[2] : parts[0];
  if (candidate && (VIEW_SEGMENTS as readonly string[]).includes(candidate)) {
    return candidate as ViewSegment;
  }
  return null;
}

export function viewHref(view: ViewSegment, teamSlug: string | null): string {
  return teamSlug ? `/team/${teamSlug}/${view}` : `/${view}`;
}

export function teamHomeHref(teamSlug: string): string {
  return `/team/${teamSlug}/table`;
}

// --- Per-scope last-view memory --------------------------------------------
// Remembers which view was last open for each scope (the project, or a given
// subteam) so that switching scopes reopens that scope's last-used view rather
// than carrying the current view across.

const PROJECT_SCOPE_KEY = "__project__";

export function scopeKey(teamSlug: string | null): string {
  return teamSlug ?? PROJECT_SCOPE_KEY;
}

function storageKey(teamSlug: string | null): string {
  return `helios:lastView:${scopeKey(teamSlug)}`;
}

export function rememberScopeView(teamSlug: string | null, view: ViewSegment): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(teamSlug), view);
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

export function recallScopeView(teamSlug: string | null): ViewSegment | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(storageKey(teamSlug));
    if (v && (VIEW_SEGMENTS as readonly string[]).includes(v)) {
      return v as ViewSegment;
    }
  } catch {
    // ignore
  }
  return null;
}

// --- View nav ordering ------------------------------------------------------
// Lets each user drag-reorder the Views nav. VIEW_SEGMENTS stays the canonical
// source of valid views (and of the ViewSegment type); the saved order is only
// a presentation preference layered on top of it.

export const DEFAULT_VIEW_ORDER: readonly ViewSegment[] = VIEW_SEGMENTS;

const VIEW_ORDER_KEY = "helios:viewOrder";

export function rememberViewOrder(order: readonly ViewSegment[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_ORDER_KEY, JSON.stringify(order));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

export function recallViewOrder(): ViewSegment[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(VIEW_ORDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (v): v is ViewSegment =>
        typeof v === "string" && (VIEW_SEGMENTS as readonly string[]).includes(v),
    );
  } catch {
    // ignore (malformed JSON, storage failures)
  }
  return null;
}

// The order to render the Views nav in: the saved order (filtered to currently
// valid views, with duplicates removed), then any VIEW_SEGMENTS not present so
// newly added views still show up — at the end.
export function resolveViewOrder(): ViewSegment[] {
  const saved = recallViewOrder() ?? [];
  const seen = new Set<ViewSegment>();
  const order: ViewSegment[] = [];
  for (const v of saved) {
    if (!seen.has(v)) {
      seen.add(v);
      order.push(v);
    }
  }
  for (const v of VIEW_SEGMENTS) {
    if (!seen.has(v)) {
      seen.add(v);
      order.push(v);
    }
  }
  return order;
}
