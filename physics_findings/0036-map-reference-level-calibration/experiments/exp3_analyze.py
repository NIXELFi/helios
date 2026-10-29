import os, sys
S = "C:/Users/nick5/AppData/Local/Temp/claude/C--Users-nick5/86aaf203-f5d9-4d19-95a0-d6f4a6685368/scratchpad"
os.environ["RUNS_0035"] = S + "/exp3runs"
sys.path.insert(0, "C:/Users/nick5/helios/physics_findings/0035-collector-merge-lambda-lag/scripts")
from lib import *
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt

def nrm(s):
    s = s.reindex(GRID); return s / s.mean()

car = nrm(PW).loc[5500:10000]                      # PW*lambda, WOT lag (secondary)
MV = pd.read_csv(S + "/exp1/ve_map_reference.csv").set_index("bin").ve_map.reindex(GRID)
carm = nrm(MV).loc[5500:10000]                     # MAP-VE (primary)

def slope_on(v, c):
    j = pd.concat([v, c], axis=1).dropna()
    return np.polyfit(j.iloc[:, 1] - 1, j.iloc[:, 0] - 1, 1)[0]

def stats(n):
    m = load(n); v = nrm(m.ve_del).loc[5500:10000]; fine = m.ve_del
    r = dict(variant=n, slope_map=slope_on(v, carm), rMAP=corr(m.ve_del.reindex(GRID), MV),
             slope_wot=slope_on(v, car), rWOT=corr(m.ve_del.reindex(GRID), PW), r270=corr(m.ve_del.reindex(GRID), P),
             ripple_std=v.std(), depth=depth(m.ve_del),
             pk6=int(fine.loc[5500:7000].idxmax()), tr78=int(fine.loc[7000:8500].idxmin()), pk9=int(fine.loc[8500:10000].idxmax()),
             ve_mean=m.ve_del.reindex(GRID).mean())
    jj = dy.join(m[["P_kW"]], how="inner"); dP = jj.P_kW * 0.85 - jj.brake_power_kW
    for lab, lo, hi in [("6-8.5", 6000, 8500), ("7-10.5", 7000, 10500), ("6-10.5", 6000, 10500)]:
        r[f"rmse{lab}"] = np.sqrt((dP.loc[lo:hi] ** 2).mean())
    return r

names = [n for n in sorted(os.listdir(S + "/exp3runs"))
         if len([f for f in os.listdir(S + "/exp3runs/" + n) if f[0].isdigit()]) >= 28]
T = pd.DataFrame([stats(n) for n in names]).set_index("variant")
T.round(4).to_csv(S + "/exp3out/variants.csv")
b = T.loc["base"]
pairs = [("exhaust valve Cd +-20%", "cdex_0.8", "cdex_1.2"), ("intake valve Cd +-20%", "cdin_0.8", "cdin_1.2"),
         ("EVO +-10 deg", "evo_-10", "evo_+10"), ("IVC +-10 deg", "ivc_-10", "ivc_+10"),
         ("exhaust max lift +-15%", "exlift_-15", "exlift_+15"), ("intake max lift +-15%", "inlift_-15", "inlift_+15"),
         ("lift shape exp 1.0 / 1.6", "shape_1.0", "shape_1.6"), ("runner entry K 0.05 / 0.5", "entryk_0.05", "entryk_0.5"),
         ("spark +5 deg (one-sided)", None, "spark_+5")]
rows = []
for lab, lo, hi in pairs:
    if hi not in T.index or (lo and lo not in T.index):
        continue
    L = T.loc[lo] if lo else b; Hh = T.loc[hi]
    h = lambda col: (Hh[col] - L[col]) / 2 if lo else (Hh[col] - b[col])
    rows.append(dict(input=lab, d_slope_map=h("slope_map"), d_rMAP=h("rMAP"),
                     slope_map_lo=L.slope_map, slope_map_hi=Hh.slope_map,
                     d_slope_wot=h("slope_wot"), d_rWOT=h("rWOT"), d_ripple=h("ripple_std"), d_depth=h("depth"),
                     d_rmse6_10p5=h("rmse6-10.5"), ve_mean_lo=L.ve_mean, ve_mean_hi=Hh.ve_mean))
R = pd.DataFrame(rows)
R["abs_d_slope_map"] = R.d_slope_map.abs(); R = R.sort_values("abs_d_slope_map", ascending=False)
R.round(4).to_csv(S + "/exp3out/ranking.csv", index=False)
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
print("car MAP-VE ripple std 5.5-10k", round(carm.std(), 4), " car PW*lam", round(car.std(), 4))
print(T.round(3).to_string()); print(); print(R.round(3).to_string(index=False))

INK, INK2, GR, SURF = '#1f1e1c', '#52514e', '#e4e3df', '#fcfcfb'
plt.rcParams.update({'font.size': 9, 'axes.facecolor': SURF, 'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GR,
                     'axes.spines.top': False, 'axes.spines.right': False, 'axes.edgecolor': INK2, 'lines.linewidth': 2})
fig, ax = plt.subplots(1, 2, figsize=(12.5, 4.8))
a = ax[0]
a.plot(GRID / 1000, nrm(MV), color=INK, lw=2.6, label="car MAP-VE (exp1, primary)")
a.plot(GRID / 1000, nrm(PW), color=INK2, lw=1.2, ls=':', label="car PW·λ, WOT lag (secondary)")
a.plot(GRID / 1000, nrm(load("base").ve_del), color='#2a78d6', label=f"model base (M10), MAP-VE slope {b.slope_map:.2f}")
for r_, c in zip(R.head(2).itertuples(), ['#eb6834', '#1baf7a']):
    p = [x for x in pairs if x[0] == r_.input][0]
    for v, ls in [(p[1], ':'), (p[2], '-')]:
        if v:
            a.plot(GRID / 1000, nrm(load(v).ve_del), color=c, ls=ls, lw=1.5, label=f"{v}  slope {T.loc[v].slope_map:.2f}")
a.set_xlabel("engine speed (krpm)"); a.set_ylabel("VE / mean (4-10.75k)")
a.set_title("VE shape: base vs the two strongest inputs", loc='left'); a.legend(fontsize=7)
a = ax[1]; y = np.arange(len(R))
a.barh(y, R.d_slope_map, color=['#2a78d6' if d >= 0 else '#eb6834' for d in R.d_slope_map], height=0.6)
a.set_yticks(y); a.set_yticklabels(R.input); a.invert_yaxis(); a.axvline(0, color=INK2, lw=1)
a.set_xlabel(f"Δ in-phase slope vs car MAP-VE per plausible half-range (base {b.slope_map:.2f}, car = 1)")
a.set_title("What sets the in-phase ripple amplitude", loc='left')
fig.tight_layout(); fig.savefig(S + "/exp3out/fig_excitation.png", dpi=130)
