// Pure filename helpers copied from the CFD module's lib/export/io.ts. The
// disk/clipboard seam there is Tauri-bound; a sandboxed plugin writes files
// through the SDK `save()` capability instead, so we lift ONLY the pure,
// runtime-free helpers (slug + timestamp) the Lap Sim screen needs for filenames.

/** Lowercase a label into a filename-safe slug. csv-export.ts idiom. */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Compact local timestamp for filenames, e.g. "20260605-134501". */
export function fileTimestamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
