"""Engine-rpm duty cycle + shifting health from the SDM26 MoTeC .ld logs.

Inputs : data/ld_raw/*.ld           (downloaded from the Helios vault; gitignored)
Outputs: data/ld_traces/<name>.csv  (50 Hz traces; gitignored)
         data/ld_sessions.csv       (per-session shifting health + duty-cycle stats)
         data/duty_cycle_summary.csv (pooled 250-rpm histograms; committable)

Session classes (from the vault folder):
  4-16-26_DriverSelection -> autocross (driver tryouts, short runs)
  4-19-26_MockEndurance   -> endurance
  3_25_2026 suspension day has no engine channels -> skipped automatically.

On-throttle mask: tps >= 60 % and rpm > 3000 (same definition as the Josh 4-26
duty cycle, data/duty_josh_0426.csv). Note the logged "Throttle Position"
reads ~14-17 % at closed throttle on these cars; it is used as logged.
"""
from __future__ import annotations

import glob
import os

import numpy as np
import pandas as pd

from ld_reader import read_ld

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "data", "ld_raw")
TR = os.path.join(HERE, "data", "ld_traces")
FS = 50.0
BINS = np.arange(3000, 15001, 250)
BANDS = [(3000, 6000, "pct_3k_6k"), (6000, 10000, "pct_6k_10k"),
         (10000, 12500, "pct_10k_12.5k"), (12500, 1e9, "pct_12.5k_up")]
MIN_ONTHR_S = 5.0

CH = {  # output column -> candidate channel names
    "rpm": ["Engine Speed", "Engine RPM", "RPM"],
    "tps": ["Throttle Position", "TPS", "Throttle Pos"],
    "gear": ["Gear Position", "Gear"],
    "speed_kph": ["Vehicle Speed", "Driven Wheel Speed", "Ground Speed"],
    "map_kpa": ["Manifold Pressure", "MAP"],
    "lambda1": ["Lambda 1", "Lambda"],
    "neutral": ["Neutral Status"],
}


def classify(name: str) -> str:
    if name.startswith("4-16"):
        return "autocross"
    if name.startswith("4-19"):
        return "endurance"
    return "other"


def load_trace(path: str) -> pd.DataFrame | None:
    ld = read_ld(path)
    chans = ld.channels
    pick = {k: next((c for c in v if c in chans), None) for k, v in CH.items()}
    if pick["rpm"] is None or pick["tps"] is None:
        return None
    ref = chans[pick["rpm"]]
    # Time channel (logger timestamps) if present and monotonic, else i/freq.
    t = None
    if "Time" in chans and chans["Time"].n == ref.n and chans["Time"].freq == ref.freq:
        tt = chans["Time"].data
        if np.all(np.diff(tt) > 0):
            t = tt - tt[0]
    grid = None
    out = {}
    for col, name in pick.items():
        if name is None:
            continue
        c = chans[name]
        tc = t if (t is not None and c.n == ref.n and c.freq == ref.freq) else c.time()
        if grid is None:
            grid = np.arange(0.0, tc[-1], 1.0 / FS)
        d = c.data
        if col in ("gear", "neutral"):  # hold previous value
            idx = np.clip(np.searchsorted(tc, grid, side="right") - 1, 0, len(d) - 1)
            out[col] = d[idx]
        else:
            out[col] = np.interp(grid, tc, d)
        c.free()
    df = pd.DataFrame({"time_s": grid, **out})
    if "gear" in df and not (df["gear"] > 0).any():
        df["gear"] = np.nan  # channel present but never populated (4-16 logs)
    return df


