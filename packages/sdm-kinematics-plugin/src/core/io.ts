// Project save/load (JSON) and sweep export (CSV). File I/O goes through
// Blob download / <input type=file> — no host permissions needed, the plugin
// stays pure-sandbox like COAST.

import { defaultCar, type CarSetup } from "./model";
import { channelDefs, type SweepResult } from "./sweep";

const FORMAT = 1;

export function serializeProject(car: CarSetup): string {
  return JSON.stringify({ format: FORMAT, tool: "sdm-kinematics", car }, null, 2);
}

export function parseProject(text: string): CarSetup {
  const obj = JSON.parse(text);
  if (obj?.tool !== "sdm-kinematics" || !obj.car) throw new Error("not an SDM Kinematics project file");
  // Merge onto defaults so files from older versions stay loadable.
  const d = defaultCar();
  const car = obj.car as CarSetup;
  return {
    name: typeof car.name === "string" ? car.name : d.name,
    front: { ...d.front, ...car.front },
    rear: { ...d.rear, ...car.rear },
    params: { ...d.params, ...car.params },
    opk: car.opk ?? null,
  };
}

export function sweepToCsv(res: SweepResult): string {
  const defs = channelDefs();
  const head = [`${res.paramLabel} (${res.paramUnit})`, ...defs.map((d) => `${d.label} (${d.unit})`)];
  const rows = [head.join(",")];
  for (let i = 0; i < res.values.length; i++) {
    const row = [res.values[i].toFixed(4)];
    for (const d of defs) {
      const v = res.series.get(d.key)![i];
      row.push(Number.isFinite(v) ? v.toFixed(5) : "");
    }
    rows.push(row.join(","));
  }
  return rows.join("\n");
}

export function download(name: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
