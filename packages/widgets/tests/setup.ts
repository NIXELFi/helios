// jsdom does not implement matchMedia; stub it so uPlot can load at module
// evaluation time without throwing.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (_query: string) => ({
      matches: false,
      media: _query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom's HTMLCanvasElement.getContext is not implemented; stub it with a
// no-op 2d context so uPlot's internal draw loops don't throw uncaught errors.
if (typeof HTMLCanvasElement !== "undefined") {
  const noopCtx = new Proxy(
    {},
    {
      get: (_t, _p) => {
        // Return numeric 0 for properties like width/height, no-op fn for methods.
        return typeof _p === "string" && ["width", "height"].includes(_p) ? 0 : () => {};
      },
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype.getContext as unknown) = () => noopCtx as any;
}

// Stub Path2D which jsdom does not provide.
if (typeof (globalThis as Record<string, unknown>).Path2D === "undefined") {
  (globalThis as Record<string, unknown>).Path2D = class Path2D {
    moveTo() {}
    lineTo() {}
    closePath() {}
    arc() {}
    rect() {}
    addPath() {}
  };
}

// maplibre-gl bails at module-evaluation time in jsdom because it touches
// WebGL globals before any user code runs. Stub it with a minimal no-op Map
// class so the GPS widget tests can import the render module without
// triggering the WebGL initialization path. Real rendering is only exercised
// in the running app, not in the test environment.
import { vi } from "vitest";
vi.mock("maplibre-gl", () => {
  class FakeMap {
    on() { return this; }
    once() { return this; }
    off() { return this; }
    remove() {}
    resize() {}
    setStyle() {}
    fitBounds() {}
    project(_lnglat: [number, number]) { return { x: 0, y: 0 }; }
  }
  return {
    default: { Map: FakeMap },
    Map: FakeMap,
  };
});
