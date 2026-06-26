// Types for the plain-ESM canonical compliance rules (compliance.mjs). Hand-written
// so TS consumers (the review pipeline, vitest) import the same module typed.

export type FindingKind = "forbidden-api" | "undeclared-permission" | "unused-permission";

export interface ComplianceFinding {
  level: "error" | "warn";
  kind: FindingKind;
  message: string;
  /** Bundle-relative file path (forbidden-api findings only). */
  path?: string;
  /** The capability key (declared/used findings only). */
  permission?: string;
}

export const ALLOWED_PERMISSIONS: string[];
export const FORBIDDEN: ReadonlyArray<{ re: RegExp; msg: string }>;
export const USAGE_TO_PERMISSION: ReadonlyArray<{ re: RegExp; perm: string }>;
export const SCANNABLE_EXTENSIONS: string[];

/** Scan a built bundle (path -> contents) against a manifest for findings. */
export function scanBundle(
  files: Record<string, string>,
  manifest: { permissions?: string[] },
): ComplianceFinding[];
