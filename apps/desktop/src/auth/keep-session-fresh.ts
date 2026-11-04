import type { SupabaseClient } from "@helios/auth";

/**
 * Keep the Supabase session refreshing while the Helios window is hidden.
 *
 * In a browser context auth-js stops its refresh ticker whenever the page is
 * hidden (GoTrueClient._onVisibilityChanged): right for a background tab, wrong
 * for a desktop app that keeps working minimized. Helios hands its access token
 * to native code that keeps calling Supabase on its own, most visibly the
 * SOLIDWORKS add-in bridge (bridge_set_session). Once the window was hidden
 * for an hour that token expired and was never replaced: on 2026-11-03 the
 * bridge sent one expired JWT to /rest/v1/versions about every 4 s for hours
 * (6,299 401s from a single user), so the add-in could not read file status.
 *
 * The public startAutoRefresh() removes that visibility listener and keeps the
 * ticker running. The listener is only registered at the end of initialize(),
 * so this waits for it first; calling earlier would let initialize() re-add it.
 * Returns a disposer for when the client is replaced or unmounted.
 */
export function keepSessionFreshWhenHidden(client: SupabaseClient): () => void {
  let disposed = false;
  let started = false;
  // Partial clients (tests, the Lite build's stubs) may not carry the auth API.
  if (typeof client.auth?.initialize !== "function") return () => {};
  void client.auth
    .initialize()
    .then(() => {
      if (disposed) return;
      started = true;
      return client.auth.startAutoRefresh();
    })
    .catch(() => {
      // initialize() reports its own errors through the session; nothing to add.
    });
  return () => {
    disposed = true;
    if (started) void client.auth.stopAutoRefresh();
  };
}
