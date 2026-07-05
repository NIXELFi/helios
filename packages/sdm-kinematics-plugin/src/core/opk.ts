// OptimumKinematics points-file interop.
//
// Import: the OptimumK Excel export ("Vehicle Setup" + "Front/Rear
// Suspension" sheets, Double A-Arm + Push Pull layout — the format of
// SDM26 V1.4.x) and an equivalent JSON layout.
// Export: an SDM-flavoured Excel points file in the same sheet layout, and
// the OpK-layout JSON. The model is symmetric (left side, mirrored); raw
// right-side values from an import are preserved in `car.opk` so nothing is
// lost on round-trip even when they differ slightly from the mirror.

import * as XLSX from "xlsx";
import { type V3, deg, rad, unit, sub } from "./vec";
import {
  defaultCar, mirrorPoint, roundCoord, roundPoint, type AxleGeometry, type CarSetup,
} from "./model";

/** model key ⇄ OptimumK point name (per suspension sheet). */
export const OPK_POINT_NAMES: [keyof AxleGeometry, string, "aarm" | "pushpull" | "ubar"][] = [
  ["lcaFront", "CHAS_LowFor", "aarm"],
  ["lcaRear", "CHAS_LowAft", "aarm"],
  ["ucaFront", "CHAS_UppFor", "aarm"],
  ["ucaRear", "CHAS_UppAft", "aarm"],
  ["lbj", "UPRI_LowPnt", "aarm"],
  ["ubj", "UPRI_UppPnt", "aarm"],
  ["tieInner", "CHAS_TiePnt", "aarm"],
  ["tieOuter", "UPRI_TiePnt", "aarm"],
  ["pushLower", "NSMA_PPAttPnt", "pushpull"],
  ["shockChassis", "CHAS_AttPnt", "pushpull"],
  ["rockerAxis1", "CHAS_RocAxi", "pushpull"],
  ["rockerAxis2", "CHAS_RocPiv", "pushpull"],
  ["pushUpper", "ROCK_RodPnt", "pushpull"],
  ["shockRocker", "ROCK_CoiPnt", "pushpull"],
  ["ubarNsma", "NSMA_UBarAttPnt", "ubar"],
  ["ubarArm", "UBAR_AttPnt", "ubar"],
  ["ubarPivot", "CHAS_PivPnt", "ubar"],
];

export function opkName(key: keyof AxleGeometry): string {
  return OPK_POINT_NAMES.find(([k]) => k === key)?.[1] ?? String(key);
}

interface OpkWheels {
  halfTrack: number;
  lonOffset: number;
  latOffset: number;
  vertOffset: number;
  staticCamber: number;
  staticToe: number;
  rimDiameter: number;
  tireDiameter: number;
  tireWidth: number;
}

export interface OpkImportResult {
  car: CarSetup;
  warnings: string[];
}

type Row = (string | number | null | undefined)[];

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Wheel spin axis (left side, outboard) from static camber/toe in degrees.
 *  Inverse of the channel formulas: camber = −asin(a_z), toe = −heading. */
function axisFromCamberToe(camberDeg: number, toeDeg: number): V3 {
  const a = -rad(camberDeg); // a_z = sin(a) = −sin(camber)
  const b = -rad(toeDeg);
  return [-Math.cos(a) * Math.sin(b), Math.cos(a) * Math.cos(b), Math.sin(a)];
}

/** Static camber/toe (deg) back out of the stored wheel axis (left side). */
export function camberToeFromAxis(wheelCenter: V3, wheelAxisOuter: V3): { camber: number; toe: number } {
  const a = unit(sub(wheelAxisOuter, wheelCenter));
  const camber = -deg(Math.asin(Math.max(-1, Math.min(1, a[2]))));
  const toe = -deg(Math.atan2(-a[0], a[1])); // heading of a×ẑ, small-angle exact
  return { camber, toe };
}

