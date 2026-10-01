// Which car and subteam an Airtable CSV export belongs to, from its file and
// folder names. Airtable names each export "<tab>-Grid view.csv" (with " (1)"
// when downloaded twice), and the CFO keeps each base's exports in a folder
// ("IC Team", "EV Team"). Tab names are typed by hand, so "Brakess" is
// Brakes and "DI" is Driver Interface. Pure functions, no React.

import type { Project, Subteam } from "./api";

const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Short or old tab names -> subteam names.
const ALIASES: Record<string, string> = {
  di: "driver interface", "driver int": "driver interface", daq: "data aq", "data acquisition": "data aq",
  accumulator: "battery", accum: "battery", lv: "low voltage", hv: "high voltage", ops: "operations",
  mfg: "manufacturing", overall: "overall team", team: "overall team", "team wide": "overall team", susp: "suspension",
};

/** "IC Team/Aero-Grid view (1).csv" -> "Aero" */
export function tabName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.csv$/i, "").replace(/\s*\(\d+\)\s*$/, "").replace(/-\s*grid view$/i, "").replace(/\s*\(\d+\)\s*$/, "").trim();
}

export function guessSubteam(path: string, subteams: Pick<Subteam, "id" | "name" | "code">[]): string | null {
  const t = letters(tabName(path));
  if (!t) return null;
  const want = ALIASES[t] ?? t;
  const byName = (n: string) => subteams.find((s) => letters(s.name) === n);
  return byName(want)?.id
    ?? subteams.find((s) => letters(s.code) === t)?.id
    // a doubled last letter ("Brakess", "Chassiss") or a plural
    ?? subteams.find((s) => { const n = letters(s.name); return n.length >= 4 && (want.startsWith(n) || n.startsWith(want)) && Math.abs(n.length - want.length) <= 2; })?.id
    ?? null;
}

const isEv = (p: Pick<Project, "car_code" | "name">) => /\bev\b|electric|\d+e\b/i.test(`${p.car_code} ${p.name}`);

/** The car from the folder or file name ("EV Team", "IC Team"), else null. */
export function guessCar(path: string, projects: Pick<Project, "id" | "car_code" | "name">[]): string | null {
  const p = path.replace(/[_-]/g, " ");
  const ev = projects.filter(isEv);
  const ic = projects.filter((x) => !isEv(x));
  for (const x of projects) if (new RegExp(`\\b${x.car_code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(p)) return x.id;
  // Helios also keeps past cars and other projects, so narrow down by name
  const named = (xs: typeof projects, re: RegExp) => {
    const hits = xs.filter((x) => re.test(`${x.car_code} ${x.name}`));
    return xs.length > 1 && hits.length ? hits : xs;
  };
  const evs = named(ev, /\bev\b|electric/i);
  if (/\bev\b|electric/i.test(p)) return evs.length === 1 ? evs[0]!.id : null;
  if (/\bic\b|combustion|\bice\b/i.test(p)) {
    const ics = named(ic, /\bic\b|combustion/i);
    if (ics.length === 1) return ics[0]!.id;
    // the IC car shares the EV car's code without the "e" (SDM27 / SDM27e)
    const twin = evs.length === 1 ? ics.find((x) => `${x.car_code}e`.toLowerCase() === evs[0]!.car_code.toLowerCase()) : undefined;
    return twin?.id ?? null;
  }
  return null;
}
