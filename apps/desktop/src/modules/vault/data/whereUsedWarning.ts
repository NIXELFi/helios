import type { WhereUsedRow } from "./useReferences";

export interface WhereUsedWarning {
  shouldWarn: true;
  /** Human-readable impact message listing the dependent assemblies. */
  message: string;
}

/**
 * Pure decision helper: given the list of parent assemblies that reference a
 * file, returns a warning descriptor (shouldWarn + message) when the list is
 * non-empty, or null when there are no dependents (no warning needed).
 *
 * Keeps this logic unit-testable without a Supabase client or React renderer.
 */
export function whereUsedWarning(parents: WhereUsedRow[]): WhereUsedWarning | null {
  if (parents.length === 0) return null;
  const n = parents.length;
  const noun = n === 1 ? "assembly" : "assemblies";
  const names = parents.map((p) => p.parentName).join(", ");
  return {
    shouldWarn: true,
    message: `This file is used by ${n} ${noun}: ${names}. Changing or removing it may affect them.`,
  };
}
