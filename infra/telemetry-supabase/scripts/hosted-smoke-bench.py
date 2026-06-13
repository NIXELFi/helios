#!/usr/bin/env python3
"""
Interim hosted bench: drives synthetic SDM26 telemetry through the deployed
telemetry-ingest function as binary HTP/1 frames (the production wire path)
and measures ack RTT, dedup, and staging integrity. Bounded + self-cleaning:
creates one session, runs DURATION_S, deletes the session (cascade) at the
end and verifies zero residue. Stands in until crates/helios-telemetry-gen
and apps/telemetry-bench (handoff §5) exist.

Env (from infra/pdm-supabase/.env + infra/telemetry-supabase/.env):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEMETRY_HMAC_KEY

Usage: python3 hosted-smoke-bench.py [duration_s=60]
"""
import json, math, os, struct, sys, threading, time, hmac, hashlib, uuid
import urllib.request, urllib.error

URL = os.environ["SUPABASE_URL"]
SRK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HMAC_KEY = os.environ["TELEMETRY_HMAC_KEY"].encode()
DURATION_S = int(sys.argv[1]) if len(sys.argv) > 1 else 60

# Safety rails (handoff §5.5)
MAX_DURATION_S = 300
MAX_ERRORS = 10
assert DURATION_S <= MAX_DURATION_S, f"duration capped at {MAX_DURATION_S}s"


def rest(method, path, body=None):
    h = {"apikey": SRK, "Authorization": f"Bearer {SRK}",
         "Content-Type": "application/json", "Prefer": "return=representation"}
    h["Accept-Profile" if method == "GET" else "Content-Profile"] = "telemetry"
    req = urllib.request.Request(f"{URL}/rest/v1/{path}",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=h, method=method)
    r = urllib.request.urlopen(req)
    return json.loads(r.read() or b"null")


def encode_frame(session_id, channel_set_id, group_key, first_seq,
                 send_ts_ms, windows, channels):
    """windows: list of (t_start_us, {ch_id: [samples]})  — HTP/1 per docs/telemetry-wire-protocol.md"""
    out = bytearray()
    out += struct.pack("<HBB", 0x4854, 1, 0)
    out += uuid.UUID(session_id).bytes
    out += struct.pack("<HBBIQ", channel_set_id, group_key, len(windows),
                       first_seq, send_ts_ms)
    for t_start_us, samples in windows:
        out += struct.pack("<Q", t_start_us)
        for ch in channels:
            vals = samples[ch["id"]]
            if ch["enc"] == "f32":
                out += struct.pack(f"<{len(vals)}f", *vals)
            else:
                scale, off = ch.get("scale", 1) or 1, ch.get("offset", 0) or 0
                raw = [max(-32768, min(32767, round((v - off) / scale))) for v in vals]
                out += struct.pack(f"<{len(vals)}h", *raw)
    return bytes(out)


def synth(ch_id, t):
    """Physically plausible signal per channel id at time t seconds."""
    if "rpm" in ch_id:
        return 3000 + 9000 * ((t % 6) / 6)  # sawtooth shift profile 3k->12k
    if "gps" in ch_id or "lat" in ch_id or "lon" in ch_id:
        # small circle at ~lap pace (raw degrees; group 1 is f32)
        a = 2 * math.pi * (t % 90) / 90
        return (40.0 + 0.002 * math.cos(a)) if ("lat" in ch_id) else (-105.0 + 0.002 * math.sin(a))
    if "speed" in ch_id:
        return 60 + 40 * math.sin(2 * math.pi * t / 30)
    if "temp" in ch_id:
        return 80 + 15 * (1 - math.exp(-t / 120)) + 0.5 * math.sin(t)  # 1st-order lag
    if "pressure" in ch_id:
        return 3.0 + 1.5 * ((t % 6) / 6)  # rpm-correlated
    if "voltage" in ch_id:
        return 13.8 + 0.1 * math.sin(t / 5)
    return 10 + math.sin(t + hash(ch_id) % 7)


