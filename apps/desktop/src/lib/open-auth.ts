/* "Sign in" from inside a module.
 *
 * The AuthModal belongs to the Shell. A module that needs the user signed in
 * -- the Sim module's Launch tab, which will not start a run for nobody --
 * asks for it with a window event, the same decoupling `open-in-logs` and
 * `helios:open-settings` use: the sender does not import the Shell, and the
 * Shell does not know which modules might ask. */

export const OPEN_AUTH_EVENT = "helios:open-auth";

/** Ask the Shell to open its sign-in dialog. */
export function requestSignIn(): void {
  window.dispatchEvent(new CustomEvent(OPEN_AUTH_EVENT));
}
