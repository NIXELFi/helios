/**
 * Warning (never a hard limit) before a huge file goes into the vault.
 *
 * Every vault member's auto-sync downloads every published file, so one big
 * upload costs its size times the whole team in storage bandwidth. In early
 * November 2026 a few ~1 GB ANSYS files cost about 550 GB in three days. A
 * file over HUGE_FILE_BYTES asks first, wherever it comes from: check-in
 * (single and bulk), drag-and-drop, the add banner, auto-add and the
 * SOLIDWORKS add-in. "Add anyway" always goes ahead.
 *
 * The add/check-in hooks await `confirmHugeUpload`; <HugeFileConfirmHost/>
 * (mounted once in the Shell) shows the dialog. Answers are remembered for
 * the session per file + content, so auto-add doesn't ask again on every scan
 * after a "Don't add".
 */

export const HUGE_FILE_BYTES = 250_000_000;

export const HUGE_FILE_WARNING =
  "This file is huge and could brick Helios for everyone. Please ask a maintainer.";

export interface HugeUploadRequest {
  /** Identifies this file + content, e.g. `add|Chassis/x.sldasm|<size>`. */
  key: string;
  name: string;
  bytes: number;
  action: "add" | "check in";
}

interface Pending extends HugeUploadRequest {
  resolve: (ok: boolean) => void;
}

const answers = new Map<string, boolean>();
const queue: Pending[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function isHugeFile(bytes: number): boolean {
  return bytes > HUGE_FILE_BYTES;
}

/** Resolves true to go ahead. Small files, and any file when no dialog host
 *  is mounted (tests, a window without the Shell), go ahead without asking:
 *  this is a warning, not a gate. */
export function confirmHugeUpload(req: HugeUploadRequest): Promise<boolean> {
  if (!isHugeFile(req.bytes)) return Promise.resolve(true);
  const known = answers.get(req.key);
  if (known !== undefined) return Promise.resolve(known);
  if (listeners.size === 0) {
    console.warn(`[vault] ${req.action} of ${req.name} (${formatSize(req.bytes)}) without a size warning: no dialog host`);
    return Promise.resolve(true);
  }
  // The same file already waiting (auto-add re-scans) shares one dialog.
  const waiting = queue.find((p) => p.key === req.key);
  if (waiting) {
    return new Promise((resolve) => {
      const prev = waiting.resolve;
      waiting.resolve = (ok) => { prev(ok); resolve(ok); };
    });
  }
  return new Promise((resolve) => {
    queue.push({ ...req, resolve });
    emit();
  });
}

/** The request the dialog should show, or null. Returns the queued object
 *  itself: useSyncExternalStore needs the same reference until it changes. */
export function currentHugeUpload(): HugeUploadRequest | null {
  return queue[0] ?? null;
}

/** Answer the request with this key. Keyed because ConfirmDialog calls
 *  onClose right after onConfirm: the second call must not answer the NEXT
 *  file in the queue. */
export function answerHugeUpload(key: string, ok: boolean): void {
  if (queue[0]?.key !== key) return;
  const p = queue.shift()!;
  answers.set(p.key, ok);
  if (ok) console.warn(`[vault] ${p.action} of huge file ${p.name} (${formatSize(p.bytes)}) confirmed by the user`);
  p.resolve(ok);
  emit();
}

export function subscribeHugeUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export const HUGE_UPLOAD_DECLINED = "Not added: you chose not to upload this huge file. Ask a maintainer first.";

/** Test helper. */
export function resetHugeUploadGuard(): void {
  answers.clear();
  for (const p of queue.splice(0)) p.resolve(true);
  listeners.clear();
}
