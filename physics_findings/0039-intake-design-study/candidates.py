"""Finding 0039 final candidates: best design per packaging tier, scored on dyno bands AND real on-throttle duty cycles.

Duty cycles: every data/duty_*.csv with columns rpm_lo, rpm_hi, frac (on-throttle time histogram). A duty-cycle score is
the time-weighted torque ratio vs as-built: sum(w * T_design) / sum(w * T_asbuilt) - 1, with w on the 250-rpm grid.
'shift4' re-scores with the model's rpm axis compressed 4 % (0036: the model's tuning features sit ~4 % late vs the car),
i.e. the car at rpm r is read from the model at 1.04 r. Robust pick = best worst-case over all scores in the tier.
"""
import os, glob, json, math, numpy as np, pandas as pd
import core
from core import BANDS, BORE_A, OUTSIDE0

H = core.H; OUT = os.path.join(H, "charts"); os.makedirs(OUT, exist_ok=True)
d = core.load(); S = core.Surface(d); R = S.rpm
TODAY = core.today()(R)


def duty_cycles():
    dc = {}
    for f in sorted(glob.glob(os.path.join(H, "data", "duty_*.csv"))):
        x = pd.read_csv(f)
        if not {"rpm_lo", "rpm_hi", "frac"} <= set(x.columns):
            continue
        mid = (x.rpm_lo + x.rpm_hi) / 2
        w = np.interp(R, mid, x.frac, left=0, right=0)
        # time spent below the grid's 4000 rpm floor is dropped (no model data there); report how much
        dc[os.path.basename(f)[5:-4]] = dict(w=w / w.sum(), below4k=float(x.frac[x.rpm_hi <= 4000].sum() / x.frac.sum()))
    return dc


DC = duty_cycles()


def shifted(T, k=1.04):
    return np.interp(np.minimum(R * k, R[-1]), R, T)


def scores(T):
    s = {b: (core.band_mean(R, TODAY * T / S.base, b) / core.band_mean(R, TODAY, b) - 1) * 100 for b in ["P1 6-12k", "driver 7-10.5k"]}
    for n, c in DC.items():
        s[n] = (np.sum(c["w"] * TODAY * T / S.base) / np.sum(c["w"] * TODAY) - 1) * 100
        s[n + " shift4"] = (np.sum(c["w"] * TODAY * shifted(T) / shifted(S.base)) / np.sum(c["w"] * TODAY) - 1) * 100
    return s


def vrli_for(Venv, lo, stroke, weights):
    """VRLI torque with the rate-feasible DP schedule optimised for a given rpm weighting."""
    pos = np.arange(lo, lo + stroke + 1e-9, 5.0)
    Veff = Venv - BORE_A * (pos - lo)
    T = np.array([S.at(max(v, 0.3), p) for v, p in zip(Veff, pos)]).T
    step = max(1, int(round(200.0 / 3000.0 * (R[1] - R[0]) / 5.0)))
    path = core.dp_schedule(T / S.base[:, None], weights, step)
    return T[np.arange(len(R)), path], pos[path]


# packaging tiers. ext = runner length change vs as-built (mm above the head flange); V = plenum air volume (L).
# The team says the runners can't get meaningfully longer, so tiers cap reach at +0 / +40 mm, and C3 caps the plenum envelope.
# Nick 2026-09-30: the plenum may grow, so plenum size is a swept cap (1.44 / 2.0 / 2.75 / 3.5 L); reach stays tight.
TIERS = [(f"{kind} | reach <= {'as-built' if ext == 0 else f'+{ext} mm'} | plenum <= {V:g} L",
          dict(kind=kind, ext_max=ext, V_max=V, stroke_max=150))
         for kind in ("static", "vrli") for ext in (0, 40) for V in (1.44, 2.0, 2.75, 3.5)]
