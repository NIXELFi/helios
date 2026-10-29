"""Finding 0039: ingest the Fluent restrictor curves (restrictor_opt/data/restrictor_maps/brief_<NAME>.csv) into the 1D model.

For each geometry: fit the 1D venturi boundary's two parameters (throat Cd, pressure recovery R) to the CFD mass-flow vs
back-pressure curve, report the fit quality (can the 2-parameter venturi reproduce CFD?), and tabulate both the absolute
values and the ratio transfer agreed with the Fluent agent:
    R_1D(geom) = 0.572 * R_CFD(geom) / R_CFD(A),   Cd_1D(geom) = 0.95 * Cd_CFD(geom) / Cd_CFD(A).
`--run` then simulates the engine (as-built intake and the recommended VRLI table, 1.44 L box) with each geometry's
(Cd, R) and reports torque vs the as-built venturi.  Usage: python fluent_ingest.py [--maps DIR] [--run]
"""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")   # numpy/scipy otherwise commit ~1 GB of per-thread BLAS buffers per driver process
import glob, json, math, os, re, subprocess, sys
import numpy as np, pandas as pd
from scipy.optimize import least_squares

H = os.path.dirname(os.path.abspath(__file__))
MAPS = sys.argv[sys.argv.index("--maps") + 1] if "--maps" in sys.argv else r"C:\Users\nick5\restrictor_opt\data\restrictor_maps"
P0, T0, G, RGAS, DT = 97300.0, 305.0, 1.4, 287.0, 0.020
AT = math.pi / 4 * DT ** 2
PRS = (2 / (G + 1)) ** (G / (G - 1))
IDEAL = AT * P0 * math.sqrt(G / (RGAS * T0)) * (2 / (G + 1)) ** ((G + 1) / (2 * (G - 1)))

def venturi_mdot(pr_out, cd, R):
    """The 1D model's venturi boundary (engine-sim bcs/restrictor.rs): throat pressure from diffuser recovery R,
    isentropic nozzle with discharge coefficient cd, choked once p_throat/p0 <= pr*."""
    pr_out = np.asarray(pr_out, float); R = min(max(R, 0.0), 0.99)
    pt = np.clip((pr_out - R) / (1 - R), 0.0, 1.0)                 # p_throat / p0
    pt = np.maximum(pt, PRS)
    M = np.sqrt(np.maximum(2 / (G - 1) * (pt ** (-(G - 1) / G) - 1), 0))
    return cd * AT * P0 * math.sqrt(G / (RGAS * T0)) * M * (1 + (G - 1) / 2 * M * M) ** (-(G + 1) / (2 * (G - 1)))

def load(f):
    x = pd.read_csv(f, comment="#")
    if "converged" in x: x["ok"] = x.converged.astype(str).str.lower().isin(["y", "true", "1", "yes"])
    else: x["ok"] = True
    # The 1D model's p_plenum is static pressure at the DIFFUSER EXIT PLANE. The CFD tailpipe (p_out) mixes out the exit
    # profile and gains static pressure a plenum never sees, most of all behind short, separated diffusers.
    x["pr"] = x["p_exit_plane_over_p0"] if "p_exit_plane_over_p0" in x else x["p_out_over_p0"]
    x = x[np.isfinite(x.mdot_kg_s) & np.isfinite(x.pr)]                 # a sweep cut short (e.g. licence drop) leaves NaN rows
    return x.sort_values("pr")

def complete(x):
    """A usable sweep reaches the choked plateau: >= 12 valid points and the top three mass flows within 0.5 %."""
    m = np.sort(x.mdot_kg_s.values)
    return len(x) >= 12 and (m[-1] - m[-3]) / m[-1] < 0.005

def fit(x):
    choked = x.mdot_kg_s.max(); cd0 = choked / IDEAL
    w = np.where(x.pr >= 0.80, 1.0, 0.3)                # the engine lives at 0.85-0.97
    res = least_squares(lambda p: (venturi_mdot(x.pr.values, p[0], p[1]) - x.mdot_kg_s.values) / choked * w, [cd0, 0.7], bounds=([0.5, 0.0], [1.05, 0.99]))
    cd, R = res.x; err = (venturi_mdot(x.pr.values, cd, R) - x.mdot_kg_s.values) / choked * 100
    onset = x[x.mdot_kg_s >= 0.995 * choked].pr.max()
    sep = x[x.get("separated", pd.Series(["n"] * len(x))).astype(str).str.lower().isin(["y", "true", "1", "yes"])].pr
    return dict(Cd_choked=cd0, Cd_fit=cd, R_fit=R, R_onset=(onset - PRS) / (1 - PRS), choke_onset=onset, fit_rms_pct=float(np.sqrt(np.mean(err ** 2))), fit_max_pct=float(np.abs(err).max()),
                attached_down_to=float(sep.max()) if len(sep) else float("nan"))

