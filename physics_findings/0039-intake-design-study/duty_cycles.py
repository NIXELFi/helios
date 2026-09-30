"""Build data/duty_*.csv (on-throttle rpm histograms, 250 rpm bins) for candidates.py.

Measured: Josh AX 4-26 (G4X, upshifts broken), 4-16 driver selection (MoTeC, single gear = 2nd), 4-19 mock endurance
(only 49 s at full throttle). Synthetic: the 4-16 speed traces (from rpm in 2nd) re-driven by an ideal-shifting driver
who holds whichever of gears 1-3 gives the most wheel force on the team dyno curve (rpm 3-13k). SDM26 gearing from
fsae-sim params.js: CBR600RR PC40 [2.75, 2.0, 1.667], primary 2.111, final 3.0.
"""
import glob, os, numpy as np, pandas as pd
H = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(H, "data")
E = np.arange(3000, 13001, 250)
def save(name, rpm, note):
    h, _ = np.histogram(rpm, bins=E); f = h / max(h.sum(), 1)
    pd.DataFrame(dict(rpm_lo=E[:-1], rpm_hi=E[1:], frac=f)).to_csv(os.path.join(D, f"duty_{name}.csv"), index=False)
    print(f"{name:18s} n={len(rpm):6d} median {np.median(rpm):5.0f}  p25/p75 {np.percentile(rpm,25):5.0f}/{np.percentile(rpm,75):5.0f}  {note}")
s = pd.read_csv(os.path.join(D, "duty_cycle_summary.csv"))
for col, name, note in [("frac_autocross", "ld416_ax", "4-16 driver selection, single gear (2nd)"), ("frac_endurance", "ld419_endu", "4-19 mock endurance, 49 s WOT only")]:
    pd.DataFrame(dict(rpm_lo=s.rpm_lo, rpm_hi=s.rpm_hi, frac=s[col] / s[col].sum())).to_csv(os.path.join(D, f"duty_{name}.csv"), index=False)
    mid = (s.rpm_lo + s.rpm_hi) / 2; c = np.cumsum(s[col]) / s[col].sum(); print(f"{name:18s} median {np.interp(0.5, c, mid):5.0f}  {note}")
dy = pd.read_csv(os.path.join(D, "dyno_raw_25rpm.csv")).sort_values("rpm")
T = lambda r: np.interp(r, dy.rpm, dy.Nm, left=dy.Nm.iloc[0] * 0.8, right=0.0)
G = np.array([2.75, 2.0, 1.667])
ses = pd.read_csv(os.path.join(D, "ld_sessions.csv")); use = ses[(ses["class"] == "autocross") & ses.used].session
syn, meas = [], []
for n in use:
    f = os.path.join(D, "ld_traces", n + ".csv")
    if not os.path.exists(f): continue
    x = pd.read_csv(f, usecols=["rpm", "tps"]); on = x[(x.tps >= 60) & (x.rpm > 3000)]
    r2 = on.rpm.values; meas.append(r2)
    rg = r2[:, None] * G[None, :] / G[1]                                   # same road speed in gears 1..3
    force = np.where((rg >= 3000) & (rg <= 13000), T(rg) * G[None, :], -1)   # wheel force ~ T * overall ratio
    syn.append(rg[np.arange(len(rg)), force.argmax(1)])
save("ld416_optshift", np.concatenate(syn), "synthetic: 4-16 speeds, ideal gear 1-3 on the dyno curve")