function parseSuspensionSheet(rows: Row[], axleLabel: string, warnings: string[]) {
  const left = new Map<string, V3>();
  const right = new Map<string, V3>();
  let wheels: Partial<OpkWheels> = {};
  let steeringRatio: number | null = null;
  let tierodAttachment = "";
  let ppAttachedTo = "";
  let ubarAttachedTo = "";
  const raw: Record<string, unknown> = {};

  const wheelKeys: [keyof OpkWheels, string][] = [
    ["halfTrack", "Half Track"],
    ["lonOffset", "Longitudinal Offset"],
    ["latOffset", "Lateral Offset"],
    ["vertOffset", "Vertical Offset"],
    ["staticCamber", "Static Camber"],
    ["staticToe", "Static Toe"],
    ["rimDiameter", "Rim Diameter"],
    ["tireDiameter", "Tire Diameter"],
    ["tireWidth", "Tire Width"],
  ];

  for (const row of rows) {
    const b = str(row[1]);
    if (!b) continue;
    // Point rows: name in B, left XYZ in C..E, right XYZ in G..I.
    const base = b.replace(/_L$/, "");
    if (OPK_POINT_NAMES.some(([, n]) => n === base)) {
      const lx = num(row[2]), ly = num(row[3]), lz = num(row[4]);
      const rx = num(row[6]), ry = num(row[7]), rz = num(row[8]);
      if (lx !== null && ly !== null && lz !== null) left.set(base, [lx, ly, lz]);
      if (rx !== null && ry !== null && rz !== null) right.set(base, [rx, ry, rz]);
      continue;
    }
    for (const [key, label] of wheelKeys) {
      if (b === label) {
        const v = num(row[2]);
        if (v !== null) wheels[key] = v;
      }
    }
    if (b === "Steering Ratio") steeringRatio = num(row[2]);
    if (b === "Tierod Attachment") tierodAttachment = str(row[2]);
    if (b === "Spring") raw[`stiffness_${b}`] = { left: row[3], middle: row[5], right: row[7] };
  }

  // Attachment section: the row layout is A="Attachment", then rows with
  // B=element, C=point, D=group, E=member (e.g. UpperAArm, Rocker). Scan it.
  for (let i = 0; i < rows.length; i++) {
    if (str(rows[i][0]) === "Attachment") {
      for (let j = i + 1; j < Math.min(i + 6, rows.length); j++) {
        if (str(rows[j][1]) === "Push Pull") {
          ppAttachedTo = str(rows[j][4]) || str(rows[j][3]);
        }
        if (str(rows[j][1]) === "U-Bar") {
          ubarAttachedTo = str(rows[j][4]) || str(rows[j][3]);
        }
      }
    }
    if (str(rows[i][0]) === "Stiffness") {
      for (let j = i + 1; j < Math.min(i + 4, rows.length); j++) {
        const el = str(rows[j][1]);
        if (el) raw[`stiffness_${el}`] = { left: rows[j][3], middle: rows[j][5], right: rows[j][7] };
      }
    }
  }

  const missing = OPK_POINT_NAMES.filter(([, n]) => !left.has(n)).map(([, n]) => n);
  if (missing.length) warnings.push(`${axleLabel}: missing points ${missing.join(", ")} — defaults kept`);

  // Report meaningful L/R asymmetry (beyond the mirror) so nobody is surprised.
  const asym: string[] = [];
  for (const [name, lp] of left) {
    const rp = right.get(name);
    if (!rp) continue;
    const m = mirrorPoint(lp);
    const d = Math.hypot(m[0] - rp[0], m[1] - rp[1], m[2] - rp[2]);
    if (d > 0.05) asym.push(`${name} (Δ${d.toFixed(3)}")`);
  }
  if (asym.length) {
    warnings.push(`${axleLabel}: right side differs from mirrored left: ${asym.join(", ")}. ` +
      `Model uses the LEFT side mirrored; raw right values are preserved for export.`);
  }

  return { left, right, wheels, steeringRatio, tierodAttachment, ppAttachedTo, ubarAttachedTo, raw };
}

function hostFromAttachment(att: string, fallback: "rocker" | "lca"): "rocker" | "lca" | "uca" | "upright" {
  const a = att.toLowerCase();
  if (a.includes("rocker")) return "rocker";
  if (a.includes("upper")) return "uca";
  if (a.includes("lower")) return "lca";
  if (a.includes("upright")) return "upright";
  return fallback;
}

function applyToAxle(
  target: AxleGeometry,
  p: ReturnType<typeof parseSuspensionSheet>,
): AxleGeometry {
  const g = { ...target };
  for (const [key, name] of OPK_POINT_NAMES) {
    const v = p.left.get(name);
    if (v) (g[key] as V3) = roundPoint(v);
  }
  const w = p.wheels;
  if (w.halfTrack !== undefined && w.tireDiameter !== undefined) {
    const wc: V3 = roundPoint([
      (w.lonOffset ?? 0),
      w.halfTrack + (w.latOffset ?? 0),
      w.tireDiameter / 2 + (w.vertOffset ?? 0),
    ]);
    g.wheelCenter = wc;
    // wheelAxisOuter is derived (encodes static camber/toe), not an OpK
    // point — kept at full precision so the angles survive exactly.
    const axis = axisFromCamberToe(w.staticCamber ?? 0, w.staticToe ?? 0);
    g.wheelAxisOuter = [wc[0] + 2 * axis[0], wc[1] + 2 * axis[1], wc[2] + 2 * axis[2]];
  }
  const pp = hostFromAttachment(p.ppAttachedTo, "lca");
  g.pushrodOn = pp === "rocker" ? "lca" : pp;
  g.ubarOn = hostFromAttachment(p.ubarAttachedTo, "rocker");
  return g;
}