class GroupDriver(threading.Thread):
    def __init__(self, session_id, group_key, group_def, stop_at, results):
        super().__init__(daemon=True)
        self.sid, self.gk = session_id, group_key
        self.rate = group_def["rate_hz"]
        self.channels = group_def["channels"]
        self.stop_at, self.r = stop_at, results

    def run(self):
        seq, t0 = 0, time.time()
        while time.time() < self.stop_at and len(self.r["errors"]) < MAX_ERRORS:
            wall = time.time()
            t_rel = wall - t0
            t_start_us = int(wall * 1e6)
            samples = {ch["id"]: [synth(ch["id"], t_rel + i / self.rate)
                                  for i in range(self.rate)] for ch in self.channels}
            body = encode_frame(self.sid, 1, self.gk, seq, int(wall * 1000),
                                [(t_start_us, samples)], self.channels)
            sig = hmac.new(HMAC_KEY, body, hashlib.sha256).hexdigest()
            req = urllib.request.Request(
                f"{URL}/functions/v1/telemetry-ingest", data=body,
                headers={"content-type": "application/x-htp",
                         "x-htp-device": "hosted-smoke-bench",
                         "x-htp-signature": sig})
            sent = time.time()
            try:
                resp = json.load(urllib.request.urlopen(req, timeout=10))
                rtt = (time.time() - sent) * 1000
                self.r["acks"].append(rtt)
                self.r["offered"] += 1
                self.r["bytes"] += len(body)
                # every 10th frame: deliberate duplicate retry to verify dedup
                if seq % 10 == 5:
                    dup = json.load(urllib.request.urlopen(
                        urllib.request.Request(f"{URL}/functions/v1/telemetry-ingest",
                                               data=body, headers=req.headers), timeout=10))
                    self.r["dup_checks"].append(dup["dup"] == [seq])
            except Exception as e:
                self.r["errors"].append(f"g{self.gk} seq{seq}: {e}")
            seq += 1
            time.sleep(max(0, 1.0 - (time.time() - wall)))  # 1 window/s cadence
        self.r["windows_sent"][self.gk] = seq


def pct(xs, p):
    if not xs: return float("nan")
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))]


def main():
    cs = rest("GET", "channel_sets?id=eq.1&select=definition")[0]["definition"]
    sess = rest("POST", "sessions", {"name": f"hosted-smoke-bench-{int(time.time())}",
                                     "source": "synthetic", "status": "running"})[0]
    sid = sess["id"]
    print(f"session {sid}; driving {len(cs['groups'])} groups for {DURATION_S}s "
          f"(binary HTP/1, HMAC auth, dup-retry every 10th frame)")

    results = {"acks": [], "errors": [], "dup_checks": [], "offered": 0,
               "bytes": 0, "windows_sent": {}}
    stop_at = time.time() + DURATION_S
    drivers = [GroupDriver(sid, int(k), g, stop_at, results)
               for k, g in cs["groups"].items()]
    for d in drivers: d.start()

    depth_samples = []
    while any(d.is_alive() for d in drivers):
        time.sleep(10)
        n = len(rest("GET", f"staging_chunks?session_id=eq.{sid}&select=seq"))
        depth_samples.append(n)
        print(f"  t+{len(depth_samples)*10}s staging_depth={n} offered={results['offered']} "
              f"errors={len(results['errors'])}")
    for d in drivers: d.join()

    # integrity: rows present == windows sent, seqs contiguous per group, no dups (PK)
    rows = rest("GET", f"staging_chunks?session_id=eq.{sid}&select=group_key,seq&limit=10000")
    by_group = {}
    for r in rows: by_group.setdefault(r["group_key"], set()).add(r["seq"])
    integrity = all(by_group.get(gk, set()) == set(range(n))
                    for gk, n in results["windows_sent"].items())

    report = {
        "session_id": sid, "duration_s": DURATION_S,
        "offered_frames": results["offered"],
        "windows_sent": results["windows_sent"],
        "staged_rows": len(rows),
        "integrity_exact": integrity,
        "ack_ms": {"p50": round(pct(results["acks"], .50)),
                   "p95": round(pct(results["acks"], .95)),
                   "p99": round(pct(results["acks"], .99)),
                   "min": round(min(results["acks"])), "max": round(max(results["acks"]))},
        "dup_retries_correct": f"{sum(results['dup_checks'])}/{len(results['dup_checks'])}",
        "bytes_sent": results["bytes"],
        "staging_depth_samples": depth_samples,
        "errors": results["errors"],
    }
    print(json.dumps(report, indent=2))

    # cleanup: cascade delete, verify zero residue
    rest("DELETE", f"sessions?id=eq.{sid}")
    residue = rest("GET", f"staging_chunks?session_id=eq.{sid}&select=seq")
    print(f"cleanup: session deleted, residue rows = {len(residue)}")
    report["cleanup_residue_rows"] = len(residue)

    out = os.path.join(os.path.dirname(__file__), "..", "..", "..", "bench-results")
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, f"hosted-smoke-{time.strftime('%Y%m%d-%H%M%S')}.json")
    with open(path, "w") as f: json.dump(report, f, indent=2)
    print(f"report -> {path}")
    ok = integrity and not results["errors"] and len(residue) == 0
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
