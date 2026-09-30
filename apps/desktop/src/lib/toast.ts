/**
 * A tiny module-level toast bus, one per module that wants one.
 *
 * Action sites call `store.toast("Checked in frame.sldprt")` and the single
 * `<ToastHost store={store} />` mounted by that module renders the queue -- no
 * context plumbing through every button. Promoted out of the Vault so the Sim
 * module could have the same thing without a second copy.
 *
 * One store per module rather than one global queue, on purpose: Helios keeps
 * visited modules mounted and merely hidden, so a global queue would put a Sim
 * error on top of the Vault (or render it twice, once per host). Each module
 * owns its store and its host, and a hidden module's toasts wait, hidden with
 * it, until the user comes back.
 */

export type ToastTone = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  /** Stays until dismissed. */
  sticky: boolean;
}

export interface ToastOptions {
  /** Keep it on screen until the user dismisses it. */
  sticky?: boolean;
  /** Override the auto-dismiss delay, in milliseconds. */
  durationMs?: number;
}

type Listener = (items: ToastItem[]) => void;

export interface ToastStore {
  /** Show a message. Returns its id, for `dismiss`. An identical message
   *  already on screen is not shown twice; its id is returned instead. */
  toast: (message: string, tone?: ToastTone, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
  subscribe: (listener: Listener) => () => void;
  /** Test helper -- clears the queue and its timers. */
  reset: () => void;
}

export const AUTO_DISMISS_MS = 4000;
/** Errors stick around longer -- the user may need to read a real message. */
export const ERROR_DISMISS_MS = 8000;

export function createToastStore(): ToastStore {
  let items: ToastItem[] = [];
  let nextId = 1;
  const listeners = new Set<Listener>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const emit = () => {
    for (const l of listeners) l(items);
  };

  function dismiss(id: number): void {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
    if (!items.some((i) => i.id === id)) return;
    items = items.filter((i) => i.id !== id);
    emit();
  }

  function toast(message: string, tone: ToastTone = "success", options: ToastOptions = {}): number {
    // The same words twice is one message, not two. A poll that fails the
    // same way every few seconds must not stack a column of identical errors.
    const dup = items.find((i) => i.message === message && i.tone === tone);
    if (dup) return dup.id;
    const id = nextId++;
    const sticky = !!options.sticky;
    items = [...items, { id, message, tone, sticky }];
    emit();
    if (!sticky) {
      const ttl = options.durationMs ?? (tone === "error" ? ERROR_DISMISS_MS : AUTO_DISMISS_MS);
      timers.set(id, setTimeout(() => dismiss(id), ttl));
    }
    return id;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener(items);
    return () => {
      listeners.delete(listener);
    };
  }

  function reset(): void {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    items = [];
    emit();
  }

  return { toast, dismiss, subscribe, reset };
}
