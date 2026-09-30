# Finding 0038 phase 2: propagate the phase-1 posterior through the VRLI
# stroke optimiser (helios-bench vrli, finding 0037).
#
#   python phase2.py prepare  -> resample the posterior, write one VRLI study per unique sample
#   python phase2.py run      -> run the surfaces, then --analyze-only at each sweep rate
#   python phase2.py collect  -> per-stroke gain / P2 / placement distributions + the 0037 design
#
# Each sample's study is the 0037 A_neutral_disp study (neutral tune, 44 mm
# trumpet OD, displacement ref 0, same design block and packaging cap) on a
# coarser grid limited to extension <= 0 (runners only shorten), with the sample's applied parameter values as `overrides` on
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
STROKES = [0, 50, 75, 100, 125, 150]
RATES = [("table", None), ("dyno_500", 500.0), ("gear2_3000", 3000.0), ("gear1_6000", 6000.0)]
# Packaging (owner, 2026-09-29): runners can only get SHORTER than as-built, so the
# as-built runner (extension 0) is the LONG end; designs are scored pinned at lmax = 0.
REC = dict(stroke=100.0, lmin=-100.0)
BASE_RUNNER_MM = 328.1

VRLI = """[vrli]
config = "../../../../../apps/desktop/src-tauri/resources/cfd/configs/sdm26_asbuilt_cal.json"
cycles = 30
threads = 15
tune = "neutral"
trumpet_od_mm = 44.0
displacement_ref_mm = 0.0
rpm = {{ min = 6000, max = 12500, step = 500 }}
extension_mm = {{ min = -160, max = 0, step = 20 }}
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


def pinned(ds):
    """Per stroke, the design with its long end at extension 0 (lmin = -stroke)."""
    m = np.isclose(ds.lmin_mm + ds.stroke_mm, 0.0)
    return ds[m & ds.stroke_mm.isin(STROKES)].sort_values("stroke_mm")


def collect():
    R = pd.read_csv(os.path.join(P2, "resampled.csv"))
    w = R.weight.values
    per = []
    rec = []
    tables = {}
    for _, r in R.iterrows():
        d = r["dir"]
        for tag, rate in RATES:
            st = pd.read_csv(os.path.join(d, f"out_{tag}", "strokes.csv"))
            ds = pd.read_csv(os.path.join(d, f"out_{tag}", "designs.csv"))
            for _, x in pinned(ds).iterrows():
                b = st[np.isclose(st.stroke_mm, x.stroke_mm)]
                bf = b.iloc[0] if len(b) else None
                per.append(dict(sample=r["sample"], weight=r.weight, rate=tag, stroke=x.stroke_mm,
                                best_runner_min=(BASE_RUNNER_MM + bf.lmin_mm) if bf is not None else np.nan,
                                best_gain=(bf.p1_gain if rate is None else bf.p1_gain_follow) if bf is not None else np.nan,
                                gain=(x.p1_gain if rate is None else x.p1_gain_follow), gain_table=x.p1_gain,
                                p2=x.p2_ratio, lmin=x.lmin_mm, runner_min=BASE_RUNNER_MM + x.lmin_mm,
                                failsafe_mm=x.failsafe_mm, failsafe_gain=x.failsafe_gain, driver=x.driver_gain))
            m = ds[(np.isclose(ds.stroke_mm, REC["stroke"])) & (np.isclose(ds.lmin_mm, REC["lmin"]))]
            if len(m):
                x = m.iloc[0]
                rec.append(dict(sample=r["sample"], weight=r.weight, rate=tag,
                                gain=(x.p1_gain if rate is None else x.p1_gain_follow), p2=x.p2_ratio,
                                failsafe_mm=x.failsafe_mm, failsafe_gain=x.failsafe_gain))
        piv = surface(d)
        tables[int(r["sample"])] = ecu_table(piv, REC["lmin"], REC["stroke"])
    P = pd.DataFrame(per); P.to_csv(os.path.join(P2, "per_sample_stroke.csv"), index=False)
    Q = pd.DataFrame(rec); Q.to_csv(os.path.join(P2, "recommended_design_per_sample.csv"), index=False)
    T = pd.DataFrame(tables); T.index.name = "rpm"
    T.to_csv(os.path.join(P2, "ecu_table_per_sample.csv"))
    # distributions
    g = []
    for (rate, st), x in P.groupby(["rate", "stroke"]):
        ww = x.weight.values
        q = wq(x.gain.values, ww, [0.1, 0.5, 0.9])
        pl = wq(x.best_runner_min.values, ww, [0.1, 0.5, 0.9])
        bg = wq(x.best_gain.values, ww, [0.1, 0.5, 0.9])
        g.append(dict(rate=rate, stroke_mm=st, gain_q10=q[0], gain_q50=q[1], gain_q90=q[2],
                      P_p1_ge_5=float(np.sum(ww * (x.gain.values >= 0.05)) / ww.sum()),
                      P_p2_ge_097=float(np.sum(ww * (x.p2.values >= 0.97)) / ww.sum()),
                      best_free_runner_min_q10=pl[0], best_free_runner_min_q50=pl[1], best_free_runner_min_q90=pl[2],
                      best_free_gain_q50=bg[1]))
    G = pd.DataFrame(g)
    order = {t: i for i, (t, _) in enumerate(RATES)}
    G = G.sort_values(["rate", "stroke_mm"], key=lambda c: c.map(order) if c.name == "rate" else c)
    G.to_csv(os.path.join(P2, "stroke_distribution.csv"), index=False)
    h = []
    for rate, x in Q.groupby("rate"):
        ww = x.weight.values
        q = wq(x.gain.values, ww, [0.1, 0.5, 0.9])
        h.append(dict(rate=rate, gain_q10=q[0], gain_q50=q[1], gain_q90=q[2],
                      P_p1_ge_5=float(np.sum(ww * (x.gain.values >= 0.05)) / ww.sum()),
                      P_p2_ge_097=(float(np.sum(ww * (x.p2.values >= 0.97)) / ww.sum()) if x.p2.notna().any() else np.nan)))
    Hh = pd.DataFrame(h); Hh.to_csv(os.path.join(P2, "recommended_design_distribution.csv"), index=False)
    pd.set_option("display.width", 220)
    print(G.round(3).to_string(index=False)); print(); print(Hh.round(3).to_string(index=False))


if __name__ == "__main__":
    {"prepare": prepare, "run": run, "collect": collect}[sys.argv[1]]()
