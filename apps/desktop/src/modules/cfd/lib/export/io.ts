// The ONE export-layer file allowed to touch Tauri plugins. Every other
// builder in lib/export/* is pure (string/bytes in, string/bytes out) so it
// stays unit-testable without a Tauri runtime; this module is the thin disk
// + clipboard seam they funnel through. Mirrors lib/csv-export.ts idioms:
// save() with a filter list, slug() for filenames, writeTextFile/writeFile.

import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile } from "@tauri-apps/plugin-fs";

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

/** Prompt for a save path (defaulting to `${defaultName}.${ext}` with an
 *  ext-named filter) and write text. Returns the chosen path, or null when
 *  the user cancels the dialog. */
export async function saveTextFile(
  defaultName: string,
  ext: string,
  contents: string,
): Promise<string | null> {
  const path = await save({
    defaultPath: `${defaultName}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (!path) return null;
  await writeTextFile(path, contents);
  return path;
}

/** Prompt for a save path and write raw bytes (PNG capture). Returns the
 *  chosen path, or null when cancelled. */
export async function savePngFile(
  defaultName: string,
  bytes: Uint8Array,
): Promise<string | null> {
  const path = await save({
    defaultPath: `${defaultName}.png`,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!path) return null;
  await writeFile(path, bytes);
  return path;
}

/** Copy text to the system clipboard. */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
