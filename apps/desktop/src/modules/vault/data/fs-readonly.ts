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

export interface SwFlipOptions {
  /**
   * Check-out only: the check-out just DOWNLOADED a newer version over the
   * local copy. SOLIDWORKS may still have the older version in memory, and
   * making that editable in place would let the user save old-version work
   * over the new one, so the helper RELOADS it from disk instead (or says so
   * when it has unsaved changes). Ignored when `readonly`.
   */
  reload?: boolean;
  /** Read-only only: why, for the message when SOLIDWORKS had unsaved changes.
   *  Defaults to "checkin". */
  reason?: "checkin" | "cancel";
}

/** What the helper is asked to do: flip in place (`rw`), reload editable from
 *  disk (`rwr`), or make read-only (`ro`). */
export type SwFlipIntent = "rw" | "rwr" | "ro";

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
 * processes, never 300. A path queued again before it is sent keeps the
 * latest read-only state, but a pending reload is never downgraded to an
 * in-place flip: once newer bytes were downloaded, SOLIDWORKS's copy is stale
 * until it is reloaded.
 *
 * The helper reports what happened to each file. When SOLIDWORKS still has
 * a file you just checked out open read-only (or one you just checked in open
 * editable), Helios says so: before, a refused flip was silent and the user
 * only found out when Save failed.
 */
export function flipSwReadonly(path: string, readonly: boolean, opts: SwFlipOptions = {}): void {
  const prev = swFlipQueue.get(path);
  swFlipQueue.delete(path); // re-insert so the latest request keeps its order
  swFlipQueue.set(path, {
    readonly,
    reload:
      (prev?.reload ?? false) ||
      swFlipReloadInFlight.has(path) ||
      (!readonly && opts.reload === true),
    reason: opts.reason ?? "checkin",
  });
  if (!swFlipDraining) void drainSwFlips();
}

export type SwFlipStatus =
  | "not-open"
  | "already"
  | "flipped"
  | "reloaded"
  | "failed-dirty"
  | "stale-dirty"
  | "flipped-dirty"
  | "failed"
  | "ambiguous";

interface SwFlipBatch {
  swRunning: boolean;
  results: { path: string; status: SwFlipStatus | string }[];
}

interface QueuedFlip {
  readonly: boolean;
  /** Sticky: set once a check-out downloaded newer bytes for this path. */
  reload: boolean;
  reason: "checkin" | "cancel";
}

const swFlipQueue = new Map<string, QueuedFlip>();
/** Paths in the reload batch being sent right now: a request queued for one
 *  meanwhile skips that batch's result, so it must carry the reload itself. */
const swFlipReloadInFlight = new Set<string>();
let swFlipDraining = false;

function intentOf(q: QueuedFlip): SwFlipIntent {
  return q.readonly ? "ro" : q.reload ? "rwr" : "rw";
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** What to tell the user about one flip outcome, or null for nothing. */
export function swFlipMessage(
  path: string,
  intent: SwFlipIntent,
  status: string,
  reason: "checkin" | "cancel" = "checkin",
): { message: string; tone: "success" | "error" } | null {
  const name = baseName(path);
  const ambiguous = {
    message: `${name} is open more than once in SOLIDWORKS (under different paths), so Helios couldn't tell which one to update. Close it and open it again from the vault folder.`,
    tone: "error" as const,
  };
  if (intent === "rwr") {
    switch (status) {
      case "reloaded":
        return { message: `Reloaded ${name} in SOLIDWORKS with the latest version so you can edit it.`, tone: "success" };
      case "stale-dirty":
      case "failed-dirty":
        return {
          message: `SOLIDWORKS has an older copy of ${name} with unsaved changes. Save a copy if you need them, then close ${name} and open it again to edit the latest version.`,
          tone: "error",
        };
      case "failed":
        return {
          message: `SOLIDWORKS still has an older copy of ${name} open. Close it and open it again to edit the latest version.`,
          tone: "error",
        };
      case "ambiguous":
        return ambiguous;
      default:
        return null;
    }
  }
  if (intent === "rw") {
    switch (status) {
      case "reloaded":
        return { message: `Reloaded ${name} in SOLIDWORKS so you can edit it.`, tone: "success" };
      case "failed-dirty":
      case "stale-dirty":
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
        return ambiguous;
      default:
        return null;
    }
  }
  if (status === "flipped-dirty") {
    return {
      message: reason === "cancel"
        ? `SOLIDWORKS still has unsaved changes to ${name}. Undo check-out kept the vault version on disk, and ${name} is now read-only.`
        : `Your unsaved SOLIDWORKS changes to ${name} were not checked in (Helios checked in the saved file). ${name} is now read-only.`,
      tone: "error",
    };
  }
  if (status === "failed" || status === "ambiguous") {
    return {
      message: `${name} is still editable in SOLIDWORKS but no longer checked out to you. Close it there so changes don't get lost.`,
      tone: "error",
    };
  }
  return null;
}

const QUIET = new Set(["not-open", "already", "flipped", "reloaded"]);

async function drainSwFlips(): Promise<void> {
  swFlipDraining = true;
  try {
    while (swFlipQueue.size > 0) {
      const batch = Array.from(swFlipQueue.entries());
      swFlipQueue.clear();
      for (const intent of ["rw", "rwr", "ro"] as const) {
        const group = batch.filter(([, q]) => intentOf(q) === intent);
        if (group.length === 0) continue;
        const paths = group.map(([p]) => p);
        const reasons = new Map(group.map(([p, q]) => [p, q.reason]));
        const readonly = intent === "ro";
        let res: SwFlipBatch | null = null;
        if (intent === "rwr") for (const p of paths) swFlipReloadInFlight.add(p);
        try {
          res = (await invoke("sw_flip_readonly_batch", {
            paths,
            readonly,
            reload: intent === "rwr",
          })) as SwFlipBatch | null;
        } catch {
          // Non-Tauri context (tests) or the helper failed: best-effort, move on.
        } finally {
          swFlipReloadInFlight.clear();
        }
        if (!res || !res.swRunning || !Array.isArray(res.results)) continue;
        for (const r of res.results) {
          // A newer request for this path is already queued; it decides.
          if (swFlipQueue.has(r.path)) continue;
          if (r.status !== "not-open" && r.status !== "already") {
            // warn, so a failure lands in bug-report breadcrumbs.
            const log = QUIET.has(r.status) ? console.info : console.warn;
            log(`[vault] SOLIDWORKS ${readonly ? "read-only" : intent === "rwr" ? "reload" : "write access"}: ${r.status} ${r.path}`);
          }
          const msg = swFlipMessage(r.path, intent, r.status, reasons.get(r.path));
          if (msg) toast(msg.message, msg.tone);
        }
      }
    }
  } finally {
    swFlipDraining = false;
  }
}
