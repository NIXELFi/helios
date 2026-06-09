// CSV export of lap-sim channel traces — the hand-off artifact for further
// design work (Excel/MATLAB/MoTeC-style workflows). Metadata travels in
// leading "#" comment lines so the data block stays a clean rectangle.

import type { LapChannels, LapResult } from "../performance";

export interface LapCsvMeta {
  configName: string;
  vehicleName: string;
  event: string; // "autocross" | "endurance"
  trackName: string;
  generatedAt: string; // ISO
}

const HEADER = [
  "dist_m",
  "time_s",
  "speed_kph",
  "rpm",
  "gear",
  "lat_g",
  "long_g",
  "limit_state",
  "fuel_cum_g",
] as const;

/** Build the channel CSV. Comment lines (#) carry provenance + lap summary;
 *  one row per sim sample (~2 m spacing). */
export function buildLapChannelsCsv(meta: LapCsvMeta, lap: LapResult): string {
  const ch: LapChannels | undefined = lap.channels;
  if (!ch || ch.distM.length === 0) {
    throw new Error("lap result has no channels — run simLap with { channels: true }");
  }
  const lines: string[] = [
    `# Helios CFD lap-sim channel export`,
    `# config: ${meta.configName}`,
    `# vehicle: ${meta.vehicleName}`,
    `# event: ${meta.event} · track: ${meta.trackName}`,
    `# lap_time_s: ${lap.lapTimeS.toFixed(3)} · shifts: ${lap.shiftCount} · fuel_kg: ${lap.fuelKg.toFixed(4)} · co2_kg: ${lap.co2Kg.toFixed(4)}`,
    `# generated: ${meta.generatedAt}`,
    HEADER.join(","),
  ];
  for (let i = 0; i < ch.distM.length; i++) {
    lines.push(
      [
        ch.distM[i]!.toFixed(1),
        ch.tS[i]!.toFixed(3),
        (ch.vMps[i]! * 3.6).toFixed(2),
        ch.rpm[i]!.toFixed(0),
        String(ch.gear[i]!),
        ch.latG[i]!.toFixed(3),
        ch.longG[i]!.toFixed(3),
        ch.limit[i]!,
        (ch.fuelCumKg[i]! * 1000).toFixed(2),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
