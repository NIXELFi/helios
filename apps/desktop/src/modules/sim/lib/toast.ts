/* The Sim module's own toast queue. See `lib/toast.ts` for why each module
 * has its own store; SimHome mounts the one host for it. */

import { createToastStore } from "../../../lib/toast";

export const simToasts = createToastStore();

/**
 * Say something went wrong, and leave it up until it is read.
 *
 * Errors used to go into one header string truncated at 420 px, and the next
 * successful six-second poll wiped it -- so a failure a driver did not happen
 * to be looking at was gone before they turned round. A toast that stays until
 * dismissed is the opposite of that.
 */
export function simError(e: unknown): void {
  simToasts.toast(e instanceof Error ? e.message : String(e), "error", { sticky: true });
}

export function simInfo(message: string, tone: "success" | "info" = "success"): void {
  simToasts.toast(message, tone);
}
