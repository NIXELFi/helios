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
  | "tire"
  | "battery"
  | "electrical"
  | "cooling"
  | "fuel"
  | "turbo"
  | "exhaust"
  | "wrench"
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

// Tire with tread blocks (tires & wheels).
function TireGlyph(p: IconProps) {
  const tread = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    const r1 = 5.8, r2 = 8.8;
    const cx = 12, cy = 12;
    return `M${cx + Math.cos(a) * r1} ${cy + Math.sin(a) * r1} L${cx + Math.cos(a) * r2} ${cy + Math.sin(a) * r2}`;
  }).join(" ");
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5.4" />
      <circle cx="12" cy="12" r="1.6" />
      <path d={tread} />
    </Svg>
  );
}

// Battery cell with +/- terminals (accumulator / HV pack).
function BatteryGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="8" width="16" height="9" rx="1.6" />
      <path d="M19 11 h2 v3 h-2" />
      <path d="M7 12.5 h2.6 M8.3 11.2 v2.6" />
      <path d="M13.4 12.5 h2.6" />
    </Svg>
  );
}

// Lightning bolt (electrical / wiring / harness).
function ElectricalGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 2 L6 13 H11 L10 22 L18 11 H13 L14 2 Z" />
    </Svg>
  );
}

// Radiator core with fins + coolant runs (cooling / thermal).
function CoolingGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.8" />
      <path d="M8 4.5 V19.5 M12 4.5 V19.5 M16 4.5 V19.5" />
      <path d="M3.5 9.5 H20.5 M3.5 14.5 H20.5" strokeDasharray="1.4 2" />
    </Svg>
  );
}

// Fuel droplet (fuel systems).
function FuelGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3 C 8.5 8.5, 5.5 12, 5.5 15.5 a6.5 6.5 0 1 0 13 0 C 18.5 12, 15.5 8.5, 12 3 Z" />
      <path d="M9 15.8 a3 3 0 0 0 2.4 2.9" />
    </Svg>
  );
}

// Turbocharger volute (snail) with outlet (intake / forced induction).
function TurboGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="13" r="7" />
      <path d="M11 13 m-3.6 0 a3.6 3.6 0 1 0 3.6 -3.6" />
      <circle cx="11" cy="13" r="1.4" />
      <path d="M16.4 8 L21.5 4.6 L21.5 8.4 L17.9 10.6" />
    </Svg>
  );
}

// Muffler + tailpipe with exhaust puffs (exhaust).
function ExhaustGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="11" width="11" height="6" rx="3" />
      <path d="M14 12 h5.5 v4 H14" />
      <circle cx="21" cy="9" r="1" />
      <circle cx="22.4" cy="6.6" r="0.8" />
    </Svg>
  );
}

// Wrench (manufacturing / machining / maintenance).
function WrenchGlyph(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14.7 6.3 a1 1 0 0 0 0 1.4 l1.6 1.6 a1 1 0 0 0 1.4 0 l3.77 -3.77 a6 6 0 0 1 -7.94 7.94 l-6.91 6.91 a2.12 2.12 0 0 1 -3 -3 l6.91 -6.91 a6 6 0 0 1 7.94 -7.94 z" />
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
  tire: TireGlyph,
  battery: BatteryGlyph,
  electrical: ElectricalGlyph,
  cooling: CoolingGlyph,
  fuel: FuelGlyph,
  turbo: TurboGlyph,
  exhaust: ExhaustGlyph,
  wrench: WrenchGlyph,
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
  if (c === "BAT" || c === "ACC") return "battery";
  if (c === "ELE" || c === "LV" || c === "HV") return "electrical";
  if (c === "COL" || c === "THM") return "cooling";
  if (c === "FUE") return "fuel";
  if (c === "INT" || c === "TRB") return "turbo";
  if (c === "EXH") return "exhaust";
  if (c === "MFG" || c === "MAN") return "wrench";
  if (c === "TIR" || c === "WHL") return "tire";

  const n = name.toLowerCase();
  if (n.includes("brake")) return "brakes";
  if (n.includes("suspension") || n.includes("damper")) return "suspension";
  if (n.includes("chassis") || n.includes("frame")) return "chassis";
  if (n.includes("drivetrain") || n.includes("driveline") || n.includes("powertrain")) return "drivetrain";
  if (n.includes("tire") || n.includes("tyre") || n.includes("wheel")) return "tire";
  if (n.includes("battery") || n.includes("accumulator")) return "battery";
  if (n.includes("electr") || n.includes("wiring") || n.includes("harness") || n.includes("voltage") || n.includes("circuit")) return "electrical";
  if (n.includes("cool") || n.includes("thermal") || n.includes("radiator") || n.includes("coolant")) return "cooling";
  if (n.includes("fuel")) return "fuel";
  if (n.includes("turbo") || n.includes("intake") || n.includes("induction") || n.includes("boost")) return "turbo";
  if (n.includes("exhaust")) return "exhaust";
  if (n.includes("manufactur") || n.includes("machin") || n.includes("fabricat") || n.includes("weld")) return "wrench";
  if (n.includes("engine") || n.includes("power")) return "engine";
  if (n.includes("aero")) return "aero";
  if (n.includes("driver") || n.includes("interface") || n.includes("ergonom") || n.includes("cockpit")) return "driver";
  if (n.includes("data") || n.includes("acquisition") || n.includes("sensor")) return "data";
  return "gear";
}

export function SubteamIcon({
  name,
  code,
  glyph,
  ...rest
}: IconProps & { name?: string; code?: string | null; glyph?: SubteamGlyph | string | null }) {
  // A stored override wins, but only when it's a glyph we actually know how to
  // draw — an unknown/stale key (e.g. one dropped from the bank) falls back to
  // the name/code-derived glyph instead of rendering nothing.
  const key: SubteamGlyph =
    glyph && glyph in GLYPHS ? (glyph as SubteamGlyph) : glyphForSubteam(name ?? "", code ?? null);
  const Glyph = GLYPHS[key];
  return <Glyph {...rest} />;
}

// The whole-team (all subteams) mark — a side-view formula car.
export function AllTeamsIcon(rest: IconProps) {
  return <CarGlyph {...rest} />;
}

// The glyphs offered in the subteam icon picker, in display order. Excludes the
// `car` whole-team mark and the `ergonomics` alias (it draws the same as driver).
export const PICKABLE_GLYPHS: SubteamGlyph[] = [
  "aero",
  "chassis",
  "suspension",
  "brakes",
  "tire",
  "drivetrain",
  "engine",
  "turbo",
  "exhaust",
  "fuel",
  "cooling",
  "electrical",
  "battery",
  "data",
  "driver",
  "wrench",
  "gear",
];

// Human labels for the picker (tooltip + aria).
export const GLYPH_LABELS: Record<SubteamGlyph, string> = {
  brakes: "Brakes",
  suspension: "Suspension",
  chassis: "Chassis",
  drivetrain: "Drivetrain",
  aero: "Aero",
  driver: "Driver / cockpit",
  engine: "Engine",
  data: "Data / electronics",
  tire: "Tires & wheels",
  battery: "Battery / accumulator",
  electrical: "Electrical / wiring",
  cooling: "Cooling / thermal",
  fuel: "Fuel",
  turbo: "Intake / turbo",
  exhaust: "Exhaust",
  wrench: "Manufacturing",
  ergonomics: "Ergonomics",
  gear: "General",
  car: "Whole team",
};
