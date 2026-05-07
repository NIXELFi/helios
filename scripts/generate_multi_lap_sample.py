#!/usr/bin/env python3
"""Generate a 4-lap synthetic CSV — gives Helios's lap-aware widgets
something to chew on without real DAQ multi-lap data.

Closed oval track centered near (33.4249°N, -111.92655°W). Start-finish line
at the east point of the oval; vehicle drives counterclockwise. Pre-roll
warmup, four trusted laps, in-lap cooldown.

Engine + IMU at 100 Hz; GPS + temps at 10 Hz. Deterministic; do not edit by
hand. Regenerate with `python3 scripts/generate_multi_lap_sample.py`.

The track size and per-lap peak-speed table below are knobs — tweak them and
re-run if you want different lap times. Current defaults: ~1360 m perimeter,
peak ~30 m/s on straights, ~12 m/s in corners → ~70-80 s laps.
"""

import math
import random
import os

random.seed(7)

# ── track geometry ─────────────────────────────────────────────────────────
LAT0, LON0 = 33.4249, -111.92655
A_LON = 0.00280       # E-W half axis (~260 m at this latitude)
B_LAT = 0.00150       # N-S half axis (~167 m)
M_PER_DEG_LAT = 111320

_a = A_LON * math.cos(math.radians(LAT0)) * M_PER_DEG_LAT
_b = B_LAT * M_PER_DEG_LAT
_h = ((_a - _b) / (_a + _b)) ** 2
# Ramanujan ellipse-perimeter approximation — accurate to ~10⁻⁵.
PERIMETER = math.pi * (_a + _b) * (1 + 3 * _h / (10 + math.sqrt(4 - 3 * _h)))

# ── timing ────────────────────────────────────────────────────────────────
DT = 0.01
PRE_ROLL_S = 22.0
COOL_DOWN_S = 28.0
NUM_LAPS = 4
LAP_PEAK_M_S = [29.0, 30.8, 31.4, 28.5]   # lap 1, 2, 3 (best), 4

OUT_PATH = "samples/sdm26-synthetic-multi-lap.csv"


def main():
    rows = []
    t = 0.0
    theta = 1.5 * math.pi   # park just past south point so pre-roll has to
                            # traverse two corners before reaching start-finish
    prev_v = 0.0
    crossings = 0
    phase = "pre"
    cool_end = None
    i = 0

    while True:
        # Phase-dependent target speed.
        if phase == "pre":
            target_v = max(0.0, 6.0 * t / PRE_ROLL_S)
            if t >= PRE_ROLL_S:
                phase = "lap"
                # Fall through to compute target_v under the new phase.
                peak = LAP_PEAK_M_S[crossings]
                target_v = 12.0 + (peak - 12.0) * (math.cos(theta) ** 2)
        elif phase == "lap":
            peak = LAP_PEAK_M_S[crossings] if crossings < NUM_LAPS else LAP_PEAK_M_S[-1]
            target_v = 12.0 + (peak - 12.0) * (math.cos(theta) ** 2)
        else:  # cool
            target_v = max(0.0, prev_v * 0.97 - 0.05)
            if t >= cool_end:
                break

        target_v += random.uniform(-0.5, 0.5)
        # rate-limit acceleration so nothing snaps unrealistically
        v = prev_v + max(-0.6, min(0.6, target_v - prev_v))
        v = max(0.0, v)
        accel = (v - prev_v) / DT

        # Advance position.
        prev_theta = theta
        theta = (theta + v * DT / PERIMETER * 2 * math.pi) % (2 * math.pi)

        # Lap crossing: theta wraps from near 2π through 0 → east point of
        # the oval, our start-finish line.
        if phase == "lap" and prev_theta > 1.7 * math.pi and theta < 0.3 * math.pi:
            crossings += 1
            if crossings >= NUM_LAPS:
                phase = "cool"
                cool_end = t + COOL_DOWN_S

        # Position.
        lat = LAT0 + B_LAT * math.sin(theta)
        lon = LON0 + A_LON * math.cos(theta)

        # Engine & driver inputs derived from speed and acceleration.
        gear = max(1, min(6, int(1 + v / 5)))
        rpm = min(13800, 1100 + 320 * v / max(1, gear) ** 0.6 + random.uniform(-30, 30))
        target_tps = 50 + max(-50, min(50, accel * 12))
        tps = max(0.0, min(100.0, target_tps + random.uniform(-1.5, 1.5)))

        # imu.lat_g — cornering force v²/r where r is local ellipse curvature.
        sin_t, cos_t = math.sin(theta), math.cos(theta)
        r_local = max(20.0, (_a * _a * sin_t * sin_t + _b * _b * cos_t * cos_t) ** 1.5 / (_a * _b))
        lat_g_mag = (v * v) / r_local / 9.81
        # Counterclockwise → mostly negative lat_g in vehicle frame (left
        # turns); we leave the sign positive here for visual simplicity in
        # the synthetic data — a real vehicle would have proper signed lat_g.
        lat_g = max(-2.5, min(2.5, lat_g_mag))

        # Slow-rate columns (10 Hz): GPS + temps.
        is_slow = (i % 10 == 0)
        if is_slow:
            water_v = 88 + 0.8 * math.sin(t / 40) + 0.0004 * t + random.uniform(-0.2, 0.2)
            oil_v = 95 + 1.2 * math.sin(t / 40) + 0.0006 * t + random.uniform(-0.2, 0.2)
            slow_water = f"{water_v:.2f}"
            slow_oil = f"{oil_v:.2f}"
            slow_lat = f"{lat:.7f}"
            slow_lon = f"{lon:.7f}"
            slow_speed = f"{v:.2f}"
        else:
            slow_water = slow_oil = slow_lat = slow_lon = slow_speed = ""

        rows.append(
            f"{t:.2f},{rpm:.0f},{tps:.1f},{gear},"
            f"{slow_water},{slow_oil},"
            f"{slow_lat},{slow_lon},{slow_speed},"
            f"{lat_g:.3f}"
        )

        prev_v = v
        t += DT
        i += 1
        if t > 600:  # safety stop in case crossings never trigger
            break

    headers = [
        "time_s", "engine.rpm", "engine.tps", "engine.gear",
        "engine.water_temp", "engine.oil_temp",
        "gps.lat", "gps.lon", "gps.speed", "imu.lat_g",
    ]
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        f.write(",".join(headers) + "\n")
        f.write("\n".join(rows) + "\n")
    print(f"wrote {OUT_PATH} — {len(rows)} rows, {t:.1f}s wall, {crossings} laps")


if __name__ == "__main__":
    main()
