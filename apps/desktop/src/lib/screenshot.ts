import { invoke } from "@tauri-apps/api/core";
import { recordBreadcrumb } from "./breadcrumbs";

/** Capture the app window as a PNG Blob. Best-effort: returns null on any
 *  failure (capturing a screenshot must never block filing a report). */
export async function captureScreenshot(): Promise<Blob | null> {
  try {
    const bytes = await invoke<number[]>("capture_app_screenshot");
    return new Blob([new Uint8Array(bytes)], { type: "image/png" });
  } catch (e) {
    recordBreadcrumb("error", `screenshot capture failed: ${String(e)}`);
    return null;
  }
}