function parseVehicleSetup(rows: Row[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  const keys = [
    "Reference Distance", "Brake Bias", "Drive Bias",
    "Front Mass Distribution", "Left Mass Distribution", "Center of Gravity Height",
  ];
  for (const row of rows) {
    const b = str(row[1]);
    if (b === "Name:") out["Name"] = str(row[2]);
    const v = num(row[2]);
    if (v !== null && keys.includes(b)) out[b] = v;
  }
  return out;
}

/** Import an OptimumK Excel points file (.xlsx ArrayBuffer). */
export function importOpkExcel(buf: ArrayBuffer): OpkImportResult {
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = (name: RegExp): Row[] | null => {
    const found = wb.SheetNames.find((n) => name.test(n));
    return found ? (XLSX.utils.sheet_to_json(wb.Sheets[found], { header: 1, defval: null }) as Row[]) : null;
  };
  const frontRows = sheet(/front/i);
  const rearRows = sheet(/rear/i);
  const setupRows = sheet(/vehicle|setup/i);
  if (!frontRows || !rearRows) {
    throw new Error("expected 'Front Suspension' and 'Rear Suspension' sheets (OptimumK points export)");
  }

  const warnings: string[] = [];
  const car = defaultCar();
  const pf = parseSuspensionSheet(frontRows, "Front", warnings);
  const pr = parseSuspensionSheet(rearRows, "Rear", warnings);
  car.front = applyToAxle(car.front, pf);
  car.rear = applyToAxle(car.rear, pr);

  const setup = setupRows ? parseVehicleSetup(setupRows) : {};
  if (typeof setup["Name"] === "string" && setup["Name"]) car.name = setup["Name"] as string;
  if (typeof setup["Center of Gravity Height"] === "number") car.params.cgHeight = setup["Center of Gravity Height"] as number;
  if (typeof setup["Brake Bias"] === "number") car.params.brakeBiasFront = (setup["Brake Bias"] as number) / 100;
  if (typeof pf.wheels.tireDiameter === "number") car.params.tireRadius = pf.wheels.tireDiameter / 2;
  if (typeof pf.wheels.tireWidth === "number") car.params.tireWidth = pf.wheels.tireWidth;

  // Preserve everything the solver doesn't model for lossless round-trip.
  car.opk = {
    vehicleSetup: setup,
    steeringRatioFront: pf.steeringRatio,
    tierodAttachmentRear: pr.tierodAttachment,
    wheelsFront: pf.wheels,
    wheelsRear: pr.wheels,
    rawFront: pf.raw,
    rawRear: pr.raw,
    rawRight: {
      front: Object.fromEntries(pf.right),
      rear: Object.fromEntries(pr.right),
    },
  };
  return { car, warnings };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function axleRows(car: CarSetup, axle: "front" | "rear"): Row[] {
  const g = car[axle];
  const opk = (car.opk ?? {}) as Record<string, any>;
  const wheelsSaved = opk[axle === "front" ? "wheelsFront" : "wheelsRear"] ?? {};
  const { camber, toe } = camberToeFromAxis(g.wheelCenter, g.wheelAxisOuter);
  const rawRight: Record<string, V3> = opk.rawRight?.[axle] ?? {};

  const pointRow = (key: keyof AxleGeometry, name: string): Row => {
    const l = roundPoint(g[key] as V3);
    const r = roundPoint(rawRight[name] ?? mirrorPoint(g[key] as V3));
    return [null, name, l[0], l[1], l[2], null, r[0], r[1], r[2]];
  };
  const hostLabel = (h: string) =>
    h === "rocker" ? "Rocker" : h === "uca" ? "UpperAArm" : h === "lca" ? "LowerAArm" : "Upright";

  const rows: Row[] = [
    [null, "Name:", `${car.name} - ${axle === "front" ? "Front" : "Rear"}`],
    [null, "Type:", "Suspension", "Created by:", "SDM Kinematics (Helios)"],
    [null, "Version:", "SDM-1", "Exported:", new Date().toISOString()],
    [],
    ["User Options", "Length", "inch", "in"],
    [null, "Angle", "degree", "deg"],
    [],
    ["Double A-Arm", "Point Name", "Left", null, null, null, "Right"],
    [null, null, "X", "Y", "Z", null, "X", "Y", "Z"],
    ...OPK_POINT_NAMES.filter(([, , sec]) => sec === "aarm").map(([k, n]) => pointRow(k, n)),
    [],
    ["Push Pull", "Point Name", "Left", null, null, null, "Right"],
    [null, null, "X", "Y", "Z", null, "X", "Y", "Z"],
    ...OPK_POINT_NAMES.filter(([, , sec]) => sec === "pushpull").map(([k, n]) => pointRow(k, n)),
    [],
    ["U-Bar", "Point Name", "Left", null, null, null, "Right"],
    [null, null, "X", "Y", "Z", null, "X", "Y", "Z"],
    ...OPK_POINT_NAMES.filter(([, , sec]) => sec === "ubar").map(([k, n]) => pointRow(k, n)),
    [],
    ["Wheels", "Point Name", "Left", null, null, null, "Right"],
    [null, "Half Track", roundCoord(g.wheelCenter[1]), null, null, null, roundCoord(g.wheelCenter[1])],
    [null, "Longitudinal Offset", roundCoord(g.wheelCenter[0]), null, null, null, roundCoord(g.wheelCenter[0])],
    [null, "Lateral Offset", 0, null, null, null, 0],
    [null, "Vertical Offset", roundCoord(g.wheelCenter[2] - car.params.tireRadius), null, null, null, roundCoord(g.wheelCenter[2] - car.params.tireRadius)],
    [null, "Static Camber", camber, null, null, null, camber],
    [null, "Static Toe", toe, null, null, null, toe],
    [null, "Rim Diameter", wheelsSaved.rimDiameter ?? 10, null, null, null, wheelsSaved.rimDiameter ?? 10],
    [null, "Tire Diameter", 2 * car.params.tireRadius, null, null, null, 2 * car.params.tireRadius],
    [null, "Tire Width", car.params.tireWidth, null, null, null, car.params.tireWidth],
    [],
    ["Attachment", "Element", null, "Attached To"],
    [null, "Push Pull", "NSMA_PPAttPnt", "Double A-Arm", hostLabel(g.pushrodOn)],
    [null, "U-Bar", "NSMA_UBarAttPnt", g.ubarOn === "rocker" ? "Push Pull" : "Double A-Arm", hostLabel(g.ubarOn)],
  ];
  if (axle === "front" && opk.steeringRatioFront != null) {
    rows.push([], ["Rack Pinion", "Steering Ratio", opk.steeringRatioFront]);
  }
  if (axle === "rear" && opk.tierodAttachmentRear) {
    rows.push([], [null, "Tierod Attachment", opk.tierodAttachmentRear]);
  }
  return rows;
}

/** Export the SDM-specific Excel points file (OptimumK sheet layout + an
 *  "SDM Params" sheet carrying the solver-side vehicle parameters). */
export function exportSdmExcel(car: CarSetup): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const opk = (car.opk ?? {}) as Record<string, any>;
  const setup = opk.vehicleSetup ?? {};

  const vRows: Row[] = [
    [null, "Name:", car.name],
    [null, "Type:", "Vehicle Setup", "Created by:", "SDM Kinematics (Helios)"],
    [null, "Exported:", new Date().toISOString()],
    [],
    ["User Options", "Length", "inch", "in"],
    [null, "Angle", "degree", "deg"],
    [],
    ["Setup", "Front Suspension", `${car.name} - Front`],
    [null, "Rear Suspension", `${car.name} - Rear`],
    [null, "Reference Distance", setup["Reference Distance"] ?? 0],
    [null, "Brake Bias", car.params.brakeBiasFront * 100],
    [null, "Drive Bias", setup["Drive Bias"] ?? 0],
    [null, "Front Mass Distribution", setup["Front Mass Distribution"] ?? 50],
    [null, "Left Mass Distribution", setup["Left Mass Distribution"] ?? 50],
    [null, "Center of Gravity Height", car.params.cgHeight],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(vRows as any), "Vehicle Setup");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(axleRows(car, "front") as any), "Front Suspension");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(axleRows(car, "rear") as any), "Rear Suspension");

  const sRows: Row[] = [
    ["SDM Params", "Value", "Unit"],
    ["Tire radius", car.params.tireRadius, "in"],
    ["Tire width", car.params.tireWidth, "in"],
    ["Spring rate front", car.params.springRateFront, "lb/in"],
    ["Spring rate rear", car.params.springRateRear, "lb/in"],
    ["CG height", car.params.cgHeight, "in"],
    ["Brake bias front", car.params.brakeBiasFront, "0-1"],
    ["Pushrod on (front)", car.front.pushrodOn, ""],
    ["Pushrod on (rear)", car.rear.pushrodOn, ""],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sRows as any), "SDM Params");

  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// OpK-layout JSON
