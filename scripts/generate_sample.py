#!/usr/bin/env python3
"""Generate a synthetic 90-second SDM26 lap CSV for the Helios sample session.

Engine + IMU at 100 Hz, GPS at 10 Hz (forward-filled into 100 Hz grid for simplicity here),
water/oil temps at 10 Hz. Produces deterministic data; do not edit by hand.
"""
import math
import random

random.seed(42)
DT = 0.01      # 100 Hz
DUR = 90.0     # seconds
N = int(DUR / DT)

def write():
    headers = [
        "time_s", "engine.rpm", "engine.tps", "engine.gear",
        "engine.water_temp", "engine.oil_temp",
        "gps.lat", "gps.lon", "gps.speed", "imu.lat_g",
    ]
    lines = [",".join(headers)]
    for i in range(N):
        t = i * DT
        phase = (t % 30.0) / 30.0
        rpm = 4000 + 8000 * (0.5 + 0.5 * math.sin(2 * math.pi * phase * 1.5))
        rpm += random.uniform(-50, 50)
        tps = max(0.0, min(100.0, 50 + 50 * math.sin(2 * math.pi * phase * 1.5)))
        gear = 1 + int(min(5, phase * 5))
        if i % 10 == 0:
            water = 88 + 4 * math.sin(t / 30) + random.uniform(-0.2, 0.2)
            oil   = 95 + 8 * math.sin(t / 30) + random.uniform(-0.2, 0.2)
            lat   = 33.4242 + 0.0008 * math.sin(2 * math.pi * t / 60)
            lon   = -111.9281 + 0.0008 * math.cos(2 * math.pi * t / 60)
            speed = max(5.0, 30 + 20 * math.sin(2 * math.pi * phase * 1.5))
        else:
            water, oil, lat, lon, speed = "", "", "", "", ""
        lat_g = 1.4 * math.sin(2 * math.pi * t / 5)
        lines.append(f"{t:.2f},{rpm:.0f},{tps:.1f},{gear},{water},{oil},{lat},{lon},{speed},{lat_g:.3f}")
    with open("samples/sdm26-synthetic-lap.csv", "w") as f:
        f.write("\n".join(lines) + "\n")

if __name__ == "__main__":
    write()
    print(f"wrote samples/sdm26-synthetic-lap.csv ({N} rows)")