def shift_health(df: pd.DataFrame) -> dict:
    r = df["rpm"].to_numpy()
    tp = df["tps"].to_numpy()
    n = len(r)
    res = {}
    # (a) gear-channel upshifts, debounced: old gear held >= 0.3 s before, new
    # gear held >= 0.3 s after, both >= 1.
    ups = []
    if "gear" in df and df["gear"].notna().any():
        g = df["gear"].to_numpy()
        hold = int(0.3 * FS)
        for i in np.flatnonzero(np.diff(g) == 1) + 1:
            if g[i - 1] >= 1 and i - hold >= 0 and i + hold < n \
                    and np.all(g[i - hold:i] == g[i - 1]) and np.all(g[i:i + hold] == g[i]):
                ups.append(i)
    res["gear_upshifts"] = len(ups)
    drops = []
    for i in ups:
        pre = r[max(i - int(0.3 * FS), 0):i + 1].max()
        post = r[i:i + int(0.5 * FS)].min()
        drops.append(pre - post)
    res["gear_upshift_median_drop_rpm"] = float(np.median(drops)) if drops else np.nan
    res["gear_upshifts_wot"] = int(sum(tp[max(i - int(0.3 * FS), 0)] >= 60 for i in ups))
    v = df["speed_kph"].to_numpy() if "speed_kph" in df else np.zeros(n)
    # (b) rpm/speed ratio. The speed channel's absolute scale differs between
    # days, but within a session r/v is a gear signature.
    m = (tp >= 60) & (r > 3000) & (v > 10)
    ratio = r[m] / v[m]
    if ratio.size > 50:
        mode = float(np.median(ratio))
        res["ratio_median"] = mode
        res["ratio_frac_within_8pct"] = float(np.mean(np.abs(ratio / mode - 1) < 0.08))
    else:
        mode = np.nan
        res["ratio_median"] = np.nan
        res["ratio_frac_within_8pct"] = np.nan
    # (c) ratio-step upshifts (gear-channel independent): steady r/v segments
    # (>= 0.5 s within +-3 %, v > 20, rpm > 4000); a following segment within
    # 1.5 s whose ratio is 10-45 % lower, with the driver on power before and
    # after = an upshift that actually engaged.
    valid = (v > 20) & (r > 4000)
    rv = pd.Series(np.where(valid, r / np.maximum(v, 1e-3), np.nan)).rolling(
        int(0.3 * FS), center=True, min_periods=int(0.2 * FS)).median().to_numpy()
    win = int(0.5 * FS)
    hi = pd.Series(rv).rolling(win).max().to_numpy()
    lo = pd.Series(rv).rolling(win).min().to_numpy()
    stable = np.isfinite(hi) & (hi / lo < 1.06)
    segs = []  # (start, end, ratio at end, ratio at start)
    i = 0
    while i < n:
        if stable[i]:
            j = i
            while j + 1 < n and stable[j + 1] and abs(rv[j + 1] / rv[i] - 1) < 0.06:
                j += 1
            segs.append((i - win + 1, j, rv[j], rv[max(i - win + 1, 0)]))
            i = j + 1
        else:
            i += 1
    rs_up = []
    for a, b in zip(segs, segs[1:]):
        if b[0] - a[1] <= int(1.5 * FS):
            step = a[2] / b[3]
            # both sides under power (tps >= 50): lift-to-brake also drops r/v
            # ~10 % (drive-slip / speed-channel lag), so it must be excluded.
            on_a = tp[max(a[1] - int(0.3 * FS), 0)] >= 50
            on_b = np.mean(tp[b[0]:b[0] + int(0.5 * FS)]) >= 50
            if 1.10 < step < 1.45 and on_a and on_b:
                k = a[1]
                rs_up.append((k, r[max(k - int(0.3 * FS), 0):k + 1].max() - r[k:b[0] + int(0.2 * FS)].min(),
                              tp[max(k - int(0.3 * FS), 0)]))
    res["ratio_upshifts"] = len(rs_up)
    res["ratio_upshifts_wot"] = int(sum(t >= 60 for _, _, t in rs_up))
    res["ratio_upshift_median_drop_rpm"] = float(np.median([d for _, d, _ in rs_up])) if rs_up else np.nan
    # (d) WOT rpm drops > 1500 rpm within 0.2 s from > 7000 rpm with tps >= 60 %.
    # "flat" = throttle still >= 60 % 0.3 s later and the car rolling in gear
    # (v > 30, r/v within 20 % of the session median) -- excludes launches and
    # lift-to-brake, i.e. the flat-shift signature.
    w = int(0.2 * FS)
    ev = []
    i = 0
    while i < n - w - int(0.3 * FS):
        if tp[i] >= 60 and r[i] > 7000 and r[i] - r[i + 1:i + w + 1].min() > 1500:
            ev.append(i)
            i += int(1.0 * FS)
            continue
        i += 1
    res["wot_rpm_drops"] = len(ev)
    res["wot_rpm_drops_flat"] = int(sum(
        tp[j + int(0.3 * FS)] >= 60 and v[j] > 30 and np.isfinite(mode)
        and abs(r[j] / max(v[j], 1e-3) / mode - 1) < 0.2 for j in ev))
    return res