// ---------------------------------------------------------------------------

export function exportOpkJson(car: CarSetup): string {
  const axleObj = (axle: "front" | "rear") => {
    const g = car[axle];
    const opk = (car.opk ?? {}) as Record<string, any>;
    const rawRight: Record<string, V3> = opk.rawRight?.[axle] ?? {};
    const points: Record<string, { left: V3; right: V3 }> = {};
    for (const [k, n] of OPK_POINT_NAMES) {
      const l = g[k] as V3;
      points[n] = { left: roundPoint(l), right: roundPoint(rawRight[n] ?? mirrorPoint(l)) };
    }
    const { camber, toe } = camberToeFromAxis(g.wheelCenter, g.wheelAxisOuter);
    return {
      points,
      wheels: {
        halfTrack: g.wheelCenter[1],
        lonOffset: g.wheelCenter[0],
        latOffset: 0,
        vertOffset: g.wheelCenter[2] - car.params.tireRadius,
        staticCamber: camber,
        staticToe: toe,
        tireDiameter: 2 * car.params.tireRadius,
        tireWidth: car.params.tireWidth,
      },
      attachment: { pushPull: g.pushrodOn, uBar: g.ubarOn },
    };
  };
  return JSON.stringify({
    format: "sdm-opk-points",
    version: 1,
    name: car.name,
    vehicleSetup: {
      brakeBias: car.params.brakeBiasFront * 100,
      cgHeight: car.params.cgHeight,
      ...(car.opk as any)?.vehicleSetup,
    },
    front: axleObj("front"),
    rear: axleObj("rear"),
    opkExtras: car.opk ?? null,
  }, null, 2);
}

