import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * "Is this module the one the user is looking at?"
 *
 * The Shell keeps every visited module MOUNTED and just toggles a `hidden`
 * class, so a background Vault/PM kept polling Supabase forever (measured
 * 2026-09-09: ~37 requests/min per idle client). This context lets a module
 * ask whether it is the active one and stand its background work down while it
 * isn't — realtime subscriptions stay up, only the timers pause.
 *
 * No provider → `true`. Stand-alone mounts (tests, the plugin host, a module
 * rendered outside the Shell) then behave exactly as they did before.
 */
const ModuleActiveContext = createContext<boolean>(true);

export function ModuleActivityProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return <ModuleActiveContext.Provider value={active}>{children}</ModuleActiveContext.Provider>;
}

/** True when this module is the visible one in the Shell (or has no provider). */
export function useModuleActive(): boolean {
  return useContext(ModuleActiveContext);
}

/** True while the window/tab is not hidden (minimised, another desktop, …). */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const read = () => setVisible(document.visibilityState !== "hidden");
    // Re-read on subscribe: visibility can flip between the initial render and
    // this effect, and nothing would tell us afterwards.
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);
  return visible;
}

/**
 * The flag background work should follow: the module is on screen AND the
 * window is visible. Flipping back to true is the cue to catch up with one
 * cheap request rather than a full re-pull.
 */
export function useModuleLive(): boolean {
  // Both hooks must run on EVERY render. `useModuleActive() && useDocumentVisible()`
  // short-circuits when the module is inactive, skipping useDocumentVisible's
  // useState/useEffect and shifting every later hook slot — the real app then
  // threw "Cannot create property 'current' on boolean" in PM and React #311
  // in the Vault the moment a module was hidden (5.7.1 smoke test).
  const active = useModuleActive();
  const visible = useDocumentVisible();
  return active && visible;
}
