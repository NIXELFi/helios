/**
 * The Vault's toast bus. Action sites call `toast("Checked in frame.sldprt")`
 * and the single <ToastHost> mounted in VaultHome renders the queue — no
 * context plumbing through every button.
 *
 * The store itself is the shared one in `lib/toast.ts` (the Sim module has its
 * own instance); this file keeps the Vault's original function-style API.
 */

import { createToastStore, type ToastTone } from "../../../lib/toast";

export type { ToastItem, ToastTone } from "../../../lib/toast";

export const vaultToasts = createToastStore();

export function toast(message: string, tone: ToastTone = "success"): void {
  vaultToasts.toast(message, tone);
}

export const dismissToast = vaultToasts.dismiss;
export const subscribeToasts = vaultToasts.subscribe;

/** Test helper — clears queue + timers so toasts don't leak across tests. */
export const resetToasts = vaultToasts.reset;