def main():
    rows = []
    for f in sorted(glob.glob(os.path.join(MAPS, "brief_*.csv"))):
        name = re.sub(r"^brief_|\.csv$", "", os.path.basename(f)); x = load(f)
        if not complete(x):
            print(f"SKIP {name}: incomplete sweep ({len(x)} valid points, never reached the choked plateau); its header Cd is not valid"); continue
        rows.append(dict(geometry=name, points=len(x), **fit(x)))
    if not rows:
        print("no brief_*.csv in", MAPS); return
    T = pd.DataFrame(rows).set_index("geometry")
    # Reference = the car's actual part. A_CAD (as-built wall from the team's CAD, 19.947 mm throat) once it exists;
    # the cone stand-in A before that. Override with --ref NAME.
    REF = sys.argv[sys.argv.index("--ref") + 1] if "--ref" in sys.argv else ("A_CAD" if "A_CAD" in T.index else "A")
    if REF in T.index:
        T["R_1D"] = 0.572 * T.R_fit / T.R_fit[REF]; T["Cd_1D"] = 0.95 * T.Cd_fit / T.Cd_fit[REF]
    print("reference geometry:", REF)
    out = os.path.join(H, "charts", "fluent"); os.makedirs(out, exist_ok=True)
    T.round(4).to_csv(os.path.join(out, "fluent_fit.csv")); pd.set_option("display.width", 220); print(T.round(3).to_string())
    if "--run" in sys.argv and REF in T.index:
        sys.path.insert(0, H); import study
        from concurrent.futures import ThreadPoolExecutor
        from nothrottle import unthrottle
        rpms = list(range(4000, 12501, 500))
        def run(job):
            cfgp, rpm, ext = job
            p = subprocess.Popen([study.EXE, cfgp, str(rpm), "20", f"plenum_n_cells={study.CELLS}", f"runner_mouth_extension={ext / 1000:.4f}"], stdout=subprocess.PIPE, text=True)
            unthrottle(p.pid); return json.loads(p.communicate()[0].strip().splitlines()[-1])["bt"]
        ONLY = [g for g in T.index if "--only" not in sys.argv or g in sys.argv[sys.argv.index("--only") + 1].split(",") or g == REF]
        res = {}; cachef = os.path.join(out, "engine_cache.json")          # (mode, geometry, Cd, R) -> torque curve, so reruns only do new geometries
        cache = json.load(open(cachef)) if os.path.exists(cachef) else {}
        for mode, col_r, col_cd in [("ratio", "R_1D", "Cd_1D"), ("absolute", "R_fit", "Cd_fit")]:
            for g in ONLY:
                Rv, cdv = round(float(T[col_r][g]), 4), round(float(min(T[col_cd][g], 0.99)), 3); key = f"{mode}|{g}|{cdv}|{Rv}"
                if key not in cache:
                    d_ = json.load(open(study.BASE)); d_["restrictor"]["discharge_coefficient"] = cdv
                    d_["physics"].pop("afr_map", None); d_["physics"].pop("spark_advance_map", None)
                    d_["physics"]["restrictor_diffuser_efficiency"] = round(Rv / (1 - (0.020 / 0.038) ** 4), 5)
                    cfgp = os.path.join(out, f"cfg_{mode}_{g}.json"); json.dump(d_, open(cfgp, "w"), indent=1)   # exact Cd/R (make_cfg names round R to 2 dp)
                    with ThreadPoolExecutor(study.THREADS) as ex: cache[key] = list(ex.map(run, [(cfgp, r, 0) for r in rpms]))
                    json.dump(cache, open(cachef, "w"))
                res[(mode, g)] = np.array(cache[key])
            for g in T.index:                                   # the table always lists every geometry already simulated
                k2 = f"{mode}|{g}|{round(float(min(T[col_cd][g], 0.99)), 3)}|{round(float(T[col_r][g]), 4)}"
                if k2 in cache: res[(mode, g)] = np.array(cache[k2])
        R_ = np.array(rpms, float); base = res[("ratio", REF)]
        band = lambda Tq, lo, hi: (np.trapezoid(Tq[(R_ >= lo) & (R_ <= hi)], R_[(R_ >= lo) & (R_ <= hi)]) / np.trapezoid(base[(R_ >= lo) & (R_ <= hi)], R_[(R_ >= lo) & (R_ <= hi)]) - 1) * 100
        E = pd.DataFrame([dict(reference=REF, mode=m, geometry=g, top_10p5_12p5k=band(v, 10500, 12500), p1_6_12k=band(v, 6000, 12000), low_4_6k=band(v, 4000, 6000)) for (m, g), v in res.items()])
        E.round(2).to_csv(os.path.join(out, "fluent_engine.csv" if "--ref" not in sys.argv else f"fluent_engine_ref{REF}.csv"), index=False); print("\nengine torque vs the reference geometry (car-fitted level), %:"); print(E.round(2).to_string(index=False))

if __name__ == "__main__":
    main()
