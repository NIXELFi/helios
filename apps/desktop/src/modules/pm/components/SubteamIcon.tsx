// Line-drawing identity marks for each subteam, picked by name/code. All icons
// are single-stroke (stroke=currentColor, fill=none) so they take the subteam
// color from `color`/CSS. The all-teams mark is a side-view formula car.

import type { CSSProperties, ReactElement, ReactNode } from "react";

export type SubteamGlyph =
  | "brakes"
  | "suspension"
  | "chassis"
  | "drivetrain"
  | "aero"
  | "driver"
  | "engine"
  | "data"
  | "ergonomics"
  | "gear"
  | "car";

interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}

function Svg({ size = 24, className, style, strokeWidth = 1.5, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {children}
    </svg>
  );
}

// Brake rotor + caliper.
function BrakesGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="12" r="8.2" />
      <circle cx="11" cy="12" r="3.1" />
      <circle cx="11" cy="6.4" r="0.7" />
      <circle cx="15.4" cy="9.6" r="0.7" />
      <circle cx="13.8" cy="15.2" r="0.7" />
      <circle cx="8.2" cy="15.2" r="0.7" />
      <circle cx="6.6" cy="9.6" r="0.7" />
      {/* caliper straddling the rim */}
      <path d="M16.2 7.7 h3.4 a1.4 1.4 0 0 1 1.4 1.4 v5.8 a1.4 1.4 0 0 1 -1.4 1.4 h-3.4" />
    </Svg>
  );
}

// Coil-over shock absorber.
function SuspensionGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="3.6" r="1.6" />
      <path d="M12 5.2 v3" />
      {/* coil spring */}
      <path d="M8.4 8.6 h7.2 M8.4 8.6 l7.2 2.2 M15.6 10.8 h-7.2 M8.4 10.8 l7.2 2.2 M15.6 13 h-7.2 M8.4 13 l7.2 2.2 M15.6 15.2 h-7.2" />
      {/* damper body + lower eye */}
      <path d="M9.6 15.2 v3 a2.4 2.4 0 0 0 4.8 0 v-3" />
      <circle cx="12" cy="20.4" r="1.6" />
    </Svg>
  );
}

// FSAE tube space-frame, side profile.
function ChassisGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 16 L7 16 L9 7.5 L13.5 7.5 L15.5 16 L21.5 16" />
      <path d="M7 16 L9.5 11 L13 11 L15.5 16" />
      <path d="M9 7.5 L9.5 11 M13.5 7.5 L13 11" />
      <path d="M9.5 11 L13.5 7.5 M13 11 L9 7.5" />
      <path d="M2.5 16 L4.5 12.5 L7 16" />
    </Svg>
  );
}

// Sprocket / drive cog.
function DrivetrainGlyph(p: IconProps) {
  // 8 teeth as short radial strokes outside the rim.
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    const r1 = 7.4, r2 = 9.2;
    const cx = 12, cy = 12;
    return `M${cx + Math.cos(a) * r1} ${cy + Math.sin(a) * r1} L${cx + Math.cos(a) * r2} ${cy + Math.sin(a) * r2}`;
  }).join(" ");
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="7.4" />
      <circle cx="12" cy="12" r="3" />
      <path d={teeth} />
    </Svg>
  );
}

// Airfoil / wing cross-section with endplate.
function AeroGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 13.5 C 8 8.5, 15 8, 20.5 11 C 16 12.5, 9 13.5, 3 13.5 Z" />
      <path d="M20.5 9.5 v6" />
      <path d="M5 16.5 C 9 15.5, 14 15.5, 18 16" strokeDasharray="1.4 2" />
    </Svg>
  );
}

// Steering wheel (driver interface).
function DriverGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 4 v3.2 M5.4 16 l3.6 -2.1 M18.6 16 l-3.6 -2.1" />
      <path d="M5 10.5 a 8.4 8.4 0 0 1 14 0" strokeDasharray="1.5 2" />
    </Svg>
  );
}

// Piston + connecting rod (engine / powertrain).
function EngineGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="8" y="3.5" width="8" height="6.5" rx="1" />
      <path d="M9.5 6 h5 M9.5 8 h5" />
      <path d="M12 10 v3.5" />
      <path d="M12 13.5 L8.5 19.5 M12 13.5 L15.5 19.5" />
      <circle cx="12" cy="20.4" r="1.4" />
    </Svg>
  );
}