export function importOpkJson(text: string): OpkImportResult {
  const obj = JSON.parse(text);
  if (obj?.format !== "sdm-opk-points") throw new Error("not an sdm-opk-points JSON file");
  const warnings: string[] = [];
  const car = defaultCar();
  if (typeof obj.name === "string") car.name = obj.name;

  const applyAxle = (axle: "front" | "rear") => {
    const a = obj[axle];
    if (!a?.points) return;
    const g = { ...car[axle] };
    for (const [k, n] of OPK_POINT_NAMES) {
      const p = a.points[n]?.left;
      if (Array.isArray(p) && p.length === 3 && p.every((v: unknown) => Number.isFinite(v))) {
        (g[k] as V3) = roundPoint([p[0], p[1], p[2]]);
      }
    }
    const w = a.wheels;
    if (w && Number.isFinite(w.halfTrack) && Number.isFinite(w.tireDiameter)) {
      const wc: V3 = [w.lonOffset ?? 0, w.halfTrack + (w.latOffset ?? 0), w.tireDiameter / 2 + (w.vertOffset ?? 0)];
      g.wheelCenter = wc;
      const axis = axisFromCamberToe(w.staticCamber ?? 0, w.staticToe ?? 0);
      g.wheelAxisOuter = [wc[0] + 2 * axis[0], wc[1] + 2 * axis[1], wc[2] + 2 * axis[2]];
    }
    const att = String(a.attachment?.pushPull ?? "lca");
    g.pushrodOn = att === "uca" || att === "lca" || att === "upright" ? att : "lca";
    const ub = String(a.attachment?.uBar ?? "rocker");
    g.ubarOn = ub === "rocker" || ub === "uca" || ub === "lca" || ub === "upright" ? ub : "rocker";
    car[axle] = g;
  };
  applyAxle("front");
  applyAxle("rear");

  if (Number.isFinite(obj.vehicleSetup?.cgHeight)) car.params.cgHeight = obj.vehicleSetup.cgHeight;
  if (Number.isFinite(obj.vehicleSetup?.brakeBias)) car.params.brakeBiasFront = obj.vehicleSetup.brakeBias / 100;
  if (Number.isFinite(obj.front?.wheels?.tireDiameter)) car.params.tireRadius = obj.front.wheels.tireDiameter / 2;
  if (Number.isFinite(obj.front?.wheels?.tireWidth)) car.params.tireWidth = obj.front.wheels.tireWidth;
  if (obj.opkExtras && typeof obj.opkExtras === "object") car.opk = obj.opkExtras;
  return { car, warnings };
}
