import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Ensure RTL cleans up after every test so renders don't accumulate across tests.
afterEach(cleanup);

// jsdom does not implement matchMedia; stub it for any code that touches it.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (_query: string) => ({
      matches: false, media: _query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// crypto.randomUUID is available in modern jsdom; nothing to stub today.

// crypto.randomUUID is available in modern jsdom; nothing to stub today.

// jsdom has no Tauri runtime. Production code mounted by the Shell (useUpdater,
// getVersion, useBridgeSync, …) calls @tauri-apps/api, which reads
// window.__TAURI_INTERNALS__ and throws when it's absent — surfacing as
// *unhandled* errors that fail the whole run even when every assertion passes.
// Stub a minimal transport: transformCallback hands back an id and invoke
// resolves to null. Tests that need specific IPC behavior still vi.mock the
// module directly, which replaces this entirely. Existing keys win so a test
// can override before importing.
if (typeof window !== "undefined") {
  const existing = (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> })
    .__TAURI_INTERNALS__ ?? {};
  (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: () => Promise.resolve(null),
    // getCurrentWindow()/getCurrentWebview() read the current labels off
    // metadata at call time (the Shell's Windows TitleBar does this) and
    // throw when it's absent.
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    ...existing,
  };
  // @tauri-apps/api/event registers/unregisters listeners through this separate
  // internal — BridgeOpHandler's listen() cleanup calls unregisterListener on
  // unmount, which throws (unhandled) without it.
  const existingEvent = (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown> })
    .__TAURI_EVENT_PLUGIN_INTERNALS__ ?? {};
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown> }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
    ...existingEvent,
  };
}

// jsdom does not implement ResizeObserver; stub a no-op so components that
// observe element size in useEffect/useLayoutEffect don't blow up at render.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
}

// jsdom does not implement URL.createObjectURL / revokeObjectURL. maplibre-gl
// (pulled in transitively via @helios/widgets' GPS Track widget) calls it at
// import time and throws without it, so any test that imports App / widget code
// would crash on collection. Stub no-ops.
if (typeof URL.createObjectURL === "undefined") {
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:stub";
}
if (typeof URL.revokeObjectURL === "undefined") {
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
}

// jsdom does not implement Path2D — uPlot's points renderer constructs one.
if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") {
  class Path2DStub {
    addPath() {}
    arc() {}
    arcTo() {}
    bezierCurveTo() {}
    closePath() {}
    ellipse() {}
    lineTo() {}
    moveTo() {}
    quadraticCurveTo() {}
    rect() {}
    roundRect() {}
  }
  (globalThis as unknown as { Path2D: typeof Path2DStub }).Path2D = Path2DStub;
}

// jsdom's HTMLCanvasElement.getContext returns null, which causes uPlot
// (used by the CFD CycleChart + Cd-table plot) to throw "Cannot read
// properties of null (reading 'clearRect')". Stub a minimal 2D context
// that no-ops the methods uPlot uses so tests that render uPlot widgets
// don't generate unhandled errors.
if (typeof HTMLCanvasElement !== "undefined") {
  const noop = () => {};
  const stubCtx: Record<string, unknown> = new Proxy(
    {
      canvas: null,
      // Some uPlot paths read these properties.
      lineWidth: 1, strokeStyle: "#000", fillStyle: "#000",
      globalAlpha: 1, font: "10px sans-serif",
    },
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        // Every other property — drawing methods etc. — is a no-op.
        return noop;
      },
      set(target, prop, value) {
        (target as Record<string | symbol, unknown>)[prop] = value;
        return true;
      },
    },
  );
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    _type: string,
  ): RenderingContext | null {
    stubCtx.canvas = this;
    return stubCtx as unknown as RenderingContext;
  } as typeof HTMLCanvasElement.prototype.getContext;
}
