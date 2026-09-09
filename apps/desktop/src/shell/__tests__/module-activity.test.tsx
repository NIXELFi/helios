import { describe, it, expect, afterEach } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { ReactNode } from "react";
import {
  ModuleActivityProvider,
  useDocumentVisible,
  useModuleActive,
  useModuleLive,
} from "../module-activity";

// jsdom reports "visible" by default. These helpers flip the value the way the
// browser does (property + event) so the hook's listener is what we exercise.
function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

function wrapperWith(active: boolean) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <ModuleActivityProvider active={active}>{children}</ModuleActivityProvider>;
  };
}

describe("useModuleActive", () => {
  it("is true with no provider so stand-alone mounts and tests behave as before", () => {
    const { result } = renderHook(() => useModuleActive());
    expect(result.current).toBe(true);
  });

  it("follows the provider's active flag", () => {
    const { result: off } = renderHook(() => useModuleActive(), { wrapper: wrapperWith(false) });
    expect(off.current).toBe(false);
    const { result: on } = renderHook(() => useModuleActive(), { wrapper: wrapperWith(true) });
    expect(on.current).toBe(true);
  });
});

describe("useDocumentVisible", () => {
  it("starts true and follows visibilitychange", () => {
    const { result } = renderHook(() => useDocumentVisible());
    expect(result.current).toBe(true);
    act(() => setVisibility("hidden"));
    expect(result.current).toBe(false);
    act(() => setVisibility("visible"));
    expect(result.current).toBe(true);
  });

  it("stops listening after unmount", () => {
    const { result, unmount } = renderHook(() => useDocumentVisible());
    unmount();
    act(() => setVisibility("hidden"));
    expect(result.current).toBe(true);
  });
});

describe("useModuleLive", () => {
  it("is true only when the module is active and the document is visible", () => {
    const { result } = renderHook(() => useModuleLive(), { wrapper: wrapperWith(true) });
    expect(result.current).toBe(true);
    act(() => setVisibility("hidden"));
    expect(result.current).toBe(false);
  });

  it("is false for a hidden module even while the window is visible", () => {
    const { result } = renderHook(() => useModuleLive(), { wrapper: wrapperWith(false) });
    expect(result.current).toBe(false);
  });
  it("calls the same hooks whether or not the module is active (hook order must not change)", () => {
    // Regression: `useModuleActive() && useDocumentVisible()` short-circuited
    // when inactive, skipped useDocumentVisible's useState/useEffect, and every
    // later hook read the wrong slot — PM crashed with "Cannot create property
    // 'current' on boolean" and the Vault with React #311 in the real app.
    const seen: Array<{ live: boolean; ref: object }> = [];
    function Probe() {
      const live = useModuleLive();
      const ref = useRef({ tag: "ref" });
      seen.push({ live, ref: ref.current });
      return null;
    }
    const view = render(<ModuleActivityProvider active={true}><Probe /></ModuleActivityProvider>);
    view.rerender(<ModuleActivityProvider active={false}><Probe /></ModuleActivityProvider>);
    view.rerender(<ModuleActivityProvider active={true}><Probe /></ModuleActivityProvider>);
    expect(seen.map((s) => s.live)).toEqual([true, false, true]);
    // The ref slot must be the SAME object every render, never a shifted hook value.
    expect(seen.every((s) => s.ref === seen[0]!.ref && typeof s.ref === "object")).toBe(true);
  });
});
