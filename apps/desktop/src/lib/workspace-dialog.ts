import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";

// Save dialog offers .helios as the primary extension. Open dialog accepts
// .helios AND .json — older builds shipped .json bundles, and the bundle
// payload is JSON either way, so we still recognize them on import.
const SAVE_FILTERS = [{ name: "Helios workspace bundle", extensions: ["helios"] }];
const OPEN_FILTERS = [{ name: "Helios workspace bundle", extensions: ["helios", "json"] }];

/** Open a native save dialog and write `contents` to the chosen file.
 *  Returns the chosen path, or null if the user cancelled. */
export async function saveBundleFile(
  defaultFileName: string,
  contents: string,
): Promise<string | null> {
  const path = await save({
    defaultPath: defaultFileName,
    filters: SAVE_FILTERS,
  });
  if (!path) return null;
  await writeTextFile(path, contents);
  return path;
}

/** Open a native open dialog filtered to Helios bundles, read the chosen
 *  file, return its contents. Returns null if the user cancelled. */
export async function openBundleFile(): Promise<string | null> {
  const result = await open({
    multiple: false,
    filters: OPEN_FILTERS,
  });
  if (!result) return null;
  const path = typeof result === "string" ? result : (result as { path: string }).path;
  return await readTextFile(path);
}
