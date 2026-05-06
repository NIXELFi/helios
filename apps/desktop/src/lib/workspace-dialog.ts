import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";

const JSON_FILTER = [{ name: "JSON files", extensions: ["json"] }];

/** Open a native save dialog and write `contents` to the chosen file.
 *  Returns the chosen path, or null if the user cancelled. */
export async function saveJsonFile(
  defaultFileName: string,
  contents: string,
): Promise<string | null> {
  const path = await save({
    defaultPath: defaultFileName,
    filters: JSON_FILTER,
  });
  if (!path) return null;
  await writeTextFile(path, contents);
  return path;
}

/** Open a native open dialog filtered to JSON, read the chosen file, return
 *  its contents. Returns null if the user cancelled. */
export async function openJsonFile(): Promise<string | null> {
  const result = await open({
    multiple: false,
    filters: JSON_FILTER,
  });
  if (!result) return null;
  const path = typeof result === "string" ? result : (result as { path: string }).path;
  return await readTextFile(path);
}
