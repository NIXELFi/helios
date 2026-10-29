"""Finding 0039: how short can the restrictor get? Torque vs venturi length.

The 1D model's venturi is a quasi-steady boundary: the diffuser acts only through its pressure recovery R (fraction of
throat dynamic pressure recovered). G4 simulates torque vs R directly. Here every candidate geometry (outlet diameter,
half-angle <= 8 deg: Nick, flow won't stay attached beyond) is mapped to R with the same car-calibrated Idelchik relation
study.py uses, and to its length, giving torque vs restrictor length.

Length = converging bellmouth + throat land + diffuser. The converging side is quasi-steady in the model (only Cd), so
it is held at a short bellmouth (CONV_MM) with the as-built Cd; the diffuser is the part that scales.
"""
import os, json, math, numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
import core, study

H = core.H; OUT = os.path.join(H, "charts"); os.makedirs(OUT, exist_ok=True)
AS_BUILT_TOTAL_MM = 228.0      # config _restrictor_note: 228 mm venturi
CONV_MM, THROAT_MM = 25.0, 5.0 # assumed short bellmouth inlet + throat land for the new designs

d = core.load(); g = d[d.grid == "G4"]
if g.empty:
    raise SystemExit("no G4 rows yet")
BANDS = {"top 10.5-12.5k": (10500, 12500), "P1 6-12k": (6000, 12000), "driver 7-10.5k": (7000, 10500)}
res = {}
for V, x in g.groupby("V"):
    piv = x.pivot_table(index="R", columns="rpm", values="bt")
    if piv.isna().any().any() or 0.57 not in piv.index.round(2):
        print(f"V{V}: incomplete G4 ({len(x)} rows)"); continue
    R = piv.columns.values.astype(float); ref = piv.loc[piv.index[np.argmin(abs(piv.index - 0.572))]].values
    res[V] = {b: {float(Rv): float(np.trapezoid(piv.loc[Rv].values[(R >= lo) & (R <= hi)], R[(R >= lo) & (R <= hi)]) /
                                   np.trapezoid(ref[(R >= lo) & (R <= hi)], R[(R >= lo) & (R <= hi)]) * 100 - 100)
                  for Rv in piv.index} for b, (lo, hi) in BANDS.items()}
    res[V]["by_rpm"] = {float(Rv): list(np.round((piv.loc[Rv].values / ref - 1) * 100, 2)) for Rv in piv.index}
    res[V]["rpm"] = list(R)

geo = []
for ang in (3.2, 4.0, 5.0, 6.0, 7.0, 8.0):
    for dout in np.arange(22, 45, 1.0):
        L = (dout - 20) / 2 / math.tan(math.radians(ang))
        Rv = study.ETA_REL * study.R_idel(dout / 1000, ang)
        geo.append(dict(ang=ang, dout=dout, diffuser_mm=L, total_mm=CONV_MM + THROAT_MM + L, R=Rv))
G = pd.DataFrame(geo)
for V, r in res.items():
    for b in BANDS:
        Rs = np.array(sorted(r[b])); T = np.array([r[b][k] for k in Rs])
        G[f"V{V:g} {b}"] = np.interp(G.R, Rs, T)
# Pareto: best recovery for each total-length budget
budgets = [40, 50, 60, 70, 80, 100, 120, 150, 200]
front = []
for Lb in budgets:
    x = G[G.total_mm <= Lb]
    if len(x): front.append(dict(budget_mm=Lb, **x.sort_values("R").iloc[-1].to_dict()))
F = pd.DataFrame(front)
F.round(3).to_csv(os.path.join(OUT, "restrictor_short.csv"), index=False)
json.dump(res, open(os.path.join(OUT, "restrictor_R_sweep.json"), "w"), indent=1)
pd.set_option("display.width", 220)
print(F.round(2).to_string(index=False))

# chart: torque vs total restrictor length (Pareto), per plenum, top-end and 6-12k bands
INK, MUTED, GRID = "#1f1e1c", "#8a8984", "#e6e5e0"; CAT = ["#2a78d6", "#eb6834", "#1baf7a"]
plt.rcParams.update({"font.family": "Segoe UI", "font.size": 10, "axes.grid": True, "grid.color": GRID, "axes.spines.top": False, "axes.spines.right": False})
fig, axs = plt.subplots(1, 2, figsize=(15, 5.6))
for ax, b in zip(axs, ["top 10.5-12.5k", "P1 6-12k"]):
    for (V, _), c in zip(res.items(), CAT):
        ax.plot(F.total_mm, F[f"V{V:g} {b}"], "o-", color=c, label=f"{V:g} L plenum")
    ax.axvline(AS_BUILT_TOTAL_MM, color=MUTED, ls=":", lw=1); ax.text(AS_BUILT_TOTAL_MM, ax.get_ylim()[0], " as-built 228 mm", color=MUTED, fontsize=8.5, va="bottom")
    ax.axhline(0, color=INK, lw=0.8); ax.set_xlabel("restrictor total length (mm): 25 mm bellmouth + 5 mm throat + diffuser")
    ax.set_ylabel(f"{b} torque vs as-built venturi (%)"); ax.legend(frameon=False)
    for _, r in F.iterrows():
        ax.annotate(f"{r.dout:.0f} mm, {r.ang:g}°", (r.total_mm, r[f"V{list(res)[0]:g} {b}"]), textcoords="offset points", xytext=(4, -12), fontsize=7.5, color=MUTED)
    ax.set_title(b, loc="left", fontsize=12, fontweight="semibold", color=INK)
fig.suptitle("How short can the restrictor be? Best diffuser for each length budget (half-angle ≤ 8°)", x=0.01, ha="left", fontsize=15, fontweight="bold", color=INK)
fig.text(0.01, 0.005, "Model: quasi-steady venturi, diffuser enters only via pressure recovery (car-calibrated 0.62 x Idelchik loss vs angle/area ratio). "
         "Diffuser length/inertance and asymmetric stall are not modelled.", fontsize=8, color=MUTED)
fig.tight_layout(rect=(0, 0.03, 1, 0.94)); fig.savefig(os.path.join(OUT, "11_restrictor_length.png"), dpi=150); print("wrote 11_restrictor_length.png")
