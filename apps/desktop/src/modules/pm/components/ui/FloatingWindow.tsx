"use client";

import { IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

export interface FloatingWindowProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  initialWidth?: number;
  initialHeight?: number;
}

const MIN_WIDTH = 360;
const MIN_HEIGHT = 280;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A non-modal, draggable, resizable panel that floats over the current view.
// The header is the drag handle; a bottom-right grip resizes. The body scrolls
// so the inner field layout keeps its proportions regardless of window size.
export function FloatingWindow({
  open,
  title,
  onClose,
  children,
  footer,
  initialWidth = 560,
  initialHeight = 620,
}: FloatingWindowProps) {
  const [box, setBox] = useState<Box | null>(null);
  // Tracks an in-flight drag or resize gesture.
  const gesture = useRef<
    | { kind: "move"; startX: number; startY: number; origX: number; origY: number }
    | { kind: "resize"; startX: number; startY: number; origW: number; origH: number }
    | null
  >(null);

  // Center the window the first time it opens (clamped to the viewport).
  useEffect(() => {
    if (!open) return;
    setBox((prev) => {
      if (prev) return prev;
      const w = Math.min(initialWidth, window.innerWidth - 32);
      const h = Math.min(initialHeight, window.innerHeight - 32);
      return {
        w,
        h,
        x: Math.max(16, (window.innerWidth - w) / 2),
        y: Math.max(16, (window.innerHeight - h) / 2),
      };
    });
  }, [open, initialWidth, initialHeight]);

  useEffect(() => {
    if (!open) return;
    function onMove(e: PointerEvent) {
      const g = gesture.current;
      if (!g) return;
      if (g.kind === "move") {
        const nx = g.origX + (e.clientX - g.startX);
        const ny = g.origY + (e.clientY - g.startY);
        setBox((b) =>
          b
            ? {
                ...b,
                x: Math.min(Math.max(0, nx), window.innerWidth - 80),
                y: Math.min(Math.max(0, ny), window.innerHeight - 40),
              }
            : b,
        );
      } else {
        const nw = g.origW + (e.clientX - g.startX);
        const nh = g.origH + (e.clientY - g.startY);
        setBox((b) =>
          b
            ? {
                ...b,
                w: Math.max(MIN_WIDTH, Math.min(nw, window.innerWidth - b.x - 8)),
                h: Math.max(MIN_HEIGHT, Math.min(nh, window.innerHeight - b.y - 8)),
              }
            : b,
        );
      }
    }
    function onUp() {
      gesture.current = null;
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [open]);

  if (!open || !box) return null;

  function startMove(e: React.PointerEvent) {
    if (!box) return;
    gesture.current = {
      kind: "move",
      startX: e.clientX,
      startY: e.clientY,
      origX: box.x,
      origY: box.y,
    };
    document.body.style.userSelect = "none";
  }

  function startResize(e: React.PointerEvent) {
    if (!box) return;
    e.stopPropagation();
    gesture.current = {
      kind: "resize",
      startX: e.clientX,
      startY: e.clientY,
      origW: box.w,
      origH: box.h,
    };
    document.body.style.userSelect = "none";
  }

  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed z-50 flex flex-col rounded-md border border-helios-line bg-helios-panel text-helios-text shadow-2xl"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <header
        onPointerDown={startMove}
        className="flex shrink-0 cursor-grab items-center justify-between gap-2 rounded-t-md border-b border-helios-line bg-helios-base/40 px-4 py-2.5 active:cursor-grabbing"
        style={{ touchAction: "none" }}
      >
        <h2 className="select-none text-sm font-medium">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Close"
          className="rounded p-1 text-helios-dim hover:bg-helios-base hover:text-helios-text"
        >
          <IconX size={16} strokeWidth={1.5} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

      {footer ? (
        <footer className="flex shrink-0 items-center justify-end gap-2 rounded-b-md border-t border-helios-line bg-helios-base/30 px-5 py-3">
          {footer}
        </footer>
      ) : null}

      {/* Resize grip */}
      <div
        onPointerDown={startResize}
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
        style={{ touchAction: "none" }}
        aria-hidden
      >
        <span className="absolute bottom-1 right-1 block h-2 w-2 border-b-2 border-r-2 border-helios-dim" />
      </div>
    </div>
  );
}
