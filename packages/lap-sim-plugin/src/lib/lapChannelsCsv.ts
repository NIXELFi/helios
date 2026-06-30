// CSV export of lap-sim channel traces — the hand-off artifact for further
// design work (Excel/MATLAB/MoTeC-style workflows). Metadata travels in
// leading "#" comment lines so the data block stays a clean rectangle.

import type { LapChannels, LapResult } from "@helios/lapsim-core";

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
  "throttle",
  "brake",
  "limit_state",
  "fuel_cum_g",
] as const;

/** Sanitize a free-text value for a single "#" comment line: collapse any
 *  CR/LF (and other control chars) to spaces so a name containing a newline
 *  can't break out of the comment block and inject a fake data row. */
function safeComment(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x1F\x7F]+/g, " ").trim();
}

/** Build the channel CSV. Comment lines (#) carry provenance + lap summary;
 *  one row per sim sample (~2 m spacing). */
export function buildLapChannelsCsv(meta: LapCsvMeta, lap: LapResult): string {
  const ch: LapChannels | undefined = lap.channels;
  if (!ch || ch.distM.length === 0) {
    throw new Error("lap result has no channels — run simLap with { channels: true }");
  }
  const lines: string[] = [
    `# Helios CFD lap-sim channel export`,
    `# config: ${safeComment(meta.configName)}`,
    `# vehicle: ${safeComment(meta.vehicleName)}`,
    `# event: ${safeComment(meta.event)} · track: ${safeComment(meta.trackName)}`,
    `# lap_time_s: ${lap.lapTimeS.toFixed(3)} · shifts: ${lap.shiftCount} · fuel_kg: ${lap.fuelKg.toFixed(4)} · co2_kg: ${lap.co2Kg.toFixed(4)}`,
    `# v_max_kph: ${lap.telemetry.vMaxKph.toFixed(1)} · v_min_kph: ${lap.telemetry.vMinKph.toFixed(1)} · max_lat_g: ${lap.telemetry.maxLatG.toFixed(2)} · max_brake_g: ${lap.telemetry.maxBrakeG.toFixed(2)}`,
    `# pct_power_limited: ${(lap.telemetry.pctPowerLimited * 100).toFixed(1)}% · pct_corner_limited: ${(lap.telemetry.pctCornerLimited * 100).toFixed(1)}% · pct_on_throttle: ${(lap.telemetry.pctOnThrottle * 100).toFixed(1)}%`,
    `# brake_energy_kj: ${lap.telemetry.brakeEnergyKJ.toFixed(1)} · peak_brake_power_kw: ${lap.telemetry.peakBrakePowerKw.toFixed(1)} · tire_duty_g_km: ${lap.telemetry.tireDutyGkm.toFixed(2)}`,
    ...(lap.telemetry.balanceMargin != null
      ? [`# balance_margin: ${(lap.telemetry.balanceMargin * 100).toFixed(1)}% (${lap.telemetry.balanceMargin >= 0 ? "loose" : "push"}) · pct_front_limited: ${((lap.telemetry.pctFrontLimited ?? 0) * 100).toFixed(1)}%`]
      : []),
    `# generated: ${safeComment(meta.generatedAt)}`,
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
        ch.throttle[i]!.toFixed(3),
        ch.brake[i]!.toFixed(3),
        ch.limit[i]!,
        (ch.fuelCumKg[i]! * 1000).toFixed(2),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
