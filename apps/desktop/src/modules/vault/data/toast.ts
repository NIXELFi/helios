/**
 * Tiny module-level toast bus for the Vault module. Action sites call
 * `toast("Checked in frame.sldprt")` and the single <ToastHost> mounted in
 * VaultHome renders the queue — no context plumbing through every button.
 * Mirrors the lock-events pub/sub pattern.
 */

export type ToastTone = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const AUTO_DISMISS_MS = 4000;
// Errors stick around longer — the user may need to read a real message.
const ERROR_DISMISS_MS = 8000;

function emit() {
  for (const l of listeners) l(items);
}

export function toast(message: string, tone: ToastTone = "success"): void {
  const id = nextId++;
  items = [...items, { id, message, tone }];
  emit();
  const ttl = tone === "error" ? ERROR_DISMISS_MS : AUTO_DISMISS_MS;
  const t = setTimeout(() => dismissToast(id), ttl);
  timers.set(id, t);
}

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  if (!items.some((i) => i.id === id)) return;
  items = items.filter((i) => i.id !== id);
  emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(items);
  return () => listeners.delete(listener);
}

/** Test helper — clears queue + timers so toasts don't leak across tests. */
export function resetToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  items = [];
  emit();
}
