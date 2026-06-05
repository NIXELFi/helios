/**
 * Resolve the vault folder under a screen point for drag-and-drop import.
 *
 * Walks UP the DOM from the element at (x, y) looking for the nearest
 * ancestor carrying a `data-folder-id` attribute, and maps that to a target
 * folder id:
 *
 *   - attribute present with a value (`data-folder-id="abc"`)  → that id
 *   - attribute present but EMPTY  (`data-folder-id=""`)        → null (vault root)
 *   - no tagged ancestor found at all                          → `fallback`
 *
 * The empty-string case (vault root) is DISTINCT from "nothing tagged": a drop
 * onto the tree container resolves to the root (null), whereas a drop onto a
 * point with no `data-folder-id` anywhere up the chain falls back to the
 * caller's default (typically the currently-selected folder).
 *
 * Pure given an injected `elementFromPoint`, so it's unit-testable with a fake
 * element graph (objects exposing `getAttribute` + `parentElement`).
 */
export function resolveDropFolder(
  x: number,
  y: number,
  fallback: string | null,
  elementFromPoint: (x: number, y: number) => Element | null = (a, b) =>
    document.elementFromPoint(a, b),
): string | null {
  let el: Element | null = elementFromPoint(x, y);
  while (el) {
    // getAttribute returns null when the attribute is absent, and "" when it
    // is present-but-empty (the vault-root marker). We must distinguish them.
    const attr = el.getAttribute("data-folder-id");
    if (attr !== null) {
      return attr === "" ? null : attr;
    }
    el = el.parentElement;
  }
  return fallback;
}
