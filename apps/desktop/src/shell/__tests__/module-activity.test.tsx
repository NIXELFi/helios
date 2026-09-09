import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
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
});
