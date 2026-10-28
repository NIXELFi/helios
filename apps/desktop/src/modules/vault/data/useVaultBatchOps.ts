// Batch check-out / check-in / undo check-out / get latest / delete over a set
// of vault files, with a live progress bar, a Stop button, and a per-file
// outcome list.
//
// Shared by the multi-select BulkActionBar and the folder-level check-out /
// check-in dialog (FolderBatchDialog), so both run the exact same per-file
// rules: lock rollback on every failure path, read-only flips, sync-ledger
// records, abort safety. Eligibility comes from batch-classify.ts, the same
// classifier the folder dialog's pre-flight plan uses.

import { useEffect, useMemo, useRef, useState } from "react";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { useAcquireLock } from "./useAcquireLock";
import { useReleaseLock } from "./useReleaseLock";
import { useDeleteFile } from "./useDeleteFile";
import { useCheckIn } from "./useCheckIn";
import { isStaleBaseError } from "./pg-errors";
import { useDownloadVersion } from "./useDownloadVersion";
import { useRecordRefs } from "./useRecordRefs";
import { useRecordProperties } from "./useRecordProperties";
import { matchLocal, normalizePathForCompare, vaultRelativePath } from "./local-match";
import { localDestPathStrict } from "./folder-paths";
import { ledgerRecord, loadLedger } from "./sync-ledger";
import { setReadonly, flipSwReadonly } from "./fs-readonly";
import { activeLockMap, classifyCheckIn, classifyCheckOut, lockKind, type ClassifyCtx } from "./batch-classify";
import { runPool } from "../lib/pool";
import { toast } from "./toast";
import type { FileId, Folder, Lock, UserId, VaultFile, Version } from "./types";
import type { LocalFile } from "./useLocalFolderScan";

/** Check-in reads each file into memory, gzips and uploads it, so keep it to a
 *  few in flight: large SOLIDWORKS uploads would otherwise saturate the link. */
const CHECKIN_CONCURRENCY = 3;
/** Check-out and get latest are a lock insert plus (sometimes) a native
 *  download that never crosses the webview, so they can run wider. Most of a
 *  folder check-out is per-file round-trip latency, which this hides. */
export const TRANSFER_CONCURRENCY = 6;

/** Modification time in ms, or null when it can't be read (the guard that
 *  uses it then stands down rather than blocking the check-in). */
async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    const t = info.mtime;
    return t instanceof Date ? t.getTime() : t == null ? null : new Date(t as unknown as string).getTime();
  } catch {
    return null;
  }
}

export type BatchOp = "checkout" | "checkin" | "cancel" | "getLatest" | "delete";

export interface BatchProgress {
  verb: string;
  done: number;
  total: number;
  /** Most recently started file, shown beside the bar. */
  current: string | null;
}

export interface BatchOutcome {
  id: FileId;
  name: string;
  kind: "failed" | "skipped";
  reason: string;
}

export interface BatchResult {
  op: BatchOp;
  total: number;
  ok: number;
  /** The run stopped early: user Stop, or superseded (selection change). */
  aborted: boolean;
  /** The abort was the user's Stop button. */
  stopped: boolean;
  /** One-line summary, e.g. "Checked out 3/5 (2 checked out by someone else)". */
  status: string;
  /** Every row that didn't succeed, with a human reason. */
  outcomes: BatchOutcome[];
  failedCount: number;
}

export interface BatchRunOptions {
  /** Check-in comment applied to every file. Defaults to "bulk check-in". */
  comment?: string | null;
  /** Check-in: also check in files checked out to you whose content is
   *  unchanged (the server just releases the checkout, no new version). The
   *  folder check-in does this, SolidWorks PDM style. */
  includeUnchangedMine?: boolean;
}

export interface BatchCtx {
  files: VaultFile[];
  localFiles: LocalFile[] | null | undefined;
  versionsByFileId: Map<FileId, Version[]>;
  vaultRoot: string | null | undefined;
  folders: Folder[];
  vaultId: string | null;
  locks: Lock[];
  currentUserId: UserId | null;
  /** Lock-holder display names, for "checked out by Alice" reasons. */
  holderLabelById?: Map<UserId, string>;
  /** Vault-relative paths the local scan saw open in SOLIDWORKS. When given,
   *  only those files get the in-session read-only flip (each flip is a
   *  helper process); omitted = flip every file. */
  openInSw?: Set<string>;
}

