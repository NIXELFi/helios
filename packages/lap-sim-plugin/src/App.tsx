import { useEffect, useMemo, useState } from "react";
import { ready, save, log } from "@helios/plugin-sdk";
import {
  simLap,
  autocrossLapOpts,
  enduranceLapOpts,
  SDM26_VEHICLE,
  AUTOCROSS_2026,
  ENDURANCE_2026,
  type LapResult,
} from "@helios/lapsim-core";
import { DEFAULT_CURVE, DEFAULT_CURVE_LABEL } from "./defaultSweep";

type EventKind = "autocross" | "endurance";

function channelsCsv(r: LapResult): string {
  const c = r.channels;
  if (!c) return "";
  const head = "distM,tS,vMps,rpm,gear,latG,longG,limit";
  const rows = c.distM.map((d, i) =>
    [d, c.tS[i], c.vMps[i], c.rpm[i], c.gear[i], c.latG[i], c.longG[i], c.limit[i]].join(","),
  );
  return [head, ...rows].join("\n");
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m > 0 ? `${m}:${sec.toFixed(2).padStart(5, "0")}` : sec.toFixed(2);
}

const kmh = (mps: number) => (mps * 3.6).toFixed(1);

export function App() {
  const [event, setEvent] = useState<EventKind>("autocross");
  const [msg, setMsg] = useState("");

  // Wait for the host handshake (no-op when running outside Helios).
  useEffect(() => {
    void ready()
      .then((ctx) => log("Lap Sim ready", ctx))
      .catch(() => {});
  }, []);

  const result = useMemo<LapResult>(() => {
    const track = event === "autocross" ? AUTOCROSS_2026 : ENDURANCE_2026;
    const opts = {
      ...(event === "autocross" ? autocrossLapOpts() : enduranceLapOpts()),
      channels: true,
    };
    return simLap(DEFAULT_CURVE, SDM26_VEHICLE, track, opts);
  }, [event]);

  async function exportCsv() {
    try {
      const ok = await save(channelsCsv(result), `lap-${event}.csv`);
      setMsg(ok ? "Channels saved." : "Save cancelled.");
    } catch {
      setMsg("Saving needs the Helios host.");
    }
  }

  return (
    <div className="wrap">
      <div className="title">
        <span style={{ fontSize: 22 }}>🏁</span>
        <h1>LAP SIM</h1>
      </div>
      <p className="dim">
        FSAE quasi-steady-state lap-time simulator · {DEFAULT_CURVE_LABEL}
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 20, marginTop: 18, flexWrap: "wrap" }}>
        <div className="seg">
          <button className={event === "autocross" ? "on" : ""} onClick={() => setEvent("autocross")}>
            Autocross
          </button>
          <button className={event === "endurance" ? "on" : ""} onClick={() => setEvent("endurance")}>
            Endurance
          </button>
        </div>
        <div className="laptime">
          {fmtTime(result.lapTimeS)}
          <span className="u"> s</span>
        </div>
      </div>

      <div className="grid">
        <Stat k="Top speed" v={`${kmh(result.vMaxMps)} km/h`} />
        <Stat k="Avg speed" v={`${kmh(result.avgSpeedMps)} km/h`} />
        <Stat k="Min speed" v={`${kmh(result.vMinMps)} km/h`} />
        <Stat k="Upshifts" v={String(result.shiftCount)} />
        <Stat k="Fuel" v={`${result.fuelL.toFixed(2)} L`} />
        <Stat k="CO₂" v={`${result.co2Kg.toFixed(2)} kg`} />
      </div>

      <div className="panel">
        <button className="btn" onClick={exportCsv}>
          Export channels CSV
        </button>
        {msg && (
          <span className="dim" style={{ marginLeft: 12 }}>
            {msg}
          </span>
        )}
        <p className="dim" style={{ marginTop: 10 }}>
          Sandboxed plugin · physics from <code>@helios/lapsim-core</code> ·{" "}
          {result.channels?.distM.length ?? 0} samples over the 2026 {event} track.
        </p>
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