# Concept A (CDR): trumpets telescope INSIDE the plenum, so only the fixed outside runner is packaging-limited and the
# effective length can reach outside + stroke. Needs a plenum tall enough for the stroke (~stroke + 40 mm).
TIERS += [(f"vrli-inside | outside runner <= {'as-built' if ext == 0 else f'+{ext} mm'} | box <= {V:g} L",
           dict(kind="vrli_in", ext_max=ext, V_max=V, stroke_max=150))
          for ext in (0, 40) for V in (1.44, 2.75, 3.5)]
W_P1 = np.where((R >= 6000) & (R <= 12000), 1.0, 0.15)
rows = []
for tname, t in TIERS:
    if t["kind"] == "static":
        for V in [v for v in S.Vs if v <= t["V_max"] + 1e-9]:
            for e in [x for x in S.exts if x <= t["ext_max"]] + ([t["ext_max"]] if t["ext_max"] not in S.exts else []):
                T = S.at(V, e)
                if np.isnan(T).any():
                    continue
                rows.append(dict(tier=tname, design=f"{V:g} L plenum, runner {OUTSIDE0 + e:.0f} mm above flange ({e:+.0f})", V=V, ext=e, stroke=0, **scores(T)))
    else:
        for Venv in [v for v in S.Vs if v <= t["V_max"] + 1e-9] + ([t["V_max"]] if t["V_max"] not in S.Vs else []):
            for st in range(25, t["stroke_max"] + 1, 25):
                # outside (fixed) runner lo, the telescoping part adds up to `st` inside the plenum; the long end is the reach
                his = (range(int(t["ext_max"]) - 150, int(t["ext_max"]) + 1, 10) if t["kind"] == "vrli"
                       else [lo_ + st for lo_ in range(int(t["ext_max"]) - 150, int(t["ext_max"]) + 1, 10)])
                for hi in his:
                    lo = hi - st
                    if lo < S.exts[0] or Venv - BORE_A * st < S.Vs[0]:
                        continue
                    T, sch = vrli_for(Venv, lo, st, W_P1)
                    if np.isnan(T).any():
                        continue
                    sc = scores(T)
                    for n, c in DC.items():      # re-optimise the ECU table for each duty cycle (the ECU map is free)
                        Tw, _ = vrli_for(Venv, lo, st, np.maximum(c["w"], 1e-4))
                        sc[n] = scores(Tw)[n]; sc[n + " shift4"] = scores(Tw)[n + " shift4"]
                    rows.append(dict(tier=tname, design=f"{Venv:g} L box, runner {OUTSIDE0 + lo:.0f}-{OUTSIDE0 + hi:.0f} mm ({st} stroke)",
                                     V=Venv, ext=hi, stroke=st, **sc))
X = pd.DataFrame(rows)
metric_cols = [c for c in X.columns if c not in ("tier", "design", "V", "ext", "stroke")]
X["worst"] = X[metric_cols].min(axis=1)
X["duty_mean"] = X[[c for c in metric_cols if c in DC]].mean(axis=1)
metric_cols = metric_cols + ["duty_mean"]
X.round(2).to_csv(os.path.join(OUT, "candidates_all.csv"), index=False)

best = []
for tname, _ in TIERS:
    x = X[X.tier == tname]
    if not len(x):
        continue
    pick = x.sort_values("worst").iloc[-1]
    p1 = x.sort_values("P1 6-12k").iloc[-1]
    best.append(dict(tier=tname, robust=pick[["design", "worst"] + metric_cols].to_dict(), best_p1=p1[["design"] + metric_cols].to_dict()))
json.dump(dict(duty_cycles={k: dict(below4k=v["below4k"]) for k, v in DC.items()}, tiers=best), open(os.path.join(OUT, "candidates.json"), "w"), indent=1, default=float)
pd.set_option("display.width", 250); pd.set_option("display.max_colwidth", 70)
for b in best:
    print("\n==", b["tier"])
    print("  robust :", b["robust"]["design"], {k: round(v, 1) for k, v in b["robust"].items() if k != "design"})
    print("  best P1:", b["best_p1"]["design"], {k: round(v, 1) for k, v in b["best_p1"].items() if k != "design"})