// Oscilloscope waveform (data acquisition / electronics).
function DataGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M5.5 12 H8 l1.5 -4 l2.2 8 l1.8 -6 l1.4 2 H18.5" />
    </Svg>
  );
}

// Generic gear fallback.
function GearGlyph(p: IconProps) {
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    const cx = 12, cy = 12;
    return `M${cx + Math.cos(a) * 7} ${cy + Math.sin(a) * 7} L${cx + Math.cos(a) * 9} ${cy + Math.sin(a) * 9}`;
  }).join(" ");
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.6" />
      <path d={teeth} />
    </Svg>
  );
}

// Side-view open-wheel formula car (the whole-team mark).
function CarGlyph(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={p.strokeWidth ?? 1.4}>
      {/* wheels */}
      <circle cx="6.5" cy="16.5" r="3.3" />
      <circle cx="6.5" cy="16.5" r="1" />
      <circle cx="18.5" cy="16.5" r="3" />
      <circle cx="18.5" cy="16.5" r="0.9" />
      {/* body: rear deck → roll hoop → cockpit → nose */}
      <path d="M2 15 L3.2 15 L4.5 13.2 L9 13 L10.3 9.2 L13 9.2 L14 13 L15.6 13.2 L21.8 14.4 L22 15.6 L21.4 15.8 L21.5 16.5" />
      {/* roll hoop */}
      <path d="M10.3 9.2 C 10.6 7.4, 12.7 7.4, 13 9.2" />
      {/* rear wing */}
      <path d="M1.6 11.8 H4.4 M3 11.8 V14.4" />
      {/* front wing */}
      <path d="M21 17.4 H23.4 M21.4 16.4 H23.4" />
      {/* floor line between wheels */}
      <path d="M9.6 17 H15.4" strokeDasharray="1.4 2" />
    </Svg>
  );
}

const GLYPHS: Record<SubteamGlyph, (p: IconProps) => ReactElement> = {
  brakes: BrakesGlyph,
  suspension: SuspensionGlyph,
  chassis: ChassisGlyph,
  drivetrain: DrivetrainGlyph,
  aero: AeroGlyph,
  driver: DriverGlyph,
  engine: EngineGlyph,
  data: DataGlyph,
  ergonomics: DriverGlyph,
  gear: GearGlyph,
  car: CarGlyph,
};

// Resolve a subteam to a glyph by code first, then name keywords.
export function glyphForSubteam(name: string, code?: string | null): SubteamGlyph {
  const c = (code ?? "").toUpperCase();
  if (c === "BRK") return "brakes";
  if (c === "SUS") return "suspension";
  if (c === "CHA") return "chassis";
  if (c === "DRV") return "drivetrain";
  if (c === "ENG") return "engine";
  if (c === "AED" || c === "AEM") return "aero";
  if (c === "DRI") return "driver";
  if (c === "DAQ") return "data";

  const n = name.toLowerCase();
  if (n.includes("brake")) return "brakes";
  if (n.includes("suspension") || n.includes("damper")) return "suspension";
  if (n.includes("chassis") || n.includes("frame")) return "chassis";
  if (n.includes("drivetrain") || n.includes("driveline") || n.includes("powertrain")) return "drivetrain";
  if (n.includes("engine") || n.includes("power")) return "engine";
  if (n.includes("aero")) return "aero";
  if (n.includes("driver") || n.includes("interface") || n.includes("ergonom") || n.includes("cockpit")) return "driver";
  if (n.includes("data") || n.includes("acquisition") || n.includes("electr") || n.includes("sensor")) return "data";
  return "gear";
}

export function SubteamIcon({
  name,
  code,
  glyph,
  ...rest
}: IconProps & { name?: string; code?: string | null; glyph?: SubteamGlyph }) {
  const key = glyph ?? glyphForSubteam(name ?? "", code ?? null);
  const Glyph = GLYPHS[key];
  return <Glyph {...rest} />;
}

// The whole-team (all subteams) mark — a side-view formula car.
export function AllTeamsIcon(rest: IconProps) {
  return <CarGlyph {...rest} />;
}
