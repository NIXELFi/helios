import { useEffect, useRef } from "react";
import type { WidgetRenderProps } from "../types";
import { sampleAt } from "../lib/sample-at";
import { setupCanvas, canvasLogicalSize } from "../lib/canvas-helpers";
import wheelAssetUrl from "./assets/wheel.png";

// Module-level singleton — every instance reuses the same decoded bitmap.
const wheelImage: HTMLImageElement = new Image();
let wheelImageReady = false;
const wheelReadyListeners = new Set<() => void>();
wheelImage.onload = () => {
  wheelImageReady = true;
  wheelReadyListeners.forEach((fn) => fn());
  wheelReadyListeners.clear();
};
wheelImage.src = wheelAssetUrl;

export interface SteeringWheelConfig {
  channelId: string;
  /** Steering wheel angle in degrees that represents full lock (the value
   *  the displayed wheel reaches at the edge of its scale). Doubles as the
   *  warning/limit ring radius. Typical FSAE: 90–120°. */
  maxAngle: number;
  /** Display units suffix after the numeric readout. Usually "°". */
  units: string;
  /** Invert sign so positive channel values display as the opposite
   *  rotation. Useful when the data convention disagrees with what the
   *  driver intuitively expects (e.g. positive = left vs right). */
  invert: boolean;
}

export function SteeringWheelRender(props: WidgetRenderProps<SteeringWheelConfig>) {
  const { config, slice, cursorEmitter } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valueRef = useRef<number | null>(sampleAt(slice, config.channelId, cursorEmitter.get()));

  useEffect(() => {
    const off = cursorEmitter.subscribe((t) => {
      valueRef.current = sampleAt(slice, config.channelId, t);
      draw();
    });
    return off;
  }, [slice, config, cursorEmitter]);

  useEffect(() => { draw(); }, [config]);

  // If the wheel asset is still decoding when this widget mounts, redraw once
  // it's ready so the wheel actually appears (not just the readout).
  useEffect(() => {
    if (wheelImageReady) return;
    const fn = () => draw();
    wheelReadyListeners.add(fn);
    return () => { wheelReadyListeners.delete(fn); };
  }, []);

  function draw() {
    const c = canvasRef.current; if (!c) return;
    const ctx = setupCanvas(c);
    const { w, h } = canvasLogicalSize(c);
    ctx.clearRect(0, 0, w, h);

    const v = valueRef.current;
    const angle = v ?? 0;
    const displayAngle = config.invert ? -angle : angle;

    const cx = w / 2;
    // Push the wheel slightly upward to leave room for the readout.
    const cy = h * 0.46;
    const r = Math.max(8, Math.min(w, h) * 0.36);

    // Limit ring (faint) — shows where ±maxAngle lives, doubles as scale.
    ctx.strokeStyle = "#23252B";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
    ctx.stroke();

    // Tick marks at ±maxAngle (limits) and 0 (centered)
    const drawTickAt = (deg: number, color: string) => {
      const a = (deg - 90) * Math.PI / 180;  // -90 so 0° is at the top
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r + 4), cy + Math.sin(a) * (r + 4));
      ctx.lineTo(cx + Math.cos(a) * (r + 12), cy + Math.sin(a) * (r + 12));
      ctx.stroke();
    };
    drawTickAt(0, "#5A5F66");                            // straight ahead
    drawTickAt(-config.maxAngle, "#FFB800");             // left limit
    drawTickAt(config.maxAngle, "#FFB800");              // right limit

    // The wheel itself, rotated by the steering input. Drawn from a stylized
    // PNG of the actual Helios wheel; sized so its bounding box matches the
    // limit ring so the asset visually replaces the old vector rim+spokes.
    if (wheelImageReady) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(displayAngle * Math.PI / 180);
      const size = r * 2.2;
      ctx.drawImage(wheelImage, -size / 2, -size / 2, size, size);
      ctx.restore();
    }

    // Numeric readout below the wheel.
    const overLimit = v !== null && Math.abs(displayAngle) > config.maxAngle;
    ctx.fillStyle = overLimit ? "#EF5350" : "#D8DCE2";
    ctx.font = `${Math.max(14, r * 0.35)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const sign = displayAngle > 0 ? "+" : displayAngle < 0 ? "−" : " ";
    const text = v === null ? "—" : `${sign}${Math.abs(displayAngle).toFixed(0)}${config.units}`;
    ctx.fillText(text, cx, cy + r + 24);

    // Title strip (channel id) + L / R labels under the rim
    ctx.fillStyle = "#7B8088";
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(config.channelId.toUpperCase(), 6, 6);

    ctx.textAlign = "center";
    ctx.fillText("L", cx - r - 18, cy + 4);
    ctx.fillText("R", cx + r + 18, cy + 4);
  }

  return <canvas ref={canvasRef} className="w-full h-full bg-[#16171B]" />;
}
