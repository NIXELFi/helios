import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  activeLockMap,
  planCheckIn,
  planCheckOut,
  type ClassifyCtx,
  type HeldRow,
} from "../data/batch-classify";
import { useVaultBatchOps, type BatchCtx, type BatchResult } from "../data/useVaultBatchOps";
import { folderPath } from "../data/folder-paths";
import { relativeWhen, absoluteWhen } from "../lib/when";
import type { FileId, FolderId, VaultFile } from "../data/types";

export type FolderBatchOp = "checkout" | "checkin";

interface Props {
  op: FolderBatchOp;
  /** What the user picked: a folder (name + id), the whole vault, or a
   *  multi-selection. Only used for wording and relative paths. */
  scope: { kind: "folder"; name: string; folderId: FolderId } | { kind: "vault"; name: string } | { kind: "selection" };
  /** Every live file in the scope (a folder: all descendants, recursively). */
  scopeFiles: VaultFile[];
  /** Vault-wide batch context. `files` should be the full catalog so names
   *  resolve for every row. */
  ctx: BatchCtx;
  onClose: () => void;
  /** Called after a run finishes with the ids it touched, so the caller can
   *  refetch those rows. */
  onDone: (ids: FileId[]) => void;
}

/**
 * Folder-level check-out / check-in, SolidWorks PDM style. Opens on a pre-flight
 * plan of every file under the folder: what will happen, and which files are
 * already checked out (to you or a teammate) and why they'll be left alone.
 * The user can proceed with the rest in one click. Then a live progress bar,
 * then a result list naming every file that didn't go through and why.
 */
