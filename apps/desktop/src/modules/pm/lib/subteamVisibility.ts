// Per-project subteam DISPLAY visibility for the PM sidebar nav list.
//
// This is a DISPLAY-ONLY concern: it controls which subteam shortcuts appear in
// the sidebar, NOT task assignment, membership, or permissions. A hidden
// subteam's tasks still exist and stay filterable in every view-level dropdown.
//
// Two layers combine:
//   1. Server-wide hides (`pm.project_hidden_subteams`) — a chief engineer / PM
//      owner hides a subteam for EVERYONE on a project by default. Fetched live
//      and passed in here as a Set of subteam ids.
//   2. Per-user overrides — each user may UNHIDE a server-hidden subteam for
//      themselves, or HIDE an extra one. These live only in localStorage (no
//      server schema), mirroring the existing PM pref pattern (subsystemSharing,
//      dashboardSettings). Shape: { hide: string[]; unhide: string[] }.
//
// A subteam with NO server-hide row is shown by default, so new subteams always
// appear until someone explicitly hides them.

import type { Subteam } from "@helios/pm-ui";

export interface SubteamVisibility {
  /** Subteam ids this user has explicitly hidden for themselves (on top of the
   *  server-wide hides). */
  hide: string[];
  /** Server-hidden subteam ids this user has chosen to reveal for themselves. */
  unhide: string[];
}

const EMPTY: SubteamVisibility = { hide: [], unhide: [] };

function storageKey(projectId: string): string {
  return `helios:pmSubteamVis:${projectId}`;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Read a project's per-user visibility prefs. Returns the empty default on a
 *  missing/corrupt entry, an empty projectId, or no `window` (SSR). Never throws. */
export function recallVisibility(projectId: string): SubteamVisibility {
  if (typeof window === "undefined" || !projectId) return { hide: [], unhide: [] };
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) return { hide: [], unhide: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { hide: [], unhide: [] };
    }
    const obj = parsed as Record<string, unknown>;
    return { hide: asStringArray(obj.hide), unhide: asStringArray(obj.unhide) };
  } catch {
    return { hide: [], unhide: [] };
  }
}

/** Persist a project's per-user visibility prefs (de-duped). Best-effort: silently
 *  ignores SSR, an empty projectId, and storage failures (quota / private mode). */
export function rememberVisibility(projectId: string, pref: SubteamVisibility): void {
  if (typeof window === "undefined" || !projectId) return;
  try {
    const tidy: SubteamVisibility = {
      hide: [...new Set(pref.hide)],
      unhide: [...new Set(pref.unhide)],
    };
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(tidy));
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

/**
 * The pure display selector for the sidebar nav list. Given the full subteam
 * list, the server-wide hidden id Set for the active project, and this user's
 * per-user prefs, return the subteams that should appear in the sidebar.
 *
 *   displayed = all
 *     - minus server-hidden (unless the user un-hid it)
 *     - minus user-hidden
 *
 * Order is preserved. An explicit user HIDE always wins (even over a same-id
 * unhide). DISPLAY-ONLY: callers must not use this to filter task data or any
 * view-level subteam dropdown — only the sidebar shortcut list.
 */
export function visibleSubteams(
  all: ReadonlyArray<Subteam>,
  serverHidden: ReadonlySet<string>,
  user: SubteamVisibility,
): Subteam[] {
  const userHide = new Set(user.hide);
  const userUnhide = new Set(user.unhide);
  return all.filter((s) => {
    if (userHide.has(s.id)) return false; // explicit user hide wins
    if (serverHidden.has(s.id) && !userUnhide.has(s.id)) return false;
    return true;
  });
}

// Keep EMPTY referenced as the canonical default shape (so callers can import a
// shared empty instead of re-spelling it).
export const EMPTY_VISIBILITY: SubteamVisibility = EMPTY;
