/**
 * Property-aware search helpers for Vault file search.
 *
 * Supports a `prop:key=value` token syntax on top of free-text filename
 * matching.  Everything here is pure (no React, no side-effects) so it is
 * cheap to unit-test and easy to compose in any UI layer.
 *
 * Syntax:
 *   prop:Material=7075          – matches any file whose Material property
 *                                  contains "7075" (case-insensitive substring)
 *   prop:Material="7075 T6"     – quoted value allows spaces
 *   prop:Status=Prototype prop:Material=steel
 *                               – multiple tokens AND-combine
 *   bracket prop:Material=steel – bare text used for filename match; prop
 *                                  tokens extracted and removed from free text
 */

import type { SwProperty } from "../data/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PropFilter {
  /** Lowercase property name (or substring thereof) to match. */
  key: string;
  /** Lowercase value substring to require. */
  value: string;
}

export interface ParsedSearchQuery {
  /** Free text remaining after all prop: tokens have been stripped, trimmed. */
  text: string;
  /** Extracted property filters; AND-combined during matching. */
  propFilters: PropFilter[];
}

// ---------------------------------------------------------------------------
// parseSearchQuery
// ---------------------------------------------------------------------------

/**
 * Splits a raw search string into free text and `prop:key=value` filters.
 *
 * Token grammar (matched left-to-right):
 *   prop:<key>=<value>          – unquoted value, ends at next whitespace
 *   prop:<key>="<value>"        – double-quoted value (spaces allowed inside)
 *
 * Keys and values are normalised to lowercase.  Bare words that are NOT
 * prop: tokens are preserved as free text (joined with a single space).
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const propFilters: PropFilter[] = [];
  const textTokens: string[] = [];

  // Tokenise: quoted prop tokens, unquoted prop tokens, or plain words.
  // Regex groups:
  //   1 – prop key (quoted value variant)
  //   2 – prop value (quoted, between double quotes)
  //   3 – prop key (unquoted value variant)
  //   4 – prop value (unquoted, runs to next whitespace)
  //   5 – plain non-whitespace token
  const tokenRe =
    /prop:([^=\s]+)="([^"]*)"|prop:([^=\s]+)=(\S+)|(\S+)/gi;

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(raw)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) {
      // prop:key="quoted value"
      propFilters.push({
        key: m[1].toLowerCase(),
        value: m[2].toLowerCase(),
      });
    } else if (m[3] !== undefined && m[4] !== undefined) {
      // prop:key=unquoted
      propFilters.push({
        key: m[3].toLowerCase(),
        value: m[4].toLowerCase(),
      });
    } else if (m[5] !== undefined) {
      // plain word
      textTokens.push(m[5]);
    }
  }

  return {
    text: textTokens.join(" ").trim(),
    propFilters,
  };
}

// ---------------------------------------------------------------------------
// matchesProperties
// ---------------------------------------------------------------------------

/**
 * Returns true iff every filter in `propFilters` is satisfied by at least one
 * property in `fileProps`.
 *
 * Matching rules:
 *   - Property name must CONTAIN the filter key (case-insensitive), allowing
 *     "mat" to match "Material".
 *   - Property value must CONTAIN the filter value (case-insensitive substring).
 *   - Empty `propFilters` → always true (nothing to constrain).
 *   - Null / undefined / empty `fileProps` with a non-empty filter → false.
 */
export function matchesProperties(
  fileProps: SwProperty[] | null | undefined,
  propFilters: PropFilter[],
): boolean {
  if (propFilters.length === 0) return true;
  if (!fileProps || fileProps.length === 0) return false;

  return propFilters.every((filter) => {
    const filterKey = filter.key.toLowerCase();
    const filterVal = filter.value.toLowerCase();
    return fileProps.some(
      (prop) =>
        prop.name.toLowerCase().includes(filterKey) &&
        prop.value.toLowerCase().includes(filterVal),
    );
  });
}

// ---------------------------------------------------------------------------
// propertyTextMatch
// ---------------------------------------------------------------------------

/**
 * Returns true when any property VALUE in `fileProps` contains `text` as a
 * case-insensitive substring.
 *
 * This lets a bare search term like "7075" surface files whose Material value
 * is "7075-T6 Aluminum" even if the filename doesn't mention the material.
 *
 * Returns false for null / undefined / empty props, or empty text.
 */
export function propertyTextMatch(
  fileProps: SwProperty[] | null | undefined,
  text: string,
): boolean {
  if (!text) return false;
  if (!fileProps || fileProps.length === 0) return false;

  const needle = text.toLowerCase();
  return fileProps.some((prop) => prop.value.toLowerCase().includes(needle));
}
