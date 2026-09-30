import type { LocalStatus } from "./LocalStatusBadge";

/** Small badge shown in the version column, to the left of the "Xd ago" text,
 *  naming which vault version the user's LOCAL copy actually is (not just
 *  that it's stale). Pure text/tone derivation - FileTable owns the markup. */
export interface VersionBadgeInfo {
  text: string;
  /** "dim" = up to date (helios-dim styling); "warn" = needs attention (gold). */
  tone: "dim" | "warn";
  /** Tooltip text. Omitted for the synced case - the column's own title
   *  attribute already names the latest version + comment. */
  title?: string;
}

/**
 * Derive the version badge for a row, given its local-sync status, the
 * file's latest version number, and (when known) the version number the
 * user's local copy actually matches.
 *
 * `localNum` comes from useLocalVersionNums, which resolves an older local
 * revision by sha - versionsMap only ever carries the LATEST version per
 * file, so a "modified" row can't otherwise be told "you have v12" from "you
 * edited it and it matches nothing".
 *
 *  - synced: "v<latest>" (dim) - always has a version once synced.
 *  - vault-only: no badge (nothing local to name).
 *  - modified, localNum known: "v<local> of v<latest>" (warn), with a
 *    tooltip spelling out both numbers.
 *  - modified, localNum unknown: "edited" (warn) - the local content
 *    doesn't match ANY known version of the file.
 *  - no-folder / anything else: no badge.
 */
export function versionBadge(
  status: LocalStatus | undefined,
  latestNum: number | undefined,
  localNum: number | undefined,
): VersionBadgeInfo | null {
  if (status === "synced") {
    return latestNum === undefined ? null : { text: `v${latestNum}`, tone: "dim" };
  }
  if (status === "modified") {
    if (localNum !== undefined && latestNum !== undefined) {
      return {
        text: `v${localNum} of v${latestNum}`,
        tone: "warn",
        title: `Your local copy is v${localNum}; latest is v${latestNum}`,
      };
    }
    return {
      text: "edited",
      tone: "warn",
      title: "Local copy differs from every vault version",
    };
  }
  // "vault-only", "no-folder" (or undefined) - nothing local to name.
  return null;
}