def duty(r: np.ndarray) -> dict:
    out = {"onthr_s": r.size / FS}
    if r.size == 0:
        return out
    out.update(p25=float(np.percentile(r, 25)), median=float(np.median(r)),
               p75=float(np.percentile(r, 75)))
    for lo, hi, key in BANDS:
        out[key] = float(np.mean((r >= lo) & (r < hi)) * 100)
    return out


def main():
    os.makedirs(TR, exist_ok=True)
    rows, pools = [], {}
    for p in sorted(glob.glob(os.path.join(RAW, "*.ld"))):
        name = os.path.splitext(os.path.basename(p))[0]
        df = load_trace(p)
        if df is None:
            continue
        df.to_csv(os.path.join(TR, name + ".csv"), index=False, float_format="%.4g")
        r = df["rpm"].to_numpy()
        m = (df["tps"].to_numpy() >= 60) & (r > 3000)
        sh = shift_health(df)
        row = {"session": name, "class": classify(name), "dur_s": df["time_s"].iloc[-1],
               "rpm_max": r.max(), **sh, **duty(r[m])}
        if sh["gear_upshifts"] > sh["ratio_upshifts"] + 1:
            row["shifting"] = "gear-channel increments without ratio change (flicker or failed shifts)"
        elif sh["ratio_upshifts"] == 0:
            row["shifting"] = "no upshifts (single gear)"
        elif sh["ratio_upshifts_wot"] == 0:
            row["shifting"] = "upshifts only off-throttle"
        else:
            row["shifting"] = "WOT upshifts OK"
        row["used"] = row["onthr_s"] >= MIN_ONTHR_S
        rows.append(row)
        mv = (r > 3000) & (df["speed_kph"].to_numpy() > 15)
        if row["used"]:
            for pool in (row["class"], "all"):
                pools.setdefault(pool, []).append(r[m])
        if mv.sum() / FS >= 30:  # context pool: all throttle while moving
            for pool in (row["class"], "all"):
                pools.setdefault(pool + "_moving", []).append(r[mv])
    S = pd.DataFrame(rows)
    S.to_csv(os.path.join(HERE, "data", "ld_sessions.csv"), index=False, float_format="%.4g")
    hist = {"rpm_lo": BINS[:-1], "rpm_hi": BINS[1:]}
    stats = []
    for pool, arrs in pools.items():
        x = np.concatenate(arrs)
        h, _ = np.histogram(x, BINS)
        hist[f"frac_{pool}"] = h / max(x.size, 1)
        stats.append({"pool": pool, "sessions": len(arrs), **duty(x)})
    pd.DataFrame(hist).to_csv(os.path.join(HERE, "data", "duty_cycle_summary.csv"),
                              index=False, float_format="%.5g")
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    cols = ["session", "class", "dur_s", "rpm_max", "gear_upshifts", "gear_upshifts_wot",
            "gear_upshift_median_drop_rpm", "ratio_upshifts", "ratio_upshifts_wot",
            "ratio_upshift_median_drop_rpm", "wot_rpm_drops", "wot_rpm_drops_flat", "ratio_median",
            "ratio_frac_within_8pct", "onthr_s", "median", "pct_3k_6k", "pct_6k_10k",
            "pct_10k_12.5k", "pct_12.5k_up", "shifting", "used"]
    S2 = S[[c for c in cols if c in S]].copy()
    S2["session"] = (S2["session"].str.replace("driver_tryout_4_16__", "#")
                     .str.replace("4-16-26_DriverSelection__", "416_").str.replace("4-19-26_MockEndurance__", "419_"))
    print(S2.round(2).to_string(index=False))
    print(pd.DataFrame(stats).round(1).to_string(index=False))


if __name__ == "__main__":
    main()
