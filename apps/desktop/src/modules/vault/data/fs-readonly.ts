import { invoke } from "@tauri-apps/api/core";
import { toast } from "./toast";

/**
 * Toggle the OS read-only bit on a local file via the `set_path_readonly` app
 * command (Rust). Backs the Vault's real-vault model: a local working copy is
 * read-only unless the file is checked out by the current user.
 *
 * Best-effort: a permissions hiccup must never break a download / check-out /
 * check-in flow, so failures are logged and swallowed rather than thrown.
 */
export async function setReadonly(path: string, readonly: boolean): Promise<void> {
  try {
    await invoke("set_path_readonly", { path, readonly });
  } catch (e) {
    console.warn(`[vault] set_path_readonly(${path}, ${readonly}) failed:`, e);
  }
}

/**
 * Flip an OPEN SOLIDWORKS document's in-session read-only state to match a
 * check-out change, via the out-of-process helper. The on-disk bit
 * (setReadonly above) only governs the NEXT open; this makes an already-open
 * file editable on check-out / re-protected on check-in WITHOUT the
 * SOLIDWORKS add-in. Never blocks or throws (no-op if SOLIDWORKS isn't running
 * or the file isn't open).
 *
 * Calls are queued and sent in BATCHES: everything queued while a batch runs
 * goes in the next one, so a 300-file bulk check-out costs one or two helper
 * processes, never 300. A path queued again before it is sent keeps only the
 * latest desired state.
 *
 * The helper now reports what happened to each file. When SOLIDWORKS still has
 * a file you just checked out open read-only (or one you just checked in open
 * editable), Helios says so: before, a refused flip was silent and the user
 * only found out when Save failed.
 */
export function flipSwReadonly(path: string, readonly: boolean): void {
  swFlipQueue.delete(path); // re-insert so the latest request keeps its order
  swFlipQueue.set(path, readonly);
  if (!swFlipDraining) void drainSwFlips();
}

export type SwFlipStatus =
  | "not-open"
  | "already"
  | "flipped"
  | "reloaded"
  | "failed-dirty"
  | "failed"
  | "ambiguous";

interface SwFlipBatch {
  swRunning: boolean;
  results: { path: string; status: SwFlipStatus | string }[];
}

const swFlipQueue = new Map<string, boolean>();
let swFlipDraining = false;

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** What to tell the user about one flip outcome, or null for nothing. */
export function swFlipMessage(
  path: string,
  readonly: boolean,
  status: string,
): { message: string; tone: "success" | "error" } | null {
  const name = baseName(path);
  if (!readonly) {
    switch (status) {
      case "reloaded":
        return { message: `Reloaded ${name} in SOLIDWORKS so you can edit it.`, tone: "success" };
      case "failed-dirty":
        return {
          message: `SOLIDWORKS still has ${name} open read-only and it has unsaved changes, so Helios couldn't switch it. Save As a copy in SOLIDWORKS if you need those changes, then close ${name} and open it again to edit it.`,
          tone: "error",
        };
      case "failed":
        return {
          message: `SOLIDWORKS still has ${name} open read-only. Close it in SOLIDWORKS and open it again to edit it.`,
          tone: "error",
        };
      case "ambiguous":
        return {
          message: `More than one file named ${name} is open in SOLIDWORKS, so Helios couldn't tell which to make editable. Close ${name} and open it again from the vault folder.`,
          tone: "error",
        };
      default:
        return null;
    }
  }
  if (status === "failed" || status === "ambiguous") {
    return {
      message: `${name} is still editable in SOLIDWORKS but no longer checked out to you. Close it there so changes don't get lost.`,
      tone: "error",
    };
  }
  return null;
}

async function drainSwFlips(): Promise<void> {
  swFlipDraining = true;
  try {
    while (swFlipQueue.size > 0) {
      const batch = Array.from(swFlipQueue.entries());
      swFlipQueue.clear();
      for (const readonly of [false, true]) {
        const paths = batch.filter(([, ro]) => ro === readonly).map(([p]) => p);
        if (paths.length === 0) continue;
        let res: SwFlipBatch | null = null;
        try {
          res = (await invoke("sw_flip_readonly_batch", { paths, readonly })) as SwFlipBatch | null;
        } catch {
          // Non-Tauri context (tests) or the helper failed: best-effort, move on.
        }
        if (!res || !res.swRunning || !Array.isArray(res.results)) continue;
        for (const r of res.results) {
          // A newer request for this path is already queued; it decides.
          if (swFlipQueue.has(r.path)) continue;
          if (r.status !== "not-open" && r.status !== "already") {
            // warn, so a failure lands in bug-report breadcrumbs.
            const log = r.status.startsWith("failed") || r.status === "ambiguous" ? console.warn : console.info;
            log(`[vault] SOLIDWORKS ${readonly ? "read-only" : "write access"}: ${r.status} ${r.path}`);
          }
          const msg = swFlipMessage(r.path, readonly, r.status);
          if (msg) toast(msg.message, msg.tone);
        }
      }
    }
  } finally {
    swFlipDraining = false;
  }
}
