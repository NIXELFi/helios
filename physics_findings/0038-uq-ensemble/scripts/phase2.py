# Finding 0038 phase 2: propagate the phase-1 posterior through the VRLI
# stroke optimiser (helios-bench vrli, finding 0037).
#
#   python phase2.py prepare  -> resample the posterior, write one VRLI study per unique sample
#   python phase2.py run      -> run the surfaces, then --analyze-only at each sweep rate
#   python phase2.py collect  -> per-stroke gain / P2 / placement distributions + the 0037 design
#
# Each sample's study is the 0037 A_neutral_disp study (neutral tune, 44 mm
# trumpet OD, displacement ref 0, same design block and packaging cap) on a
# coarser grid (extension -140..+120), with the sample's applied parameter values as `overrides` on
# the same base config. The engine-sim knobs are all apply_override paths,
# so no per-sample config file is needed.
import os, sys, json, subprocess
import numpy as np, pandas as pd

H = os.path.dirname(os.path.abspath(__file__))
F = os.path.normpath(os.path.join(H, ".."))
REPO = os.path.normpath(os.path.join(F, "..", ".."))
P2 = os.path.join(F, "out", "phase2")
EXE = os.environ.get("HELIOS_BENCH", os.path.join(REPO, "target", "release", "helios-bench.exe"))
N_RESAMPLE = 16
SEED = 380
STROKES = [0, 25, 50, 75, 100, 125, 150, 175]
CAPS = [0, 20, 40, 60, 80, 100, 115]   # long-end limit: extension over as-built (mm)
RATES = [("table", None), ("dyno_500", 500.0), ("gear2_3000", 3000.0), ("gear1_6000", 6000.0)]
# Design envelope (coordinator, 2026-09-29): the long end may be a little longer than
# as-built; score every (long-end cap x stroke) cell like the 0037 deterministic envelope
# (best placement with lmax <= cap). ECU band + key cells use the 0037 recommendation.
REC = dict(stroke=100.0, lmin=15.0)   # 100 mm at +15..+115 (runner 343-443 mm)
BASE_RUNNER_MM = 328.1

VRLI = """[vrli]
config = "../../../../../apps/desktop/src-tauri/resources/cfd/configs/sdm26_asbuilt_cal.json"
cycles = 30
threads = 15
tune = "neutral"
trumpet_od_mm = 44.0
displacement_ref_mm = 0.0
rpm = {{ min = 6000, max = 12500, step = 500 }}
extension_mm = {{ min = -140, max = 120, step = 20 }}
cache = "cache_{s}.ndjson"
avg_cycles = 5
conv_window = 6
max_spread = 0.02

[vrli.overrides]
{overrides}

[design]
band_rpm = [6000, 12000]
driver_band_rpm = [7000, 10500]
baseline_extension_mm = 0.0
strokes_mm = {strokes}
placement_step_mm = 5.0
position_step_mm = 1.0
f3_resolution_mm = 2.0
sweep_rate_rpm_s = {rate}
full_stroke_time_s = 0.5
metric = "torque"
knee_fraction = 0.9
max_protrusion_mm = 200.0
min_plenum_fraction = 0.5

[design.mass]
fixed_kg = 0.30
per_100mm_kg = 0.42
actuator_kg_at_100mm = 0.30
actuator_exponent = 0.7
limit_kg = 1.5
"""


def resample(S):
    """Systematic resampling of the tempered posterior -> {sample: count}."""
    w = S.weight.values / S.weight.sum()
    rng = np.random.default_rng(SEED)
    u = (rng.random() + np.arange(N_RESAMPLE)) / N_RESAMPLE
    idx = np.minimum(np.searchsorted(np.cumsum(w), u), len(w) - 1)
    return pd.Series(S.index.values[idx]).value_counts().sort_index()


def toml_for(s, applied, rate):
    ov = "\n".join(f'{k} = {v!r}' for k, v in sorted(applied.items()))
    # "table" = quasi-steady; the follow metric needs a finite rate, 1 rpm/s is effectively static
    return VRLI.format(s=s, overrides=ov, strokes=STROKES, rate=(rate if rate else 1.0))


def prepare():
    os.makedirs(P2, exist_ok=True)
    S = pd.read_csv(os.path.join(F, "out", "samples_scored.csv"), index_col=0)
    counts = resample(S)
    rows = []
    for s, c in counts.items():
        r = S.loc[s]
        applied = {k.split(":", 1)[1]: float(r[k]) for k in S.columns if k.startswith("applied:")}
        d = os.path.join(P2, f"s{s}")
        os.makedirs(d, exist_ok=True)
        for tag, rate in RATES:
            open(os.path.join(d, f"vrli_{tag}.toml"), "w").write(toml_for(s, applied, rate))
        rows.append(dict(sample=s, count=int(c), weight=c / N_RESAMPLE, dir=d, **{k: v for k, v in applied.items()}))
    R = pd.DataFrame(rows)
    R.to_csv(os.path.join(P2, "resampled.csv"), index=False)
    print(R[["sample", "count", "weight"]].to_string(index=False))


def run():
    R = pd.read_csv(os.path.join(P2, "resampled.csv"))
    for _, r in R.iterrows():
        d = r["dir"]
        first = True
        for tag, _ in RATES:
            toml = os.path.join(d, f"vrli_{tag}.toml")
            out = os.path.join(d, f"out_{tag}")
            cmd = [EXE, "vrli", toml, "--out", out] + ([] if first else ["--analyze-only"])
            print(" ".join(cmd), flush=True)
            subprocess.run(cmd, check=True)
            first = False