export function FolderBatchDialog({ op, scope, scopeFiles, ctx, onClose, onDone }: Props) {
  const batch = useVaultBatchOps(ctx);
  const [phase, setPhase] = useState<"plan" | "running" | "done">("plan");
  const [result, setResult] = useState<BatchResult | null>(null);
  const [comment, setComment] = useState("");
  const primaryRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const lockByFile = useMemo(() => activeLockMap(ctx.locks), [ctx.locks]);
  const filesById = useMemo(() => new Map(ctx.files.map((f) => [f.id, f])), [ctx.files]);
  const classifyCtx: ClassifyCtx = useMemo(() => ({
    localFiles: ctx.localFiles ?? null,
    versionsByFileId: ctx.versionsByFileId,
    folders: ctx.folders,
    lockByFile,
    currentUserId: ctx.currentUserId,
  }), [ctx.localFiles, ctx.versionsByFileId, ctx.folders, lockByFile, ctx.currentUserId]);

  // Live while the plan is on screen: a teammate's checkout that lands via
  // realtime updates the lists. The run re-checks every row as it starts too.
  const outPlan = useMemo(
    () => (op === "checkout" ? planCheckOut(scopeFiles, classifyCtx) : null),
    [op, scopeFiles, classifyCtx],
  );
  const inPlan = useMemo(
    () => (op === "checkin" ? planCheckIn(scopeFiles, classifyCtx) : null),
    [op, scopeFiles, classifyCtx],
  );
  const eligible = outPlan?.eligible ?? inPlan?.eligible ?? [];

  // Without a finished local scan we can't tell a stale copy from a local edit:
  // a check-out would re-download (and could overwrite) every file, and a
  // check-in has nothing to read. Hold the run until the scan lands.
  const scanPending = !!ctx.vaultRoot && ctx.localFiles == null;
  const noLocalFolder = !ctx.vaultRoot;
  const blockedReason =
    op === "checkin" && noLocalFolder ? "Pick a local vault folder first. Check-in uploads your local copies."
      : scanPending ? "Still scanning your local vault folder..."
      : null;

  const scopeRoot = scope.kind === "folder" ? folderPath(scope.folderId, ctx.folders) : "";
  function relPath(f: VaultFile): string {
    const dir = folderPath(f.folder_id, ctx.folders);
    const full = dir ? `${dir}/${f.name}` : f.name;
    return scopeRoot && full.startsWith(`${scopeRoot}/`) ? full.slice(scopeRoot.length + 1) : full;
  }
  function holder(row: HeldRow): string {
    return ctx.holderLabelById?.get(row.lock.user_id) ?? "someone else";
  }

  const busy = batch.busy;
  // Escape closes, except mid-run (use Stop). Focus the primary action.
  useEffect(() => {
    (primaryRef.current ?? cancelRef.current)?.focus();
  }, [phase]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function go() {
    if (eligible.length === 0 || blockedReason) return;
    setPhase("running");
    const where = scope.kind === "selection" ? "" : ` (${scope.kind === "folder" ? scopeRoot || scope.name : scope.name})`;
    const ids = eligible.map((f) => f.id);
    const r = await batch.run(op, ids, op === "checkin"
      ? { includeUnchangedMine: true, comment: comment.trim() || `folder check-in${where}` }
      : {});
    if (!r) return; // unmounted
    setResult(r);
    setPhase("done");
    onDone(ids);
  }

  const scopeName = scope.kind === "selection" ? "the selection" : `"${scope.name}"`;
  const verb = op === "checkout" ? "Check out" : "Check in";
  const n = eligible.length;
  const title = scope.kind === "selection"
    ? `${verb} ${scopeFiles.length} selected file${scopeFiles.length === 1 ? "" : "s"}`
    : `${verb} ${scope.kind === "vault" ? "everything in" : "folder"} ${scopeName}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 helios-overlay-in"
      onClick={() => { if (!busy) onClose(); }}
      onMouseDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-batch-title"
    >
      <div
        className="flex max-h-[85vh] w-[560px] max-w-[calc(100vw-32px)] flex-col rounded-sm border border-helios-line bg-helios-base helios-elevate helios-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-9 shrink-0 items-center border-b border-helios-line px-4">
          <span id="folder-batch-title" className="truncate text-sm font-semibold text-helios-text">{title}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs text-helios-text">
          {phase === "plan" && (
            <>
              <p className="text-helios-dim">
                {scopeFiles.length} file{scopeFiles.length === 1 ? "" : "s"}
                {scope.kind === "folder" ? " in this folder and its subfolders" : scope.kind === "vault" ? " in this vault" : ""}.
              </p>
              <p className="mt-2 font-medium" data-testid="folder-batch-eligible">
                {op === "checkout"
                  ? n === 0
                    ? "Nothing here can be checked out."
                    : `${n} file${n === 1 ? "" : "s"} will be checked out to you.`
                  : n === 0
                    ? "Nothing here to check in."
                    : `${n} file${n === 1 ? "" : "s"} will be checked in` +
                      (inPlan && inPlan.unchanged > 0
                        ? ` (${inPlan.changed} changed, ${inPlan.unchanged} unchanged: those just release your checkout).`
                        : ".")}
              </p>
              {op === "checkout" && noLocalFolder && n > 0 && (
                <p className="mt-1 text-[#FFB300]">No local vault folder is set, so the files will be locked to you but not downloaded.</p>
              )}

              {outPlan && (
                <>
                  <Section
                    tone="warn"
                    title={`Checked out by someone else (${outPlan.others.length}), will be skipped`}
                    rows={outPlan.others.map((r) => ({ key: r.file.id, path: relPath(r.file), note: `${holder(r)}, ${relativeWhen(r.lock.acquired_at)}`, noteTitle: absoluteWhen(r.lock.acquired_at) }))}
                  />
                  <Section
                    tone="info"
                    title={`Already checked out to you (${outPlan.mine.length}), nothing to do`}
                    rows={outPlan.mine.map((f) => ({ key: f.id, path: relPath(f) }))}
                  />
                  <Section
                    tone="warn"
                    title={`Local changes not in the vault (${outPlan.localEdits.length}), will be skipped`}
                    hint="These copies are writable and differ from the vault. Check them out one at a time so nothing you changed is overwritten."
                    rows={outPlan.localEdits.map((f) => ({ key: f.id, path: relPath(f) }))}
                  />
                </>
              )}
              {inPlan && (
                <>
                  <Section
                    tone="error"
                    title={`Changed locally but checked out by someone else (${inPlan.blocked.length}), can't check in`}
                    hint="Ask them to check it in or release it, then check in your copy."
                    rows={inPlan.blocked.map((r) => ({ key: r.file.id, path: relPath(r.file), note: `${holder(r)}, ${relativeWhen(r.lock.acquired_at)}`, noteTitle: absoluteWhen(r.lock.acquired_at) }))}
                  />
                  <Section
                    tone="warn"
                    title={`Checked out to you but missing locally (${inPlan.mineNoLocal.length}), will be skipped`}
                    hint="There's no local copy to upload. Get it back, or use Undo check-out to release it."
                    rows={inPlan.mineNoLocal.map((f) => ({ key: f.id, path: relPath(f) }))}
                  />
                  <Section
                    tone="info"
                    title={`Checked out by someone else (${inPlan.others.length}), not affected`}
                    rows={inPlan.others.map((r) => ({ key: r.file.id, path: relPath(r.file), note: `${holder(r)}, ${relativeWhen(r.lock.acquired_at)}`, noteTitle: absoluteWhen(r.lock.acquired_at) }))}
                  />
                  {n > 0 && (
                    <label className="mt-3 block">
                      <span className="text-helios-dim">Comment (applies to every changed file)</span>
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={2}
                        placeholder="What changed? (optional)"
                        className="mt-1 w-full resize-none rounded-sm border border-helios-line bg-helios-panel px-2 py-1 text-xs text-helios-text outline-none focus:border-asu-gold"
                      />
                    </label>
                  )}
                </>
              )}
              {blockedReason && <p className="mt-3 text-[#FFB300]">{blockedReason}</p>}
            </>
          )}

          {phase === "running" && batch.progress && (
            <div
              role="progressbar"
              aria-label={batch.progress.verb}
              aria-valuemin={0}
              aria-valuemax={batch.progress.total}
              aria-valuenow={batch.progress.done}
              className="space-y-2"
            >
              <div className="font-medium">
                {batch.stopping
                  ? "Stopping, letting the files in progress finish..."
                  : `${batch.progress.verb} ${Math.min(batch.progress.done + 1, batch.progress.total)} of ${batch.progress.total}...`}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-helios-line">
                <div
                  className="h-full rounded-full bg-asu-gold transition-[width] duration-300"
                  style={{ width: `${batch.progress.total ? (batch.progress.done / batch.progress.total) * 100 : 0}%` }}
                />
              </div>
              {batch.progress.current && (
                <div className="truncate font-mono-num text-helios-dim" title={batch.progress.current}>{batch.progress.current}</div>
              )}
            </div>
          )}

          {phase === "done" && result && (
            <ResultView result={result} pathOf={(id) => {
              const f = filesById.get(id);
              return f ? relPath(f) : null;
            }} />
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-helios-line px-4 py-3">
          {phase === "plan" && (
            <>
              <button
                ref={cancelRef}
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-sm border border-helios-line bg-helios-panel px-3 py-1 text-xs text-helios-text transition-colors hover:border-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
              >
                {n === 0 ? "Close" : "Cancel"}
              </button>
              {n > 0 && (
                <button
                  ref={primaryRef}
                  type="button"
                  onClick={() => { void go(); }}
                  disabled={!!blockedReason}
                  title={blockedReason ?? undefined}
                  className="cursor-pointer rounded-sm border border-asu-gold bg-asu-gold px-3 py-1 text-xs font-semibold text-helios-on-gold transition-colors hover:border-[#FFB300] hover:bg-[#FFB300] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {verb} {n} file{n === 1 ? "" : "s"}
                </button>
              )}
            </>
          )}
          {phase === "running" && (
            <button
              type="button"
              onClick={batch.stop}
              disabled={batch.stopping}
              className="cursor-pointer rounded-sm border border-helios-line bg-helios-panel px-3 py-1 text-xs text-helios-text hover:border-asu-gold disabled:opacity-50"
            >
              Stop
            </button>
          )}
          {phase === "done" && (
            <button
              ref={primaryRef}
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-sm border border-asu-gold bg-asu-gold px-3 py-1 text-xs font-semibold text-helios-on-gold hover:bg-[#FFB300]"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface Row { key: string; path: string; note?: string; noteTitle?: string }

const TONE: Record<"info" | "warn" | "error", string> = {
  info: "text-helios-dim",
  warn: "text-[#FFB300]",
  error: "text-[#EF5350]",
};

/** A titled, scrollable list of files. Renders nothing when empty. */
function Section({ title, hint, rows, tone }: { title: string; hint?: string; rows: Row[]; tone: "info" | "warn" | "error" }) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-3">
      <h3 className={`font-medium ${TONE[tone]}`}>{title}</h3>
      {hint && <p className="mt-0.5 text-helios-dim">{hint}</p>}
      <ul className="mt-1 max-h-40 overflow-y-auto rounded-sm border border-helios-line bg-helios-panel">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 border-b border-helios-line px-2 py-1 last:border-b-0">
            <span className="min-w-0 flex-1 truncate font-mono-num" title={r.path}>{r.path}</span>
            {r.note && <span className="max-w-[55%] shrink-0 truncate text-helios-dim" title={r.noteTitle}>{r.note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResultView({ result, pathOf }: { result: BatchResult; pathOf: (id: string) => string | null }) {
  const failed = result.outcomes.filter((o) => o.kind === "failed");
  const skipped = result.outcomes.filter((o) => o.kind === "skipped");
  const verbPast = result.op === "checkout" ? "Checked out" : "Checked in";
  let headline: ReactNode;
  if (result.stopped) headline = `Stopped. ${verbPast} ${result.ok} of ${result.total}.`;
  else headline = `${verbPast} ${result.ok} of ${result.total} file${result.total === 1 ? "" : "s"}.`;
  const toRows = (list: typeof failed): Row[] =>
    list.map((o) => ({ key: o.id, path: pathOf(o.id) ?? o.name, note: o.reason, noteTitle: o.reason }));
  return (
    <div role="status" aria-live="polite">
      <p className="font-medium">{headline}</p>
      {failed.length === 0 && skipped.length === 0 && !result.stopped && (
        <p className="mt-1 text-helios-dim">Everything went through.</p>
      )}
      <Section tone="error" title={`Failed (${failed.length})`} rows={toRows(failed)} />
      <Section tone="warn" title={`Skipped (${skipped.length})`} rows={toRows(skipped)} />
    </div>
  );
}
