# Finding 0038 phase 2 (prepared, run on request): propagate the phase-1
# posterior through the VRLI stroke optimiser (helios-bench vrli, branch
# feat/vrli-tool, finding 0037).
#
#   python phase2.py prepare  -> resample posterior, write per-sample configs + VRLI study TOMLs
#   python phase2.py run      -> run helios-bench vrli on each (HELIOS_BENCH = the vrli-capable binary)
#   python phase2.py collect  -> aggregate per-stroke gain distributions
#
# The VRLI study schema below mirrors 0037's studies/A_neutral_disp.toml; check
# it against the final tool before running (key names / output file names).
import os, sys, json, subprocess
import numpy as np, pandas as pd
from sample_config import sample_config

H = os.path.dirname(os.path.abspath(__file__))
F = os.path.normpath(os.path.join(H, ".."))
P2 = os.path.join(F, "out", "phase2")
N_RESAMPLE = 16
SEED = 380
STROKES = [0, 25, 50, 75, 100, 125, 150, 175, 200]

TOML = """# Finding 0038 phase 2, posterior sample {s} (resample weight {w:.3f})
[vrli]
config = "{cfg}"
cycles = 30
threads = {threads}
tune = "neutral"
trumpet_od_mm = 44.0
displacement_ref_mm = 0.0
rpm = {{ min = 6000, max = 12500, step = 500 }}
extension_mm = {{ min = -60, max = 160, step = 20 }}
cache = "cache_{s}.ndjson"

[design]
band_rpm = [6000, 12000]
driver_band_rpm = [7000, 10500]
baseline_extension_mm = 0.0
strokes_mm = {strokes}
placement_step_mm = 5.0
position_step_mm = 1.0
f3_resolution_mm = 2.0
sweep_rate_rpm_s = 6000.0
full_stroke_time_s = 0.5
metric = "torque"
knee_fraction = 0.9
max_protrusion_mm = 200.0

[design.mass]
fixed_kg = 0.30
per_100mm_kg = 0.42
"""


def resample(S):
    """Systematic resampling of the tempered posterior -> {sample: count}."""
    w = S.weight.values / S.weight.sum()
    rng = np.random.default_rng(SEED)
    u = (rng.random() + np.arange(N_RESAMPLE)) / N_RESAMPLE
    idx = np.searchsorted(np.cumsum(w), u)
    return pd.Series(S.index.values[idx]).value_counts().sort_index()


def prepare(threads=15):
    os.makedirs(P2, exist_ok=True)
    S = pd.read_csv(os.path.join(F, "out", "samples_scored.csv"), index_col=0)
    counts = resample(S)
    rows = []
    for s, c in counts.items():
        r = S.loc[s]
        applied = {k.split(":", 1)[1]: float(r[k]) for k in S.columns if k.startswith("applied:")}
        cfg = sample_config(applied, eta_dt=r.eta_dt, name=f"0038 phase 2 sample {s}")
        cp = os.path.join(P2, f"cfg_{s}.json"); json.dump(cfg, open(cp, "w"), indent=1)
        tp = os.path.join(P2, f"vrli_{s}.toml")
        open(tp, "w").write(TOML.format(s=s, w=c / N_RESAMPLE, cfg=f"cfg_{s}.json", threads=threads, strokes=STROKES))
        rows.append(dict(sample=s, count=int(c), weight=c / N_RESAMPLE, toml=tp))
    pd.DataFrame(rows).to_csv(os.path.join(P2, "resampled.csv"), index=False)
    print(pd.DataFrame(rows).to_string(index=False))


def run():
    exe = os.environ.get("HELIOS_BENCH", "helios-bench")
    R = pd.read_csv(os.path.join(P2, "resampled.csv"))
    for _, r in R.iterrows():
        out = os.path.join(P2, f"out_{int(r['sample'])}")
        subprocess.run([exe, "vrli", r.toml, "--out", out], check=True)


def collect():
    """Aggregate: per stroke, the resample-weighted distribution of the P1 gain
    and P2 ratio. Expects each out dir to hold a per-stroke CSV with columns
    stroke_mm, p1_gain (fraction), p2_ratio (the 0037 tool's per-stroke table;
    adapt the file/column names to the final tool)."""
    R = pd.read_csv(os.path.join(P2, "resampled.csv"))
    rows = []
    for _, r in R.iterrows():
        d = os.path.join(P2, f"out_{int(r['sample'])}")
        cands = [f for f in os.listdir(d) if "stroke" in f and f.endswith(".csv")]
        t = pd.read_csv(os.path.join(d, cands[0]))
        t["sample"], t["w"] = int(r["sample"]), r.weight
        rows.append(t)
    T = pd.concat(rows)
    g = []
    for st, x in T.groupby("stroke_mm"):
        w = x.w.values / x.w.sum()
        def q(v, a): i = np.argsort(v); c = np.cumsum(w[i]); return float(np.interp(a, c - w[i] / 2, v[i]))
        g.append(dict(stroke_mm=st, gain_q10=q(x.p1_gain.values, .1), gain_q50=q(x.p1_gain.values, .5),
                      gain_q90=q(x.p1_gain.values, .9), P_p1_ge_5pct=float(np.sum(w * (x.p1_gain.values >= 0.05))),
                      P_p2_ge_097=float(np.sum(w * (x.p2_ratio.values >= 0.97)))))
    G = pd.DataFrame(g); G.to_csv(os.path.join(P2, "stroke_distribution.csv"), index=False); print(G.round(3).to_string(index=False))


if __name__ == "__main__":
    {"prepare": prepare, "run": run, "collect": collect}[sys.argv[1]]()
