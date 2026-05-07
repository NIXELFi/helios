import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { LoadedSession } from "./session";

/** Export a session's GPS path to a KML file (Google Earth / Maps). One
 *  Placemark per session, with each lap as its own LineString when laps are
 *  detected — so opening the KML in Google Earth lets the user toggle
 *  individual laps on and off.
 *
 *  Filters out null-island samples (≤ 0.5° from origin) since MoTeC pads
 *  missing GPS frames with zeroes. */
export async function exportSessionKml(session: LoadedSession): Promise<string | null> {
  const path = await save({
    defaultPath: `${slug(session.label)}.kml`,
    filters: [{ name: "KML (Google Earth)", extensions: ["kml"] }],
  });
  if (!path) return null;
  const lat = readChannel(session, "gps.lat");
  const lon = readChannel(session, "gps.lon");
  const time = baseTime(session);
  if (!lat || !lon || !time) {
    await writeTextFile(path, kmlWrap(session.label, ""));
    return path;
  }
  const decode = (v: number) => {
    if (!Number.isFinite(v) || Math.abs(v) <= 1000) return v;
    const signed = v > 2_147_483_647 ? v - 4_294_967_296 : v;
    return signed / 1e7;
  };
  const segments: string[] = [];
  if (session.laps && session.laps.laps.length > 0) {
    for (const lap of session.laps.laps) {
      const pts = collectLapPoints(lat, lon, time, lap.startUs, lap.endUs, decode);
      if (pts.length === 0) continue;
      segments.push(linestring(`Lap ${lap.index}${lap.trusted ? "" : " (untrusted)"}`,
                               pts, lap.trusted ? "ff00aaff" : "ff888888"));
    }
  } else {
    const pts = collectLapPoints(lat, lon, time, -Infinity, Infinity, decode);
    if (pts.length > 0) segments.push(linestring("Path", pts, "ff00aaff"));
  }
  await writeTextFile(path, kmlWrap(session.label, segments.join("\n")));
  return path;
}

function collectLapPoints(
  lat: Float64Array, lon: Float64Array, time: BigInt64Array,
  startUs: number, endUs: number, decode: (v: number) => number,
): string[] {
  const out: string[] = [];
  const n = Math.min(lat.length, lon.length, time.length);
  for (let i = 0; i < n; i++) {
    const tUs = Number(time[i]!);
    if (tUs < startUs) continue;
    if (tUs > endUs) break;
    const la = decode(lat[i]!), lo = decode(lon[i]!);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    if (Math.abs(la) < 0.5 && Math.abs(lo) < 0.5) continue;
    if (la < -90 || la > 90 || lo < -180 || lo > 180) continue;
    out.push(`${lo.toFixed(7)},${la.toFixed(7)},0`);
  }
  return out;
}

function linestring(name: string, pts: string[], colorAbgr: string): string {
  const id = `s_${name.replace(/[^a-z0-9]+/gi, "_")}`;
  return `<Placemark>
  <name>${escapeXml(name)}</name>
  <Style id="${id}"><LineStyle><color>${colorAbgr}</color><width>2</width></LineStyle></Style>
  <styleUrl>#${id}</styleUrl>
  <LineString>
    <coordinates>${pts.join(" ")}</coordinates>
  </LineString>
</Placemark>`;
}

function kmlWrap(label: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${escapeXml(label)}</name>
${body}
</Document>
</kml>
`;
}

function readChannel(session: LoadedSession, id: string): Float64Array | undefined {
  return session.store.groupOf(id)?.columns.get(id);
}

function baseTime(session: LoadedSession): BigInt64Array | undefined {
  // GPS lat/lon should share a rate group, so the time of either is fine.
  return session.store.groupOf("gps.lat")?.time;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;",
  }[c]!));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
