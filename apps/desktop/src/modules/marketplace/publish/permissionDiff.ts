// What changed about a version's permissions since the last approved release.
//
// This is the single thing a reviewer most needs to see. A plugin that has been
// approved four times and asks for nothing new is a routine update; the same
// plugin suddenly asking for engine:matlab is a different decision entirely, and
// it should not be something a reviewer has to spot by comparing two lists by eye.

import { hasHighTrust } from "../components/PermissionList";

export interface PermissionDiff {
  /** Requested now, absent from the last approved version. */
  added: string[];
  /** Present in the last approved version, dropped now. */
  removed: string[];
  /** Requested in both. */
  unchanged: string[];
  /** True when nothing about the ask changed. */
  identical: boolean;
  /** True when this is the plugin's first submission (nothing to compare to). */
  isFirstVersion: boolean;
  /** True when any ADDED permission is high trust — the case worth interrupting for. */
  addsHighTrust: boolean;
}

/**
 * Compare a submission's permissions against the last approved version's.
 *
 * @param previous  the last approved version's permissions, or null when there
 *                  is no approved version yet (a brand-new plugin)
 * @param next      the permissions this submission declares
 */
export function permissionDiff(previous: string[] | null, next: string[]): PermissionDiff {
  const nextSet = [...new Set(next)].sort();

  if (previous === null) {
    return {
      added: nextSet,
      removed: [],
      unchanged: [],
      identical: nextSet.length === 0,
      isFirstVersion: true,
      addsHighTrust: hasHighTrust(nextSet),
    };
  }

  const prevSet = new Set(previous);
  const added = nextSet.filter((p) => !prevSet.has(p));
  const removed = [...prevSet].filter((p) => !nextSet.includes(p)).sort();
  const unchanged = nextSet.filter((p) => prevSet.has(p));

  return {
    added,
    removed,
    unchanged,
    identical: added.length === 0 && removed.length === 0,
    isFirstVersion: false,
    addsHighTrust: hasHighTrust(added),
  };
}

/** One-line summary for the confirm step and the review queue. Written so the
 *  common case — nothing new — reads as reassuring rather than as an absence. */
export function describeDiff(diff: PermissionDiff): string {
  if (diff.isFirstVersion) {
    return diff.added.length === 0
      ? "Pure sandbox — this plugin asks for no permissions at all."
      : `First release. Asks for ${diff.added.length} permission${diff.added.length === 1 ? "" : "s"}.`;
  }
  if (diff.identical) return "No change — this version asks for exactly what the last approved one did.";

  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`asks for ${diff.added.length} new`);
  if (diff.removed.length > 0) parts.push(`drops ${diff.removed.length}`);
  return `Permissions changed: ${parts.join(", ")}.`;
}