const PAST: Record<BatchOp, string> = {
  checkout: "checked out",
  checkin: "checked in",
  cancel: "undid",
  getLatest: "downloaded",
  delete: "deleted",
};

const VERB: Record<BatchOp, string> = {
  checkout: "Checking out",
  checkin: "Checking in",
  cancel: "Undoing checkout",
  getLatest: "Downloading",
  delete: "Deleting",
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function useVaultBatchOps(ctx: BatchCtx) {
  const acquireLock = useAcquireLock();
  const releaseLock = useReleaseLock();
  const deleteFile = useDeleteFile();
  const checkIn = useCheckIn();
  const download = useDownloadVersion();
  const recordRefs = useRecordRefs();
  const recordProperties = useRecordProperties();

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  // Set by stop() so a run can tell a user Stop from a superseded run.
  // Mirrored in state for the "Stopping..." label.
  const stoppingRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  // AbortController for the in-flight run. Workers poll `signal.aborted`
  // between steps and after each await, so once it fires they stop reading
  // files, stop calling RPCs, and roll back any lock they took this pass.
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const filesById = useMemo(() => new Map(ctx.files.map((f) => [f.id, f])), [ctx.files]);
  const lockByFile = useMemo(() => activeLockMap(ctx.locks), [ctx.locks]);
  const classifyCtx: ClassifyCtx = {
    localFiles: ctx.localFiles ?? null,
    versionsByFileId: ctx.versionsByFileId,
    folders: ctx.folders,
    lockByFile,
    currentUserId: ctx.currentUserId,
  };

  const openInSwNorm = useMemo(
    () => (ctx.openInSw ? new Set(Array.from(ctx.openInSw, normalizePathForCompare)) : null),
    [ctx.openInSw],
  );
  /** Tell an open SOLIDWORKS session about a read-only change. Skipped for
   *  files the scan didn't see open, so a 300-file batch doesn't queue 300
   *  helper launches. */
  function flipIfOpen(file: VaultFile, path: string, readonly: boolean) {
    if (openInSwNorm && !openInSwNorm.has(normalizePathForCompare(vaultRelativePath(file, ctx.folders)))) return;
    flipSwReadonly(path, readonly);
  }

  function holderName(lock: Lock | undefined): string {
    if (!lock) return "someone else";
    return ctx.holderLabelById?.get(lock.user_id) ?? "someone else";
  }

  /** Abort whatever is running (superseded: no "Stopped" status). */
  function abort() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  /** User Stop. Stays busy ("Stopping...") until in-flight rows finish their
   *  own rollback/finalize, so a new run can't race them. */
  function stop() {
    if (!abortRef.current) return; // nothing running
    stoppingRef.current = true;
    setStopping(true);
    abortRef.current?.abort();
  }

  async function run(op: BatchOp, ids: FileId[], opts: BatchRunOptions = {}): Promise<BatchResult | null> {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;
    const total = ids.length;
    const outcomes: BatchOutcome[] = [];
    const nameOf = (id: FileId) => filesById.get(id)?.name ?? String(id);
    const fail = (id: FileId, reason: string) => outcomes.push({ id, name: nameOf(id), kind: "failed", reason });
    const skip = (id: FileId, reason: string) => outcomes.push({ id, name: nameOf(id), kind: "skipped", reason });

    setBusy(true);
    setProgress({ verb: VERB[op], done: 0, total, current: null });
    // This machine's sync ledger tells an untouched older copy from an edit
    // (see batch-classify). Best-effort: without it the classifier is just
    // more conservative.
    let runCtx: ClassifyCtx = classifyCtx;
    if (ctx.vaultId && (op === "checkout" || op === "checkin")) {
      try {
        runCtx = { ...classifyCtx, ledger: (await loadLedger(ctx.vaultId)).entries };
      } catch {
        // keep the conservative classification
      }
    }
    let ok = 0;
    // Op-specific counters for the one-line summary.
    const c = { fail: 0, skipped: 0, lockedByOther: 0, alreadyMine: 0, kept: 0, discarded: 0, restoreFailed: 0, notMine: 0 };

    const tracked = (fn: (id: FileId) => Promise<void>) => async (id: FileId) => {
      setProgress((p) => p && { ...p, current: filesById.get(id)?.name ?? null });
      try {
        await fn(id);
      } finally {
        setProgress((p) => p && { ...p, done: p.done + 1 });
      }
    };

    // The workers are hoisted function declarations further down this scope.
    const worker: (id: FileId) => Promise<void> = {
      checkout: checkOutOne,
      checkin: checkInOne,
      cancel: cancelOne,
      getLatest: getLatestOne,
      delete: deleteOne,
    }[op];
    const limit = op === "checkin" ? CHECKIN_CONCURRENCY
      : op === "checkout" || op === "getLatest" ? TRANSFER_CONCURRENCY
      : 1;
    try {
      await runPool(ids, limit, tracked((id) => worker(id)), signal);
    } catch (e) {
      // A worker throw is a bug; never leave every batch button disabled.
      console.error("[vault] batch worker threw", e);
      if (mountedRef.current) toast("A bulk action hit an unexpected error. Some files may not have been processed.", "error");
    }

    const aborted = signal.aborted;
    const stopped = aborted && stoppingRef.current;
    if (abortRef.current === ctrl) abortRef.current = null;
    if (!mountedRef.current) return null;
    // A superseded run (a newer run already started) must not clobber the
    // newer run's busy/progress state.
    const superseded = aborted && !stopped && abortRef.current !== null;
    if (!superseded) {
      stoppingRef.current = false;
      setStopping(false);
      setBusy(false);
      setProgress(null);
    }

    const failedCount = outcomes.filter((o) => o.kind === "failed").length;
    return { op, total, ok, aborted, stopped, status: summary(), outcomes, failedCount };

    function summary(): string {
      if (op === "delete") {
        const failed = outcomes.filter((o) => o.kind === "failed").map((o) => o.name);
        const tail = failed.length ? `. Failed: ${failed.join(", ")}` : "";
        if (aborted) {
          return `${stopped ? "Stopped: deleted" : "Deleted"} ${ok}/${total}${stopped ? "" : " (interrupted)"}${tail}`;
        }
        return `Deleted ${ok}/${total}${tail}`;
      }
      if (aborted) return stopped ? `Stopped: ${PAST[op]} ${ok} of ${total}` : "";
      const detail: string[] = [];
      let head = "";
      if (op === "checkin") {
        head = `Checked in ${ok}/${total}`;
        if (c.fail) detail.push(`${c.fail} failed`);
        if (c.skipped) detail.push(`${c.skipped} skipped`);
        if (c.lockedByOther) detail.push(`${c.lockedByOther} checked out by someone else`);
      } else if (op === "checkout") {
        head = `Checked out ${ok}/${total}`;
        if (c.fail) detail.push(`${c.fail} failed`);
        if (c.lockedByOther) detail.push(`${c.lockedByOther} checked out by someone else`);
        if (c.alreadyMine) detail.push(`${c.alreadyMine} already yours`);
        if (c.kept) detail.push(`${c.kept} kept, local changes`);
      } else if (op === "getLatest") {
        head = `Downloaded ${ok}/${total}`;
        if (c.fail) detail.push(`${c.fail} failed`);
        if (c.skipped) detail.push(`${c.skipped} skipped`);
        if (c.kept) detail.push(`${c.kept} kept, local changes`);
      } else {
        head = `Cancelled ${ok}/${total}`;
        if (c.discarded) detail.push(`${plural(c.discarded, "draft")} discarded`);
        if (c.fail) detail.push(`${c.fail} failed`);
        if (c.restoreFailed) detail.push(`${c.restoreFailed} released but local restore failed`);
        if (c.notMine) detail.push(`${c.notMine} not yours`);
      }
      return head + (detail.length ? ` (${detail.join(", ")})` : "");
    }

    // ---------------------------------------------------------------------
    // Per-file workers. Each one is self-contained: whatever lock it takes it
    // gives back on every failure / abort path before the row counts as done.
    // ---------------------------------------------------------------------

    async function checkOutOne(id: FileId) {
      if (signal.aborted) return;
      const file = filesById.get(id);
      // An id missing from the catalog can't get its local copy made writable,
      // so taking the lock would report a checkout that isn't usable.
      if (!file) { c.fail++; fail(id, "This file isn't loaded yet. Try again in a moment."); return; }
      // Before the first local scan lands we can't tell an edit from a stale
      // copy, and the download below would overwrite whatever is on disk.
      if (ctx.vaultRoot && ctx.localFiles == null) {
        c.fail++;
        fail(id, "Still scanning your local vault folder. Try again in a moment.");
        return;
      }
      const cls = classifyCheckOut(file, runCtx);
      // Skip rows that would fail / no-op at the RPC layer, so the summary
      // reads "1/3 (2 checked out by someone else)" instead of "0/3 (3 failed)".
      if (cls.kind === "mine") { c.alreadyMine++; skip(id, "Already checked out to you"); return; }
      if (cls.kind === "other") { c.lockedByOther++; skip(id, `Checked out by ${holderName(cls.lock)}`); return; }
      if (cls.kind === "local-edits") {
        c.kept++;
        skip(id, "Your local copy has changes that aren't in the vault. Check it out on its own to decide what to keep.");
        return;
      }
      const r = await acquireLock.run(id);
      // Aborting between acquire and use strands the lock (the abort scope
      // fires on any selection change), so release before bailing. Only a lock
      // THIS call took: a failed acquire may mean the user already holds it
      // (stale lock list), and releasing that would drop their real checkout.
      if (signal.aborted) { if (r) await releaseLock.run(id); return; }
      if (!r) {
        c.fail++;
        fail(id, "Couldn't take the checkout (someone may have just checked it out)");
        return;
      }
      // Make the local copy editable: get the latest first if ours is missing
      // or stale (so nobody edits an outdated base and checks it in over a
      // teammate's newer work), then clear the read-only bit. Mirrors the
      // single-file CheckOut, including rolling the lock back if the required
      // download fails.
      if (ctx.vaultRoot) {
        const m = matchLocal(file, ctx.localFiles ?? null, ctx.versionsByFileId, ctx.folders);
        const ver = ctx.versionsByFileId.get(id)?.[0];
        // Strict: never download/chmod through a collapsed root path.
        const dest = localDestPathStrict(ctx.vaultRoot, file.folder_id, file.name, ctx.folders);
        if (!dest) {
          await releaseLock.run(id);
          c.fail++;
          fail(id, "Couldn't resolve its local folder. Try again in a moment.");
          return;
        }
        const stale = !m.local || (!!ver && m.local.sha256?.toLowerCase() !== ver.sha256.toLowerCase());
        if (ver && stale) {
          const got = await download.run(ver.sha256, dest, signal);
          if (signal.aborted) { await releaseLock.run(id); return; }
          if (!got) {
            const released = await releaseLock.run(id);
            c.fail++;
            fail(id, released
              ? "Couldn't download the latest version, so the checkout was rolled back"
              : "Couldn't download the latest version, and the checkout couldn't be released. It's still checked out to you; use Undo check-out.");
            return;
          }
          if (ctx.vaultId) void ledgerRecord(ctx.vaultId, vaultRelativePath(file, ctx.folders), ver.sha256);
        }
        await setReadonly(dest, false);
        // Tell an open SOLIDWORKS doc too, so a kept checkout is editable
        // there as well. The bytes are right and the copy is writable: the
        // checkout is done, so an abort after this point KEEPS the lock
        // (releasing would leave a writable unlocked copy, which sync treats
        // as unsaved edits forever) and the row counts as checked out.
        flipIfOpen(file, dest, false);
      }
      ok++;
    }

    async function checkInOne(id: FileId) {
      if (signal.aborted) return;
      const file = filesById.get(id);
      if (!file) { c.skipped++; skip(id, "Not in the file list anymore"); return; }
      const cls = classifyCheckIn(file, runCtx, !!opts.includeUnchangedMine);
      if (cls.kind === "other") {
        c.lockedByOther++;
        skip(id, cls.hasLocalEdits
          ? `You changed it locally, but ${holderName(cls.lock)} has it checked out`
          : `Checked out by ${holderName(cls.lock)}`);
        return;
      }
      if (cls.kind === "mine-no-local") {
        c.skipped++;
        skip(id, "Helios couldn't read a local copy. It may be missing, or open or locked by another program. Close it and try again.");
        return;
      }
      if (cls.kind === "mine-unchanged") { c.skipped++; skip(id, "No changes"); return; }
      if (cls.kind === "mine-stale") {
        c.skipped++;
        skip(id, "Your local copy is an older version you haven't edited. Get the latest before checking it in.");
        return;
      }
      if (cls.kind === "nothing") { c.skipped++; skip(id, "Nothing to check in"); return; }
      const m = matchLocal(file, ctx.localFiles ?? null, ctx.versionsByFileId, ctx.folders);
      const local = m.local!;
      const prevVersionId = ctx.versionsByFileId.get(id)?.[0]?.id ?? null;
      // `acquiredHere` records that THIS pass took the lock, so every exit
      // path can give it back. A readFile throw (the part is open in
      // SOLIDWORKS with an exclusive handle) must not strand a lock only an
      // admin force-unlock could clear.
      let acquiredHere = false;
      if (cls.needsLock) {
        const acquired = await acquireLock.run(id);
        if (signal.aborted) { if (acquired) await releaseLock.run(id); return; }
        if (!acquired) { c.fail++; fail(id, "Couldn't take the checkout (someone may have just checked it out)"); return; }
        acquiredHere = true;
      }
      try {
        const mtimeBefore = await mtimeOf(local.absolutePath);
        const fileBytes = await readFile(local.absolutePath);
        if (signal.aborted) { if (acquiredHere) await releaseLock.run(id); return; }
        const ab = fileBytes.buffer.slice(
          fileBytes.byteOffset,
          fileBytes.byteOffset + fileBytes.byteLength,
        ) as ArrayBuffer;
        const comment = opts.comment === undefined ? "bulk check-in" : opts.comment;
        let why: string | null = null;
        // Base version = what this machine last put at this path. Only for
        // files with a version (a draft has nothing to be stale against).
        const baseSha = prevVersionId
          ? runCtx.ledger?.[normalizePathForCompare(vaultRelativePath(file, ctx.folders))]?.sha256 ?? null
          : null;
        const r = await checkIn.run(id, ab, comment, { onError: (e) => { why = e.message; }, baseSha });
        // Aborted before the RPC landed: give the lock back and stop. If it DID
        // land, fall through: the read-only + ledger finalize must run even on
        // abort, or the checked-in copy stays writable and reads as an unsaved
        // edit that sync holds back forever.
        if (signal.aborted && !r) { if (acquiredHere) await releaseLock.run(id); return; }
        if (r) {
          ok++;
          // pdm_check_in released the lock server-side; a later throw in this
          // block must NOT try to release it again.
          acquiredHere = false;
          // Saved again while we were uploading? Then the disk no longer holds
          // what was checked in. Freezing it would turn that newer edit into a
          // read-only "stale" copy the next sync overwrites, so leave it
          // writable (sync holds back writable edits) and say so.
          const mtimeAfter = await mtimeOf(local.absolutePath);
          const savedAgain = mtimeBefore !== null && mtimeAfter !== null && mtimeAfter !== mtimeBefore;
          if (savedAgain) {
            skip(id, "Checked in, but the file was saved again during the upload. Your newer edit was left writable; check it out and in again to keep it.");
          } else {
            await setReadonly(local.absolutePath, true);
            flipIfOpen(file, local.absolutePath, true);
            if (ctx.vaultId) void ledgerRecord(ctx.vaultId, vaultRelativePath(file, ctx.folders), r.sha256);
          }
          // New content: capture assembly references and the data card, like
          // the single-file check-in. Best-effort, never fails the row.
          // Skipped when the file was saved again: the disk no longer holds the
          // bytes this version was made from.
          if (r.id !== prevVersionId && !savedAgain) {
            await Promise.allSettled([
              recordRefs.run(r.id, local.absolutePath, local.basename ?? file.name, ctx.vaultId),
              recordProperties.run(r.id, local.absolutePath, local.basename ?? file.name, true),
            ]);
          }
        } else {
          // Upload / RPC failed and the lock is still ours. Only give it back
          // if we took it for this attempt (a lock the user already held stays
          // theirs; they were mid-edit).
          if (acquiredHere) await releaseLock.run(id);
          c.fail++;
          fail(id, isStaleBaseError(why)
            ? `${why} To keep your copy anyway, check this file in on its own.`
            : why ?? "Check-in failed");
        }
      } catch (e) {
        if (acquiredHere) await releaseLock.run(id);
        if (signal.aborted) return;
        c.fail++;
        fail(id, `Couldn't read the local file${e instanceof Error && e.message ? ` (${e.message})` : ""}. Is it open in another program?`);
      }
    }

    async function getLatestOne(id: FileId) {
      if (signal.aborted) return;
      const file = filesById.get(id);
      if (!file) { c.skipped++; skip(id, "Not in the file list anymore"); return; }
      const ver = ctx.versionsByFileId.get(id)?.[0];
      if (!ver) { c.skipped++; skip(id, "No checked-in version yet"); return; }
      // Never overwrite a WRITABLE copy that differs from the vault: it may be
      // unsaved work. A read-only differing copy is just stale and is refreshed.
      const m = matchLocal(file, ctx.localFiles ?? null, ctx.versionsByFileId, ctx.folders);
      if (m.status === "modified" && m.local && m.local.readonly !== true) {
        c.kept++;
        skip(id, "Kept your local changes");
        return;
      }
      const dest = localDestPathStrict(ctx.vaultRoot!, file.folder_id, file.name, ctx.folders);
      if (!dest) { c.skipped++; skip(id, "Couldn't resolve its local folder"); return; }
      const r = await download.run(ver.sha256, dest, signal);
      if (signal.aborted) return;
      if (r) {
        ok++;
        if (ctx.vaultId) void ledgerRecord(ctx.vaultId, vaultRelativePath(file, ctx.folders), ver.sha256);
      } else {
        c.fail++;
        fail(id, "Download failed");
      }
    }

    async function cancelOne(id: FileId) {
      if (signal.aborted) return;
      // Only rows the user owns can be released; someone else's lock needs an
      // admin force-unlock, which is out of the batch path.
      if (lockKind(classifyCtx, id) !== "me") { c.notMine++; skip(id, "Not checked out to you"); return; }
      const file = filesById.get(id);
      const ver = file ? ctx.versionsByFileId.get(id)?.[0] : undefined;
      // Never-checked-in draft: nothing to restore, so undo = discard the
      // draft (soft-delete releases the lock; the reaper removes the copy).
      // Keyed on latest_version_id, not the embedded `latest` row: the embed
      // can be briefly null on a published file (realtime patch), and treating
      // that as a draft would delete a real file.
      if (file && file.latest_version_id == null) {
        const del = await deleteFile.run(id);
        if (del) c.discarded++;
        else { c.fail++; fail(id, "Couldn't discard the draft"); }
        return;
      }
      const rel = await releaseLock.run(id);
      if (!rel) { c.fail++; fail(id, "Couldn't release the checkout"); return; }
      // Released: the checkout IS undone. Finish the local restore even if the
      // run was aborted meanwhile (stopping here would leave discarded edits
      // writable with no lock). A failed restore is tracked separately; the
      // vault row is already correct and the next sync self-heals the copy.
      ok++;
      if (file && ver && ctx.vaultRoot) {
        const dest = localDestPathStrict(ctx.vaultRoot, file.folder_id, file.name, ctx.folders);
        if (!dest) { c.restoreFailed++; skip(id, "Released, but the local copy couldn't be restored"); return; }
        // Untouched checkout: the copy already IS the latest, so skip the
        // re-download and just make it read-only again.
        const m = matchLocal(file, ctx.localFiles ?? null, ctx.versionsByFileId, ctx.folders);
        const unchanged = m.status === "synced";
        const restored = unchanged || await download.run(ver.sha256, dest);
        if (!restored) { c.restoreFailed++; skip(id, "Released, but the local copy couldn't be restored"); return; }
        // Only freeze on a successful restore: a failed one leaves the edit
        // writable (held back), never a read-only-but-dirty copy.
        await setReadonly(dest, true);
        flipIfOpen(file, dest, true);
        if (ctx.vaultId) void ledgerRecord(ctx.vaultId, vaultRelativePath(file, ctx.folders), ver.sha256);
      }
    }

    async function deleteOne(id: FileId) {
      if (signal.aborted) return;
      // A throw counts as a named failure, so the status never reads as a
      // clean "Deleted N/N".
      let r = false;
      try {
        r = !!(await deleteFile.run(id));
      } catch (e) {
        console.error("[vault] bulk delete threw", e);
      }
      if (signal.aborted) return;
      if (r) ok++;
      // deleteFile.error is React state, stale inside this closure.
      else fail(id, "Delete failed. You need the checkout or vault admin rights.");
    }
  }

  return { run, stop, abort, busy, stopping, progress };
}