def wq(x, w, qs):
    x, w = np.asarray(x, float), np.asarray(w, float)
    i = np.argsort(x); x, w = x[i], w[i]
    c = (np.cumsum(w) - 0.5 * w) / w.sum()
    return np.interp(qs, c, x)


def surface(d):
    s = pd.read_csv(os.path.join(d, "out_table", "surface.csv"))
    s = s[s.converged.astype(str).str.lower() == "true"]
    return s.pivot_table(index="ext_mm", columns="rpm", values="brake_torque_Nm")


def ecu_table(piv, lmin, stroke, step=1.0):
    """Quasi-steady best position in [lmin, lmin + stroke] per rpm (extension mm)."""
    ext = piv.index.values.astype(float)
    pos = np.arange(lmin, lmin + stroke + 1e-9, step)
    out = {}
    for rpm in piv.columns:
        col = piv[rpm].values
        m = ~np.isnan(col)
        t = np.interp(pos, ext[m], col[m])
        out[rpm] = pos[np.argmax(t)]
    return pd.Series(out)


def envelope(ds, rate_is_table):
    """0037 envelope rule: per (cap, stroke) the placement with lmax <= cap (and the
    tool's plenum-fraction packaging limit) that maximises the quasi-steady P1 gain;
    report that placement's metrics."""
    ds = ds[ds.feasible_packaging.astype(str).str.lower() == "true"]
    out = []
    for cap in CAPS:
        for st in STROKES:
            x = ds[np.isclose(ds.stroke_mm, st) & (ds.lmax_mm <= cap + 1e-9)]
            if not len(x):
                continue
            b = x.loc[x.p1_gain.idxmax()]
            out.append(dict(cap=cap, stroke=st, lmin=b.lmin_mm, lmax=b.lmax_mm, table=b.p1_gain,
                            follow=b.p1_gain_follow, p2=b.p2_ratio, driver=b.driver_gain))
    return pd.DataFrame(out)


def collect():
    R = pd.read_csv(os.path.join(P2, "resampled.csv"))
    env, rec, tables = [], [], {}
    for _, r in R.iterrows():
        d = r["dir"]
        for tag, rate in RATES:
            ds = pd.read_csv(os.path.join(d, f"out_{tag}", "designs.csv"))
            e = envelope(ds, rate is None)
            e["gain"] = e.table if rate is None else e.follow
            e["sample"], e["weight"], e["rate"] = r["sample"], r.weight, tag
            env.append(e)
            m = ds[np.isclose(ds.stroke_mm, REC["stroke"]) & np.isclose(ds.lmin_mm, REC["lmin"])]
            if len(m):
                x = m.iloc[0]
                rec.append(dict(sample=r["sample"], weight=r.weight, rate=tag,
                                gain=(x.p1_gain if rate is None else x.p1_gain_follow), p2=x.p2_ratio,
                                failsafe_mm=x.failsafe_mm, failsafe_gain=x.failsafe_gain))
        tables[int(r["sample"])] = ecu_table(surface(d), REC["lmin"], REC["stroke"])
    E = pd.concat(env); E.to_csv(os.path.join(P2, "envelope_per_sample.csv"), index=False)
    Q = pd.DataFrame(rec); Q.to_csv(os.path.join(P2, "recommended_design_per_sample.csv"), index=False)
    T = pd.DataFrame(tables); T.index.name = "rpm"; T.to_csv(os.path.join(P2, "ecu_table_per_sample.csv"))
    g = []
    for (rate, cap, st), x in E.groupby(["rate", "cap", "stroke"]):
        ww = x.weight.values
        q = wq(x.gain.values, ww, [0.1, 0.5, 0.9])
        pl = wq(x.lmin.values, ww, [0.1, 0.5, 0.9])
        g.append(dict(rate=rate, cap=cap, stroke=st, n=len(x), wsum=ww.sum(),
                      gain_q10=q[0], gain_q50=q[1], gain_q90=q[2],
                      P_p1_ge_5=float(np.sum(ww * (x.gain.values >= 0.05)) / ww.sum()),
                      P_p2_ge_097=float(np.sum(ww * (x.p2.values >= 0.97)) / ww.sum()),
                      lmin_q10=pl[0], lmin_q50=pl[1], lmin_q90=pl[2]))
    G = pd.DataFrame(g); G.to_csv(os.path.join(P2, "envelope_distribution.csv"), index=False)
    h = []
    for rate, x in Q.groupby("rate"):
        ww = x.weight.values
        q = wq(x.gain.values, ww, [0.1, 0.5, 0.9])
        h.append(dict(rate=rate, gain_q10=q[0], gain_q50=q[1], gain_q90=q[2],
                      P_p1_ge_5=float(np.sum(ww * (x.gain.values >= 0.05)) / ww.sum()),
                      P_p2_ge_097=float(np.sum(ww * (x.p2.values >= 0.97)) / ww.sum())))
    Hh = pd.DataFrame(h); Hh.to_csv(os.path.join(P2, "recommended_design_distribution.csv"), index=False)
    pd.set_option("display.width", 220)
    for tag, _ in RATES:
        x = G[G.rate == tag]
        print(f"== {tag}: median gain % (P(P1>=5%))")
        print((100 * x.pivot(index="cap", columns="stroke", values="gain_q50")).round(1).to_string())
        print(x.pivot(index="cap", columns="stroke", values="P_p1_ge_5").round(2).to_string())
    print(); print(Hh.round(4).to_string(index=False))


if __name__ == "__main__":
    {"prepare": prepare, "run": run, "collect": collect}[sys.argv[1]]()
