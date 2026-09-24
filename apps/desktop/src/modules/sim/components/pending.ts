/* Which button is waiting on something slow.
 *
 * Opening a teammate's run means downloading its lap first, which on a rig's
 * network can take a few seconds -- and a button that does nothing visible for
 * three seconds gets clicked three more times. The clicked button says it is
 * working, and the others for the same run wait their turn. */

export type PendingAction = "replay" | "logs" | "chase" | "compare";

export interface Pending {
  runId: string;
  action: PendingAction;
}

export function isPending(p: Pending | null | undefined, runId: string, action?: PendingAction): boolean {
  return !!p && p.runId === runId && (action == null || p.action === action);
}
