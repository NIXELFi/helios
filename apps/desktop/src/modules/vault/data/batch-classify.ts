// Per-file eligibility for batch check-out / check-in.
//
// One pure classifier is shared by the pre-flight plan the folder dialog shows
// ("38 will be checked out, 2 are checked out by Alice") and by the run itself
// (useVaultBatchOps), so what the dialog promises is exactly what the run does.
// The run re-classifies each row at the moment it starts, so a lock taken by a
// teammate after the dialog opened is still honoured.

import { matchLocal } from "./local-match";
import type { FileId, Folder, Lock, UserId, VaultFile, Version } from "./types";
import type { LocalFile } from "./useLocalFolderScan";

export interface ClassifyCtx {
  localFiles: LocalFile[] | null;
  versionsByFileId: Map<FileId, Version[]>;
  folders: Folder[];
  /** Active (released_at === null) lock per file. */
  lockByFile: Map<FileId, Lock>;
  currentUserId: UserId | null;
}

export function activeLockMap(locks: readonly Lock[]): Map<FileId, Lock> {
  const m = new Map<FileId, Lock>();
  for (const l of locks) if (l.released_at === null) m.set(l.file_id, l);
  return m;
}

export function lockKind(ctx: ClassifyCtx, fileId: FileId): "none" | "me" | "other" {
  const l = ctx.lockByFile.get(fileId);
  if (!l) return "none";
  return l.user_id === ctx.currentUserId ? "me" : "other";
}

export type CheckOutClass =
  | { kind: "eligible" }
  | { kind: "mine" }
  | { kind: "other"; lock: Lock }
  /** Writable local copy that differs from the vault and isn't checked out:
   *  possibly unsaved work. Checking out would download the latest over it, so
   *  a batch leaves it alone (same rule bulk Get Latest uses). */
  | { kind: "local-edits" };

export function classifyCheckOut(file: VaultFile, ctx: ClassifyCtx): CheckOutClass {
  const k = lockKind(ctx, file.id);
  if (k === "me") return { kind: "mine" };
  if (k === "other") return { kind: "other", lock: ctx.lockByFile.get(file.id)! };
  const m = matchLocal(file, ctx.localFiles, ctx.versionsByFileId, ctx.folders);
  const hasVersion = !!ctx.versionsByFileId.get(file.id)?.[0];
  if (hasVersion && m.status === "modified" && m.local && m.local.readonly !== true) {
    return { kind: "local-edits" };
  }
  return { kind: "eligible" };
}

export type CheckInClass =
  /** Will be checked in. `changed` = local bytes differ from the vault (a new
   *  version); otherwise the server just releases the checkout. `needsLock` =
   *  not checked out yet, the run takes the lock first. */
  | { kind: "eligible"; changed: boolean; needsLock: boolean }
  /** Checked out to someone else. `hasLocalEdits` = you also changed it
   *  locally, which can't be checked in until they release it. */
  | { kind: "other"; lock: Lock; hasLocalEdits: boolean }
  /** Checked out to you but there's no local copy to check in. */
  | { kind: "mine-no-local" }
  /** Checked out to you, unchanged, and the caller didn't ask to release
   *  unchanged checkouts. */
  | { kind: "mine-unchanged" }
  /** Nothing to do: not checked out and no local edits (synced, missing, or a
   *  read-only copy that's merely an older version). */
  | { kind: "nothing" };

export function classifyCheckIn(
  file: VaultFile,
  ctx: ClassifyCtx,
  includeUnchangedMine: boolean,
): CheckInClass {
  const m = matchLocal(file, ctx.localFiles, ctx.versionsByFileId, ctx.folders);
  const modified = m.status === "modified" && !!m.local;
  const k = lockKind(ctx, file.id);
  if (k === "other") {
    return {
      kind: "other",
      lock: ctx.lockByFile.get(file.id)!,
      hasLocalEdits: modified && m.local!.readonly !== true,
    };
  }
  if (k === "me") {
    if (!m.local) return { kind: "mine-no-local" };
    if (modified) return { kind: "eligible", changed: true, needsLock: false };
    return includeUnchangedMine
      ? { kind: "eligible", changed: false, needsLock: false }
      : { kind: "mine-unchanged" };
  }
  // Not checked out. Only a WRITABLE differing copy is an edit. A read-only one
  // is a clean copy of an older version (a teammate checked in since we last
  // synced); checking it in would push stale bytes over their work.
  if (modified && m.local!.readonly !== true) {
    return { kind: "eligible", changed: true, needsLock: true };
  }
  return { kind: "nothing" };
}

export interface HeldRow {
  file: VaultFile;
  lock: Lock;
}

export interface CheckOutPlan {
  eligible: VaultFile[];
  mine: VaultFile[];
  others: HeldRow[];
  localEdits: VaultFile[];
}

export function planCheckOut(files: readonly VaultFile[], ctx: ClassifyCtx): CheckOutPlan {
  const plan: CheckOutPlan = { eligible: [], mine: [], others: [], localEdits: [] };
  for (const f of files) {
    const c = classifyCheckOut(f, ctx);
    if (c.kind === "eligible") plan.eligible.push(f);
    else if (c.kind === "mine") plan.mine.push(f);
    else if (c.kind === "other") plan.others.push({ file: f, lock: c.lock });
    else plan.localEdits.push(f);
  }
  return plan;
}

export interface CheckInPlan {
  eligible: VaultFile[];
  changed: number;
  unchanged: number;
  /** Checked out by someone else, and you have local edits to it. */
  blocked: HeldRow[];
  /** Checked out by someone else, no local edits. Untouched, listed so the
   *  user knows the folder isn't fully theirs. */
  others: HeldRow[];
  mineNoLocal: VaultFile[];
}

export function planCheckIn(files: readonly VaultFile[], ctx: ClassifyCtx): CheckInPlan {
  const plan: CheckInPlan = {
    eligible: [], changed: 0, unchanged: 0, blocked: [], others: [], mineNoLocal: [],
  };
  for (const f of files) {
    const c = classifyCheckIn(f, ctx, true);
    if (c.kind === "eligible") {
      plan.eligible.push(f);
      if (c.changed) plan.changed++;
      else plan.unchanged++;
    } else if (c.kind === "other") {
      (c.hasLocalEdits ? plan.blocked : plan.others).push({ file: f, lock: c.lock });
    } else if (c.kind === "mine-no-local") {
      plan.mineNoLocal.push(f);
    }
  }
  return plan;
}
