// Team simulation-data folder: one folder convention the lap sim can load
// automatically, so measured data drives the model without hand-importing
// each file. Structure (folder names case-insensitive):
//
//   <Simulation Data>/
//     tire/<name>.tir            Pacejka MF tire fit (first match, or the
//                                one whose name mentions the car)
//     aero/<car>-aero-map.csv    Helios aero map v1 (see aeroMap.ts); car
//                                match by filename, else first *.csv
//
// All of it is proprietary team data — loaded at runtime from the user's
// disk, never shipped in the repo. The folder path persists in app state so
// the data auto-applies on the next launch.

import { readDir, readTextFile } from "@tauri-apps/plugin-fs";

import { distillTir, type TirGrip } from "./tir";
import { parseAeroMap, distillAero, type AeroNominal } from "./aeroMap";

export interface TeamData {
  dir: string;
  tire: TirGrip | null;
  tireFile: string | null;
  aero: (AeroNominal & { label: string }) | null;
  aeroFile: string | null;
  /** Non-fatal notes (missing folders, unparsable files). */
  notes: string[];
}

const sep = (dir: string) => (dir.includes("\\") ? "\\" : "/");

async function listDir(path: string): Promise<string[]> {
  try {
    const entries = await readDir(path);
    return entries.filter((e) => !e.isDirectory).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Pick the file whose name mentions `car` (case-insensitive), else the
 *  first one. */
function pick(files: string[], car: string): string | null {
  if (files.length === 0) return null;
  const lc = car.toLowerCase();
  return files.find((f) => f.toLowerCase().includes(lc)) ?? files[0]!;
}

/** Scan a team simulation-data folder and distill everything the lap sim can
 *  use. `car` (e.g. "SDM26") steers file selection when a folder holds data
 *  for several cars. Throws only on a completely unreadable root. */
export async function loadTeamData(dir: string, car: string): Promise<TeamData> {
  const s = sep(dir);
  const notes: string[] = [];
  const out: TeamData = { dir, tire: null, tireFile: null, aero: null, aeroFile: null, notes };

  const tireDir = `${dir}${s}tire`;
  const tirFiles = (await listDir(tireDir)).filter((f) => f.toLowerCase().endsWith(".tir"));
  const tirPick = pick(tirFiles, car);
  if (tirPick) {
    try {
      out.tire = distillTir(await readTextFile(`${tireDir}${s}${tirPick}`), tirPick);
      out.tireFile = tirPick;
    } catch (e) {
      notes.push(`tire/${tirPick}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    notes.push("no tire/*.tir found");
  }

  const aeroDir = `${dir}${s}aero`;
  const csvFiles = (await listDir(aeroDir)).filter((f) => f.toLowerCase().endsWith(".csv"));
  const aeroPick = pick(csvFiles, car);
  if (aeroPick) {
    try {
      const map = parseAeroMap(await readTextFile(`${aeroDir}${s}${aeroPick}`), aeroPick);
      out.aero = { ...distillAero(map), label: aeroPick };
      out.aeroFile = aeroPick;
    } catch (e) {
      notes.push(`aero/${aeroPick}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    notes.push("no aero/*.csv found (canonical: <car>-aero-map.csv)");
  }

  return out;
}
