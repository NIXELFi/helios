"""Shared scoring + chart style for the finding-0039 VRLI stroke/placement studies (vrli_stroke.py, vrli_combos.py)."""
import os, glob, json, math, numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import core
from core import BORE_A, OUTSIDE0

H = core.H; OUT = os.path.join(H, "charts", "stroke"); os.makedirs(OUT, exist_ok=True)
d = core.load(); S = core.Surface(d); R = S.rpm; TODAY = core.today()(R)
BOXES = [1.44, 2.0, 2.75, 3.5]
STROKES = list(range(0, 151, 5))
LOS = list(range(-190, 1, 5))
TODAY_PLENUM_H = 120.0; CLEAR = 40.0

DC = {}
for f in sorted(glob.glob(os.path.join(H, "data", "duty_*.csv"))):
    x = pd.read_csv(f)
    if "frac" not in x: continue
    w = np.interp(R, (x.rpm_lo + x.rpm_hi) / 2, x.frac, left=0, right=0); DC[os.path.basename(f)[5:-4]] = w / w.sum()
DC_LABEL = {"ld416_ax": "4-16 AX, one gear (5.5k median)", "josh_0426": "Josh AX 4-26 (7.4k)",
            "ld416_optshift": "4-16 re-driven, ideal shifts (7.7k)", "ld419_endu": "4-19 endurance (8.6k)"}
W_P1 = np.where((R >= 6000) & (R <= 12000), 1.0, 0.15)
shifted = lambda T: np.interp(np.minimum(R * 1.04, R[-1]), R, T)
def band(T, lo, hi):
    m = (R >= lo) & (R <= hi); return (np.trapezoid((TODAY * T / S.base)[m], R[m]) / np.trapezoid(TODAY[m], R[m]) - 1) * 100
def duty(T, w, sh=False):
    a, b = (shifted(T), shifted(S.base)) if sh else (T, S.base)
    return (np.sum(w * TODAY * a / b) / np.sum(w * TODAY) - 1) * 100
def vrli(Venv, lo, st, w):
    if st == 0:
        return S.at(Venv, lo), np.full(len(R), float(lo))
    pos = np.arange(lo, lo + st + 1e-9, 5.0); Veff = Venv - BORE_A * (pos - lo)
    T = np.array([S.at(max(v, 0.3), p) for v, p in zip(Veff, pos)]).T
    step = max(1, int(round(200.0 / 3000.0 * (R[1] - R[0]) / 5.0)))
    path = core.dp_schedule(T / S.base[:, None], w, step)
    return T[np.arange(len(R)), path], pos[path]
def mass(st): return 0.0 if st == 0 else 0.30 + 0.42 * st / 100 + 0.30 * (st / 100) ** 0.7

# tip-in t90 by box volume (6000 rpm, as-built runner)
TI = {}
for l in open(os.path.join(H, "tipin_c160.ndjson")):
    x = json.loads(l)
    if x["rpm"] != 6000 or x["ext"] != 0 or "_L1.00_" not in x["cfg"]: continue
    r0 = x["rows"][0]; rr = x["rows"][1:]
    t = np.array([0] + [r["t"] for r in rr]); f = np.array([0] + [r["bt"] / r0["bt_ss"] for r in rr])
    k = next(i for i in range(len(f)) if (f[i:] >= 0.9).all())
    TI[float(x["cfg"].split("_")[0][1:])] = 1000 * (t[k - 1] + (0.9 - f[k - 1]) / (f[k] - f[k - 1]) * (t[k] - t[k - 1]))
tv = sorted(TI); t90 = lambda V: float(np.interp(math.log(V), np.log(tv), [TI[v] for v in tv]))

# ---------------- style (dataviz reference palette, light) ----------------
SURF, INK, INK2, MUTED, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#8a8984", "#e6e5e0"
BOXC = {1.44: "#2a78d6", 2.0: "#eb6834", 2.75: "#1baf7a", 3.5: "#eda100"}       # validated adjacent set, direct-labelled
RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"]                  # validated ordinal (5 strokes)
SEQ = LinearSegmentedColormap.from_list("seq", ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"])
plt.rcParams.update({"font.family": "Segoe UI", "font.size": 10.5, "axes.edgecolor": MUTED, "axes.labelcolor": INK2,
                     "xtick.color": INK2, "ytick.color": INK2, "axes.facecolor": SURF, "figure.facecolor": SURF,
                     "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.spines.top": False,
                     "axes.spines.right": False, "lines.linewidth": 2, "legend.frameon": False})
def head(fig, t, sub, note=None):
    h = fig.get_figheight()
    fig.text(0.012, 1 - 0.25 / h, t, fontsize=17, fontweight="bold", color=INK, va="top")
    fig.text(0.012, 1 - 0.62 / h, sub, fontsize=11, color=INK2, va="top")
    if note: fig.text(0.012, 0.012, note, fontsize=8.6, color=MUTED)
TOP = lambda fig: 1 - 1.05 / fig.get_figheight()
NOTE = ("1D engine model (160-cell plenum), neutral tune, scaled to the calibrated SDM26 sim. Runner lengths are above the head flange (engine/port excluded; today 248 mm). "
        "VRLI = trumpets telescoping inside the plenum box, 200 mm/s at 3000 rpm/s sweeps.")
def save(fig, n): fig.savefig(os.path.join(OUT, n), dpi=150); plt.close(fig); print("wrote", n)

