"""Finding 0039 charts: full intake design study (static + VRLI + plenum geometry + restrictor + tip-in)."""
import os, json, math, numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap, TwoSlopeNorm
import core
from core import BANDS, BORE_A, OUTSIDE0, band_mean
OUT = os.path.join(core.H, "charts"); os.makedirs(OUT, exist_ok=True)
d = core.load(); S = core.Surface(d); R = S.rpm; TODAY = core.today()(R); DY = core.dyno()
EST = lambda T: TODAY * T / S.base                                  # estimated wheel torque (calibrated basis)
def auc(T, band="P1 6-12k"): return (band_mean(R, EST(T), band) / band_mean(R, TODAY, band) - 1) * 100
outside = lambda ext: OUTSIDE0 + ext                                # runner length above the head flange (mm)
HP = lambda T: T * R * 2 * math.pi / 60 / 745.7

INK, INK2, MUTED, GRID, SURFC, SHADE = "#1f1e1c", "#52514e", "#8a8984", "#e6e5e0", "#ffffff", "#f4f3ef"
CAT = ["#2a78d6", "#eb6834", "#1baf7a", "#8e5bd0"]
DIV = LinearSegmentedColormap.from_list("div", ["#b02c2c", "#e34948", "#f2a7a6", "#f0efec", "#86b6ef", "#2a78d6", "#0d366b"])
SEQ = LinearSegmentedColormap.from_list("seq", ["#f4f8fd", "#cfe1f7", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"])
plt.rcParams.update({"font.family": "Segoe UI", "font.size": 10, "axes.edgecolor": INK2, "axes.labelcolor": INK2,
                     "xtick.color": INK2, "ytick.color": INK2, "axes.facecolor": SURFC, "figure.facecolor": SURFC,
                     "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.spines.top": False,
                     "axes.spines.right": False, "lines.linewidth": 2, "legend.frameon": False})
def title(fig, t, sub=None, note=None):
    h = fig.get_figheight()
    fig.text(0.01, 1 - 0.22 / h, t, ha="left", va="top", fontsize=16, fontweight="bold", color=INK)
    if sub: fig.text(0.01, 1 - 0.56 / h, sub, ha="left", va="top", fontsize=10.5, color=INK2)
    if note: fig.text(0.01, 0.006, note, fontsize=8.3, color=MUTED)
def TOP(fig): return 1 - 0.95 / fig.get_figheight()
def save(fig, name): fig.savefig(os.path.join(OUT, name), dpi=150); plt.close(fig); print("wrote", name)
NOTE = ("Estimated wheel torque = calibrated SDM26 sim today (logged tune, wheel = brake x 0.94) x the 1D model's torque ratio "
        "vs the as-built intake (neutral tune). Throat 20 mm, runner diameters unchanged.")
EXTS = S.exts; VS = S.Vs
res = {}

# ---------- 1. AUC heatmaps: plenum volume x runner length, three bands ----------
A = {b: np.array([[auc(S.at(V, e), b) for V in VS] for e in EXTS]) for b in BANDS}
fig, axs = plt.subplots(1, 3, figsize=(18, 6.6), sharey=True)
for ax, b in zip(axs, BANDS):
    M = A[b]; lim = max(8, np.nanmax(np.abs(M)))
    im = ax.pcolormesh(np.arange(len(VS)), np.arange(len(EXTS)), M, cmap=DIV, norm=TwoSlopeNorm(0, -lim, lim), shading="nearest")
    for i, e in enumerate(EXTS):
        for j, V in enumerate(VS):
            v = M[i, j]; ax.text(j, i, f"{v:+.1f}", ha="center", va="center", fontsize=7.6, color="white" if abs(v) > 0.55 * lim else INK)
    k = np.unravel_index(np.nanargmax(M), M.shape); ax.add_patch(plt.Rectangle((k[1] - .5, k[0] - .5), 1, 1, fill=False, ec=INK, lw=2.4))
    ax.add_patch(plt.Rectangle((list(VS).index(1.44) - .5, list(EXTS).index(0) - .5), 1, 1, fill=False, ec=INK, lw=1.2, ls="--"))
    ax.set_yticks(range(len(EXTS))); ax.set_yticklabels([f"{outside(e):.0f}" for e in EXTS])
    ax.set_xticks(range(len(VS))); ax.set_xticklabels([f"{v:g}" for v in VS]); ax.set_xlabel("plenum volume (L)")
    ax.set_title(f"{b} average torque vs as-built (%)", loc="left", fontsize=12, color=INK, fontweight="semibold"); ax.grid(False)
axs[0].set_ylabel("runner length above head flange (mm)   [+80 mm port]")
title(fig, "Static intake: plenum volume x runner length", "Dashed box = as-built SDM26 (1.44 L, 248 mm). Bold box = best cell for that band. Each panel has its own colour range.", NOTE)
fig.subplots_adjust(left=0.05, right=0.99, top=TOP(fig) - 0.02, bottom=0.1, wspace=0.08); save(fig, "01_static_grid_auc.png")
res["static_grid"] = {b: pd.DataFrame(A[b], index=outside(EXTS), columns=VS).round(2).to_dict() for b in BANDS}

# ---------- 2. 2-D grid of torque curves (small multiples) ----------
Vsel = [v for v in [0.5, 1.0, 1.44, 2.0, 3.5] if v in VS]
Esel = [-190, -115, -40, 0, 60, 160]
fig, axs = plt.subplots(len(Esel), len(Vsel), figsize=(3.3 * len(Vsel), 2.3 * len(Esel)), sharex=True, sharey=True)
for i, e in enumerate(Esel[::-1]):
    for j, V in enumerate(Vsel):
        ax = axs[i, j]; ax.axvspan(6, 12, color=SHADE, zorder=0)
        ax.plot(DY.rpm / 1000, DY.Nm, color=MUTED, lw=1, zorder=2)
        ax.plot(R / 1000, TODAY, color=INK, lw=1.6, zorder=3)
        y = EST(S.at(V, e)); a = auc(S.at(V, e))
        ax.plot(R / 1000, y, color=CAT[0] if a >= 0 else CAT[1], lw=2.2, zorder=4)
        ax.text(0.97, 0.06, f"{a:+.1f}%", transform=ax.transAxes, ha="right", fontsize=11, fontweight="bold", color=INK)
        if i == 0: ax.set_title(f"{V:g} L plenum", fontsize=11, color=INK)
        if j == 0: ax.set_ylabel(f"{outside(e):.0f} mm", fontsize=10.5, color=INK)
        if V == 1.44 and e == 0:
            for s_ in ax.spines.values(): s_.set_visible(True); s_.set_color(INK); s_.set_linewidth(2)
axs[0, 0].set_ylim(22, 60); axs[0, 0].set_xlim(4, 12.6)
for ax in axs[-1]: ax.set_xlabel("krpm")
title(fig, "Torque curves across the design grid", "Rows: runner length above the head flange (long at top). Columns: plenum volume. "
      "Black = today's calibrated sim, gray = team dyno, colour = design (blue gains / orange loses 6-12k average). Boxed = as-built.", NOTE)
fig.tight_layout(rect=(0, 0.02, 1, TOP(fig))); save(fig, "02_torque_curve_grid.png")

# ---------- 3. where it matters: rpm-resolved sensitivity ----------
fig, axs = plt.subplots(1, 2, figsize=(17, 6.4))
ax = axs[0]
G = np.array([(S.at(1.44, e) / S.base - 1) * 100 for e in EXTS])
lim = np.nanmax(np.abs(G)); im = ax.pcolormesh(R / 1000, np.arange(len(EXTS)), G, cmap=DIV, norm=TwoSlopeNorm(0, -lim, lim), shading="nearest")
cs = ax.contour(R / 1000, np.arange(len(EXTS)), G, levels=[-10, -5, 5, 10], colors=[INK2], linewidths=0.7); ax.clabel(cs, fmt=lambda v: f"{v:+.0f}%", fontsize=8)
ax.plot(R / 1000, np.nanargmax(G, 0), color=INK, ls="--", lw=1.3); ax.axhline(list(EXTS).index(0), color=INK, lw=1.8)
ax.set_yticks(range(len(EXTS))); ax.set_yticklabels([f"{outside(e):.0f}" for e in EXTS])
ax.set_title("Runner length at 1.44 L: torque vs as-built (%)", loc="left", fontsize=12, fontweight="semibold", color=INK)
ax.set_xlabel("krpm"); ax.set_ylabel("runner above flange (mm)"); ax.grid(False); fig.colorbar(im, ax=ax, pad=0.01)
ax = axs[1]
G2 = np.array([(S.at(V, 0) / S.base - 1) * 100 for V in VS])
lim2 = max(3, np.nanmax(np.abs(G2))); im = ax.pcolormesh(R / 1000, np.arange(len(VS)), G2, cmap=DIV, norm=TwoSlopeNorm(0, -lim2, lim2), shading="nearest")
ax.set_yticks(range(len(VS))); ax.set_yticklabels([f"{v:g} L" for v in VS]); ax.axhline(list(VS).index(1.44), color=INK, lw=1.8)
ax.set_title("Plenum volume at as-built runner: torque vs as-built (%)", loc="left", fontsize=12, fontweight="semibold", color=INK)
ax.set_xlabel("krpm"); ax.grid(False); fig.colorbar(im, ax=ax, pad=0.01)
title(fig, "Where each knob acts in the rpm range", "Blue = more torque than as-built, red = less (note the different colour ranges). Dashed = best runner at each rpm.", NOTE)
fig.tight_layout(rect=(0, 0.02, 1, TOP(fig))); save(fig, "03_where_it_acts.png")

# ---------- coarse-grid helpers (G2 / G3 run at 500 rpm steps) ----------
def coarse(grid, V=1.44, **kw):
    x = d[(d.grid == grid) & np.isclose(d.V, V)]
    for k, v in kw.items(): x = x[np.isclose(x[k], v)]
    return x
RC = np.arange(4000, 12501, 500.0)
def auc_rel(Tc, Tref, band="P1 6-12k"):
    """% change of estimated band-average torque of Tc vs Tref, both on the 500-rpm grid."""
    t = np.interp(RC, R, TODAY); return (band_mean(RC, t * Tc / Tref, band) / band_mean(RC, t, band) - 1) * 100
def g1c(V, e): return np.interp(RC, R, S.at(V, e))

# ---------- 4. plenum geometry at fixed volume ----------
fig, axs = plt.subplots(1, 3, figsize=(17, 5.4), sharey=True); rows = []
for ax, V in zip(axs, [0.75, 1.44, 2.75]):
    for lf, c in [(0.5, CAT[1]), (1.0, INK), (2.0, CAT[0])]:
        ys = []
        for e in [-140, -40, 60, 160]:
            if lf == 1.0: T = g1c(V, e)
            else:
                x = coarse("G2", V=V, lf=lf, ext=e).sort_values("rpm")
                if len(x) < len(RC): ys.append(np.nan); continue
                T = x.bt.values
            ys.append(auc_rel(T, np.interp(RC, R, S.base))); rows.append(dict(V=V, lf=lf, ext=e, auc=ys[-1]))
        h = 120 * lf; dmax = 167 * math.sqrt(V / 1.44 / lf)
        ax.plot(outside(np.array([-140, -40, 60, 160])), ys, "o-", color=c, ms=7, label=f"{h:.0f} mm tall, {dmax:.0f} mm dia" + ("  (as-built shape)" if lf == 1 else ""))
    ax.set_title(f"{V:g} L", loc="left", fontsize=13, fontweight="semibold", color=INK); ax.legend(fontsize=9, loc="lower right"); ax.set_xlabel("runner above flange (mm)")
axs[0].set_ylabel("P1 6-12k avg torque vs as-built (%)")
title(fig, "Plenum shape at constant volume", "Same bell loft stretched: squat (half height) / as-built (120 mm) / tall (double height). Restrictor at the top, runners on the floor.", NOTE)
fig.tight_layout(rect=(0, 0.02, 1, TOP(fig))); save(fig, "04_plenum_shape.png"); res["plenum_shape"] = rows

# ---------- 5. restrictor ----------
import study
fig, axs = plt.subplots(1, 3, figsize=(18, 5.6), gridspec_kw=dict(width_ratios=[1, 1, 0.8])); rrows = []
e = 0
for ax, VV in zip(axs[:2], [1.44, 2.75]):
    ref = g1c(VV, 0)
    douts = [30, 34, 38, 44, 50]; angs = [3.2, 6.0, 8.0]; M = np.full((len(angs), len(douts)), np.nan)
    for i, a in enumerate(angs):
        for j, D in enumerate(douts):
            x = coarse("G3", V=VV, dout=D, ang=a, ext=e, cd=0.95).sort_values("rpm")
            if D == 38 and a == 3.2: x = pd.DataFrame(dict(rpm=RC, bt=ref))
            if len(x) == len(RC) and len(ref) == len(RC):
                M[i, j] = auc_rel(x.bt.values, ref); top = auc_rel(x.bt.values, ref, "top 10.5-12.5k")
                L = (D - 20) / 2 / math.tan(math.radians(a)); rec = study.ETA_REL * study.R_idel(D / 1000, a)
                rrows.append(dict(V=VV, ext=e, dout=D, ang=a, diffuser_mm=round(L), recovery=round(rec, 3), auc_p1=round(M[i, j], 2), auc_top=round(top, 2),
                                  peak_bt_ratio=round(float(x.bt.max() / ref.max()), 4)))
    lim = max(2, np.nanmax(np.abs(M)) if np.isfinite(M).any() else 2)
    ax.pcolormesh(np.arange(len(douts)), np.arange(len(angs)), M, cmap=DIV, norm=TwoSlopeNorm(0, -lim, lim), shading="nearest")
    for i, a in enumerate(angs):
        for j, D in enumerate(douts):
            L = (D - 20) / 2 / math.tan(math.radians(a))
            ax.text(j, i, f"{M[i,j]:+.1f}%\n{L:.0f} mm", ha="center", va="center", fontsize=9, color=INK)
    ax.set_xticks(range(len(douts))); ax.set_xticklabels([f"{D}" for D in douts]); ax.set_yticks(range(len(angs))); ax.set_yticklabels([f"{a:g}°" for a in angs])
    ax.set_xlabel("diffuser outlet diameter (mm)"); ax.set_ylabel("diffuser half-angle"); ax.grid(False)
    ax.set_title(f"{VV:g} L plenum: P1 avg torque vs as-built venturi", loc="left", fontsize=11.5, fontweight="semibold", color=INK)
ax = axs[2]; ref = g1c(1.44, 0); cds = []
for cd in [0.93, 0.95, 0.97]:
    x = ref if cd == 0.95 else coarse("G3", dout=38, ang=3.2, ext=0, cd=cd).sort_values("rpm").bt.values
    ok = len(x) == len(RC) and len(ref) == len(RC)
    cds.append((cd, auc_rel(x, ref) if ok else np.nan, auc_rel(x, ref, "top 10.5-12.5k") if ok else np.nan))
ax.bar([f"Cd {c:.2f}" for c, _, _ in cds], [t for _, _, t in cds], color=[CAT[1], MUTED, CAT[0]], width=0.55)
for k, (c, p, t) in enumerate(cds):
    if np.isfinite(t): ax.text(k, t + (0.1 if t >= 0 else -0.1), f"{t:+.1f}% top\n{p:+.1f}% P1", ha="center", va="bottom" if t >= 0 else "top", fontsize=9, color=INK)
ax.axhline(0, color=INK2, lw=1); ax.set_ylabel("10.5-12.5k avg torque vs Cd 0.95 (%)")
m_ = max(1.0, np.nanmax(np.abs([t for _, _, t in cds])) if np.isfinite([t for _, _, t in cds]).any() else 1.0); ax.set_ylim(-1.6 * m_, 1.6 * m_)
ax.set_title("Throat discharge coefficient", loc="left", fontsize=11.5, fontweight="semibold", color=INK)
title(fig, "Restrictor venturi geometry (20 mm throat)", "Cells: % change and the diffuser length that geometry needs (throat to outlet). As-built = 38 mm, 3.2°, ~161 mm.",
      "Recovery = car-calibrated 0.62 x Idelchik loss; lumped venturi (no length/inertance). CAUTION: the OUTLET-diameter trend is a 1D artifact (the plenum bell after a small outlet acts "
      "as a lossless second diffuser) - size the outlet from 11_restrictor_length.png. The ANGLE trend at a fixed outlet is sound.")
fig.tight_layout(rect=(0, 0.03, 1, TOP(fig))); save(fig, "05_restrictor.png"); res["restrictor"] = rrows; res["cd"] = cds

# ---------- 6. VRLI: envelope x outside length x stroke ----------
def vr(Venv, lo, stroke, **kw): return core.vrli(S, Venv, lo, lo + stroke, **kw)
STROKES = [0, 25, 50, 75, 100, 150, 200, 250]; LOS = [-190, -140, -90, -40, 10, 60]
VENV = [1.0, 1.44, 2.0, 2.75, 3.5]
vrows = []
for Venv in VENV:
    for lo in LOS:
        for st in STROKES:
            if lo + st > EXTS[-1] or Venv - BORE_A * st < VS[0]: continue
            T, sch, Ve = vr(Venv, lo, st)
            vrows.append(dict(Venv=Venv, lo=lo, stroke=st, outside=outside(lo), auc=auc(T), drv=auc(T, "driver 7-10.5k"), top=auc(T, "top 10.5-12.5k"),
                              height_needed=st + 40, Veff_min=Venv - BORE_A * st, peak_hp=float(HP(EST(T)).max())))
VR = pd.DataFrame(vrows); res["vrli"] = VR.round(2).to_dict("records")
fig, axs = plt.subplots(1, len(VENV), figsize=(4 * len(VENV), 5.6), sharey=True)
for ax, Venv in zip(axs, VENV):
    x = VR[VR.Venv == Venv].pivot(index="lo", columns="stroke", values="auc").reindex(index=LOS, columns=STROKES)
    lim = 20; im = ax.pcolormesh(np.arange(len(STROKES)), np.arange(len(LOS)), x.values, cmap=DIV, norm=TwoSlopeNorm(0, -lim, lim), shading="nearest")
    for i in range(len(LOS)):
        for j in range(len(STROKES)):
            v = x.values[i, j]
            if np.isfinite(v): ax.text(j, i, f"{v:+.1f}", ha="center", va="center", fontsize=7.5, color="white" if abs(v) > 11 else INK)
    ax.set_xticks(range(len(STROKES))); ax.set_xticklabels(STROKES, fontsize=8); ax.set_xlabel("stroke into plenum (mm)"); ax.grid(False)
    ax.set_title(f"{Venv:g} L plenum box", loc="left", fontsize=12, fontweight="semibold", color=INK)
axs[0].set_yticks(range(len(LOS))); axs[0].set_yticklabels([f"{outside(l):.0f}" for l in LOS]); axs[0].set_ylabel("runner above flange, retracted (mm)")
cax = fig.add_axes([0.955, 0.14, 0.01, 0.6]); fig.colorbar(im, cax=cax).set_label("P1 6-12k vs as-built (%)")
title(fig, "VRLI: telescoping runners inside the plenum", "Stroke 0 = static runner. Extension moves 40 mm-bore air from plenum to runner (5.0 cm³/mm). Rate-feasible schedule at 200 mm/s, 3000 rpm/s sweeps. Blank = plenum would drop below 0.5 L or runner past 408 mm.", NOTE)
fig.subplots_adjust(left=0.05, right=0.94, top=TOP(fig) - 0.03, bottom=0.12, wspace=0.05); save(fig, "06_vrli_grid.png")

# VRLI actuator speed + displacement sensitivity, at the best 2 L-box design with stroke <= 150
best = VR[(VR.Venv == 2.0) & (VR.stroke <= 150)].sort_values("auc").iloc[-1]
sp = []
for s_ in [25, 50, 100, 200, 400, 1e6]:
    T, _, _ = vr(best.Venv, best.lo, best.stroke, speed=s_); sp.append((s_, auc(T), auc(T, "driver 7-10.5k")))
Tn, _, _ = core.vrli(S, best.Venv, best.lo, best.lo + best.stroke, displace=False)
res["vrli_speed"] = dict(design=best.to_dict(), speed=sp, no_displacement=auc(Tn))

# ---------- 7. options matrix (packaging envelope) ----------
CAPS_V = {"plenum ≤1.44 L (today)": 1.44, "≤2.75 L": 2.75, "≤3.5 L": 3.5}
CAPS_L = {"runner ≤248 mm (no longer)": 0, "runner ≤283 mm (+35)": 35}
MAXPRO = 150   # mm a runner may protrude / stroke into the plenum (needs a plenum ~190 mm tall)
opts = []
for ln, lcap in CAPS_L.items():
    for vn, vcap in CAPS_V.items():
        best_s = max(((auc(S.at(V, e)), V, e) for V in VS if V <= vcap + 1e-9 for e in EXTS if e <= lcap), key=lambda t: t[0])
        cand = []
        for Venv in [v for v in VS if v <= vcap + 1e-9]:
            for lo in [e for e in EXTS if e <= lcap]:
                for pro in range(0, MAXPRO + 1, 25):
                    if lo + pro > EXTS[-1] or Venv - BORE_A * pro < VS[0]: continue
                    cand.append((auc(S.at(Venv - BORE_A * pro, lo + pro)), Venv, lo, pro))
        best_p = max(cand, key=lambda t: t[0])
        vc = VR[(VR.Venv <= vcap + 1e-9) & (VR.lo <= lcap) & (VR.stroke <= MAXPRO)]
        bv = vc.sort_values("auc").iloc[-1] if len(vc) else None
        opts.append(dict(runner_cap=ln, plenum_cap=vn,
                         static=dict(auc=best_s[0], V=best_s[1], outside=outside(best_s[2])),
                         static_protruding=dict(auc=best_p[0], V_box=best_p[1], outside=outside(best_p[2]), protrusion=best_p[3], total_runner=outside(best_p[2]) + best_p[3]),
                         vrli=None if bv is None else dict(auc=bv.auc, V_box=bv.Venv, outside=bv.outside, stroke=bv.stroke)))
res["options"] = opts
fig, axs = plt.subplots(1, 3, figsize=(18, 6.2), sharey=True)
for ax, key, nm in zip(axs, ["static", "static_protruding", "vrli"], ["Static, runners outside the plenum", "Static, runners protrude into the plenum", "VRLI (telescoping into the plenum)"]):
    M = np.array([[o[key]["auc"] if o[key] else np.nan for o in opts if o["runner_cap"] == ln] for ln in CAPS_L])
    ax.pcolormesh(np.arange(len(CAPS_V)), np.arange(len(CAPS_L)), M, cmap=DIV, norm=TwoSlopeNorm(0, -8, 8), shading="nearest"); ax.grid(False)
    for i, ln in enumerate(CAPS_L):
        for j, vn in enumerate(CAPS_V):
            o = [o for o in opts if o["runner_cap"] == ln and o["plenum_cap"] == vn][0][key]
            if o is None: continue
            if key == "static": t = f"{o['auc']:+.1f}%\n{o['V']:g} L, {o['outside']:.0f} mm"
            elif key == "static_protruding": t = f"{o['auc']:+.1f}%\n{o['V_box']:g} L box\n{o['outside']:.0f} + {o['protrusion']} mm in"
            else: t = f"{o['auc']:+.1f}%\n{o['V_box']:g} L box\n{o['outside']:.0f} mm + {o['stroke']:.0f} stroke"
            ax.text(j, i, t, ha="center", va="center", fontsize=9.5, color=INK)
    ax.set_xticks(range(len(CAPS_V))); ax.set_xticklabels(list(CAPS_V), fontsize=9.5); ax.set_title(nm, loc="left", fontsize=12, fontweight="semibold", color=INK)
axs[0].set_yticks(range(len(CAPS_L))); axs[0].set_yticklabels([k.replace(" ≤", "\n≤") for k in CAPS_L], fontsize=9.5); axs[0].set_ylabel("runner length allowed above the head flange")
title(fig, "Best design in each packaging envelope (P1 6-12k average torque vs as-built)", "Each cell = the best grid design that fits that plenum-box volume and runner reach. Protrusion / VRLI stroke capped at 150 mm (needs a ~190 mm tall plenum).", NOTE)
fig.tight_layout(rect=(0, 0.02, 1, TOP(fig))); save(fig, "07_options_matrix.png")

# ---------- 8. throttle response (1D tip-in) ----------
TI = []
if os.path.exists(os.path.join(core.H, "tipin_c160.ndjson")):
    for l in open(os.path.join(core.H, "tipin_c160.ndjson")):
        x = json.loads(l); r0 = x["rows"][0]; rr = x["rows"][1:]
        if not rr: continue
        t = np.array([0] + [r["t"] for r in rr]); f = np.array([0] + [r["bt"] / r0["bt_ss"] for r in rr])
        above = f >= 0.9; k = next((i for i in range(len(f)) if above[i:].all()), None)
        t90 = np.nan if k is None or k == 0 else t[k - 1] + (0.9 - f[k - 1]) / (f[k] - f[k - 1]) * (t[k] - t[k - 1])
        deficit = float(np.sum((1 - f[1:]).clip(0) * np.diff(t))) * 1000
        pr = x["cfg"].split("_"); TI.append(dict(V=float(pr[0][1:]), lf=float(pr[1][1:]), ext=x["ext"], rpm=x["rpm"], t90=t90 * 1000, deficit_ms=deficit, t=t, f=f))
TI = pd.DataFrame(TI)
if len(TI):
    res["tipin"] = TI.drop(columns=["t", "f"]).round(1).to_dict("records")
    fig, axs = plt.subplots(1, 3, figsize=(18, 5.6), gridspec_kw=dict(width_ratios=[1.2, 1, 1]))
    ax = axs[0]
    for (V, e), c in zip([(0.5, -115), (1.44, 0), (3.5, 160)], [CAT[2], INK, CAT[1]]):
        x = TI[(TI.V == V) & (TI.ext == e) & (TI.rpm == 6000) & (TI.lf == 1)]
        if len(x): r = x.iloc[0]; ax.step(r.t * 1000, r.f * 100, where="post", color=c, lw=2.2, label=f"{V:g} L, {outside(e):.0f} mm: 90% at {r.t90:.0f} ms")
    ax.axhline(90, color=MUTED, ls=":", lw=1); ax.set_xlabel("ms after throttle snap (6000 rpm, 40 kPa MAP start)"); ax.set_ylabel("brake torque, % of steady WOT"); ax.legend(fontsize=9, loc="lower right")
    ax.set_title("Torque build after a throttle snap", loc="left", fontsize=12, fontweight="semibold", color=INK); ax.set_xlim(0, 200)
    for ax, rpm in zip(axs[1:], [6000, 8500]):
        x = TI[(TI.rpm == rpm) & (TI.lf == 1)].pivot(index="ext", columns="V", values="deficit_ms")
        ax.pcolormesh(np.arange(len(x.columns)), np.arange(len(x.index)), x.values, cmap=SEQ, shading="nearest"); ax.grid(False)
        for i in range(len(x.index)):
            for j in range(len(x.columns)):
                v = x.values[i, j]; ax.text(j, i, f"{v:.0f}", ha="center", va="center", fontsize=9, color="white" if v > np.nanpercentile(x.values, 65) else INK)
        ax.set_xticks(range(len(x.columns))); ax.set_xticklabels([f"{v:g}" for v in x.columns]); ax.set_yticks(range(len(x.index))); ax.set_yticklabels([f"{outside(e):.0f}" for e in x.index])
        ax.set_xlabel("plenum volume (L)"); ax.set_ylabel("runner above flange (mm)")
        ax.set_title(f"Lost torque after snap at {rpm} rpm (ms of full torque)", loc="left", fontsize=11.5, fontweight="semibold", color=INK)
    title(fig, "Throttle response: 1D tip-in transient", "Intake held at 40 kPa, then throttle opened fully at constant rpm. Lost torque = integral of (1 - T/T_steady) dt: lower is crisper.",
          "Includes manifold filling through the choked 20 mm throat AND the compression-heated air slug in the runners being ingested. Constant rpm (dyno-style); fuel film/ECU transients not modelled.")
    fig.tight_layout(rect=(0, 0.03, 1, TOP(fig))); save(fig, "08_throttle_response.png")

# ---------- 9. what matters: tornado of P1 AUC range per knob ----------
knobs = []
knobs.append(("Runner length 58-408 mm (1.44 L)", [auc(S.at(1.44, e)) for e in EXTS]))
knobs.append(("Plenum volume 0.5-3.5 L (as-built runner)", [auc(S.at(V, 0)) for V in VS]))
knobs.append(("Plenum volume 0.5-3.5 L (each at its best runner)", [max(auc(S.at(V, e)) for e in EXTS) - max(auc(S.at(1.44, e)) for e in EXTS) for V in VS]))
ps = pd.DataFrame(res["plenum_shape"]); ps = ps[(ps.V == 1.44) & ps.auc.notna()]
if len(ps): knobs.append(("Plenum shape: half / double height (1.44 L)", [r.auc - ps[(ps.lf == 1) & (ps.ext == r.ext)].auc.iloc[0] for r in ps.itertuples()]))
if res["restrictor"]:
    rs = pd.DataFrame(res["restrictor"]); rs = rs[(rs.ext == 0) & (rs.V == 1.44)]
    if os.path.exists(os.path.join(OUT, "restrictor_short.csv")):
        rsh = pd.read_csv(os.path.join(OUT, "restrictor_short.csv"))
        knobs.append(("Restrictor length 40-228 mm (best diffuser, ≤ 8°)", list(rsh["V1.44 P1 6-12k"]) + [0.0]))
    knobs.append(("Diffuser half-angle 3.2-8° (38 mm)", list(rs[rs.dout == 38].auc_p1)))
knobs.append(("Throat Cd 0.93-0.97", [p for _, p, _ in res["cd"] if np.isfinite(p)]))
v0 = VR[(VR.Venv == 1.44) & (VR.lo == -40) & (VR.stroke <= 150)]
if len(v0): knobs.append(("VRLI stroke 0-150 mm (1.44 L box, 208 mm retracted)", list(v0.auc)))
knobs.append(("VRLI actuator 25 mm/s to instant (best 2 L design)", [a - max(a2 for _, a2, _ in sp) for _, a, _ in sp]))
knobs = [(n, v) for n, v in knobs if len(v)]
res["knobs"] = [(n, float(np.nanmin(v)), float(np.nanmax(v))) for n, v in knobs]
fig, ax = plt.subplots(figsize=(12, 0.62 * len(knobs) + 1.9))
for i, (n, v) in enumerate(knobs[::-1]):
    lo_, hi_ = float(np.nanmin(v)), float(np.nanmax(v)); ax.barh(i, max(hi_ - lo_, 0.05), left=lo_, color=CAT[0] if hi_ - lo_ > 3 else MUTED, height=0.55)
    ax.text(max(hi_, 0) + 0.3, i, f"{hi_ - lo_:.1f} pts", va="center", fontsize=9.5, color=INK)
ax.set_yticks(range(len(knobs))); ax.set_yticklabels([n for n, _ in knobs[::-1]]); ax.axvline(0, color=INK2, lw=1)
ax.set_xlabel("P1 6-12k average torque vs as-built (%): full range the knob spans")
title(fig, "Which knobs matter for area under the curve", "Bar = spread of 6-12k average torque across that knob's swept range (others at as-built). Blue > 3 points.", NOTE)
fig.tight_layout(rect=(0, 0.03, 1, TOP(fig))); save(fig, "09_what_matters.png")

# ---------- 10. recommended options vs today + dyno ----------
def cell(ln, vn): return [o for o in opts if o["runner_cap"] == ln and o["plenum_cap"] == vn][0]
L_ = list(CAPS_L); V_ = list(CAPS_V); picks = []
for tag, ln, vn in [("A", L_[0], V_[0]), ("B", L_[0], V_[2]), ("C", L_[1], V_[2])]:
    o = cell(ln, vn)
    st = o["static"]; picks.append((f"Static-{tag}: {st['V']:g} L, {st['outside']:.0f} mm", S.at(st["V"], st["outside"] - OUTSIDE0), "static"))
    sp_ = o["static_protruding"]
    if sp_["protrusion"] > 0:
        picks.append((f"Static-{tag}+: {sp_['V_box']:g} L box, {sp_['outside']:.0f} + {sp_['protrusion']} mm in", S.at(sp_["V_box"] - BORE_A * sp_["protrusion"], sp_["outside"] - OUTSIDE0 + sp_["protrusion"]), "static"))
    v = o["vrli"]
    if v: T, sch, _ = core.vrli(S, v["V_box"], v["outside"] - OUTSIDE0, v["outside"] - OUTSIDE0 + v["stroke"]); picks.append((f"VRLI-{tag}: {v['V_box']:g} L box, {v['outside']:.0f} mm + {v['stroke']:.0f} stroke", T, "vrli"))
res["picks"] = []
fig, axs = plt.subplots(2, 2, figsize=(17, 11), sharex=True)
for col, kind in enumerate(["static", "vrli"]):
    sel = [p for p in picks if p[2] == kind]; cols = ["#1baf7a", "#2a78d6", "#8e5bd0", "#eb6834", "#0d366b", "#b02c2c"]
    for row, (fn, lab) in enumerate([(lambda T: EST(T), "wheel torque (N·m)"), (lambda T: HP(EST(T)), "wheel power (hp)")]):
        ax = axs[row, col]; ax.axvspan(6, 12, color=SHADE, zorder=0)
        ax.plot(DY.rpm / 1000, DY.Nm if row == 0 else DY.hp, color=MUTED, lw=1.1, label="team dyno", zorder=2)
        ax.plot(R / 1000, TODAY if row == 0 else HP(TODAY), color=INK, lw=2.6, label="today's sim (as-built, calibrated)", zorder=5)
        for (nm, T, _), c in zip(sel, cols):
            y = fn(T)
            lbl = nm + (f"   {auc(T):+.1f}% P1 / {auc(T, 'driver 7-10.5k'):+.1f}% drv" if row == 0 else f"   peak {HP(EST(T)).max():.1f} hp, avg 6-12k {band_mean(R, HP(EST(T)), 'P1 6-12k'):.1f}")
            ax.plot(R / 1000, y, color=c, lw=2, label=lbl, zorder=4)
            if row == 0: res["picks"].append(dict(name=nm, auc=auc(T), drv=auc(T, "driver 7-10.5k"), top=auc(T, "top 10.5-12.5k"), peak_hp=float(HP(EST(T)).max()), avg_hp=band_mean(R, HP(EST(T)), "P1 6-12k")))
        ax.set_ylabel(lab); ax.legend(fontsize=8.6, loc="lower center" if row == 0 else "upper left", framealpha=0.92, frameon=True, edgecolor="none")
        if row == 0: ax.set_title("Static intake options" if kind == "static" else "VRLI options", loc="left", fontsize=13, fontweight="semibold", color=INK)
        else: ax.set_xlabel("engine speed (krpm)")
axs[0, 0].set_ylim(25, 60); axs[0, 1].set_ylim(25, 60); axs[1, 0].set_xlim(4, 12.6)
res["today"] = dict(peak_hp=float(HP(TODAY).max()), avg_hp=band_mean(R, HP(TODAY), "P1 6-12k"))
title(fig, "Recommended intake options, small to large", "A = today's envelope (runner ≤248 mm, plenum ≤1.44 L), B = bigger plenum (≤3.5 L), C = bigger plenum + 35 mm more reach. '+' = runners protrude into the plenum.", NOTE)
fig.tight_layout(rect=(0, 0.02, 1, TOP(fig))); save(fig, "10_options_torque_power.png")
json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=float)
