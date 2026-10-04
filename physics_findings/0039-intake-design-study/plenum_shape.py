"""Finding 0039: plenum VOLUME (and neck length) for Nick's plenum-shape study, to place the volume for the 3D shape runs.

Fixed by Nick: the optimised 136 mm restrictor (L140) with the throttle body where it is, so 233.5 mm from the restrictor exit to
the plenum floor; floor, bellmouths, runners (260.2 / 256.0 mm lip to flange) and ports as built; body up to 191 mm across;
volume 1.5-2.5 L; objective = mean over 7000-10000 rpm, equal weight.
1D plenum along the restrictor axis: neck (L_n at 40 mm bore) -> conical flare (40 mm -> body) -> straight body of diameter D_b
(175 mm, or 191 mm when 175 cannot hold the volume) to the floor, with the flare length chosen so the TOTAL gas volume (neck +
flare + body) is V and the total length is 233.5 mm. Runners join at the floor.
Restrictor: L140 at the car-fitted level (ratio transfer from Fluent against the as-built part: Cd 0.961, R 0.621; outlet 37.34 mm),
inertance 250 1/m (integral dx/A of the shorter venturi; 400 for the 228 mm part). Exhaust: corrected crotch merges, calibrated walls.
Logged AFR and spark. 250 rpm steps over 6500-10500. Output plenum_shape.ndjson; --report prints the tables.
"""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import json, math, subprocess, sys
import numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
import study
from nothrottle import unthrottle
H = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(H, "plenum_shape.ndjson"); EXE = os.path.abspath(os.path.join(H, "driver", "target", "release", "intakepoint.exe"))
LTOT, DN = 0.2335, 0.040; RPMS = list(range(6500, 10501, 250)); CD, R, DOUT, INERT = 0.9606, 0.621, 0.03734, 250.0
CASES = [(V, 0.120) for V in (1.5, 1.75, 2.0, 2.25, 2.5)] + [(2.0, Ln) for Ln in (0.060, 0.160)]
def shape(V, Ln):
    V = V * 1e-3; Rl = LTOT - Ln; an = math.pi / 4 * DN ** 2
    for Db in (0.175, 0.191):
        cone = math.pi / 12 * (DN ** 2 + DN * Db + Db ** 2); ab = math.pi / 4 * Db ** 2
        Lf = (an * Ln + ab * Rl - V) / (ab - cone)
        if 0.0 <= Lf <= Rl: return Db, Lf, Rl - Lf
    raise ValueError(f"no shape for V={V*1e3} L, neck {Ln*1e3} mm")
def cfg(V, Ln):
    d = json.load(open(os.path.join(H, "cfg", "CROTCH_p125.json"))); Db, Lf, Lb = shape(V, Ln)
    prof = ([[0.0, DN], [round(Ln, 5), DN]] if Ln > 0 else [[0.0, DN]]) + [[round(Ln + Lf, 5), Db], [LTOT, Db]]
    vol = sum(math.pi / 12 * (x1 - x0) * (a * a + a * b + b * b) for (x0, a), (x1, b) in zip(prof, prof[1:]))
    d["plenum"].update(volume=vol, length=LTOT, diameter_profile=prof)
    d["restrictor"].update(discharge_coefficient=CD, outlet_diameter=DOUT); d["physics"]["restrictor_diffuser_efficiency"] = round(R / (1 - (0.020 / DOUT) ** 4), 5)
    d["name"] = f"plenum shape study V {V} L neck {Ln*1e3:.0f} mm"; f = os.path.join(H, "cfg", f"PSHAPE_V{V:.2f}_N{Ln*1e3:.0f}.json"); json.dump(d, open(f, "w"), indent=1)
    return f, dict(V=V, neck_mm=Ln * 1e3, body_mm=Db * 1e3, flare_mm=Lf * 1e3, body_len_mm=Lb * 1e3, vol_check_L=vol * 1e3)
def run(job):
    V, Ln, rpm = job; f, _ = cfg(V, Ln)
    p = subprocess.Popen([EXE, f, str(rpm), "20", f"plenum_n_cells={study.CELLS}", f"restrictor_inertance={INERT}", "runner_mouth_extension=0.0000"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid)
    o, e = p.communicate()
    try: x = json.loads(o.strip().splitlines()[-1])
    except Exception: x = {"rpm": rpm, "error": e[-300:]}
    x.update(V=V, neck_mm=Ln * 1e3); return json.dumps(x)
def report():
    D = pd.DataFrame([json.loads(l) for l in open(OUT)]); D = D[D.bt.notna()]; rows = []
    for V, Ln in CASES:
        x = D[(D.V == V) & np.isclose(D.neck_mm, Ln * 1e3)].drop_duplicates("rpm").set_index("rpm").sort_index(); m = (x.index >= 7000) & (x.index <= 10000)
        r = x.index.values[m].astype(float); _, g = cfg(V, Ln)
        rows.append(dict(**g, ve_mean_7_10k=float(np.trapezoid(x.ve.values[m], r) / (r[-1] - r[0])), bt_mean_7_10k=float(np.trapezoid(x.bt.values[m], r) / (r[-1] - r[0])),
                         ve_mean_500=float(x.ve.reindex(range(7000, 10001, 500)).mean()), **{f"ve_{k}": float(x.ve.get(k, np.nan)) for k in range(7000, 10001, 500)}))
    T = pd.DataFrame(rows); b = T[(T.V == 2.0) & (T.neck_mm == 120)].bt_mean_7_10k.iloc[0]; T["bt_vs_2L_120"] = (T.bt_mean_7_10k / b - 1) * 100
    pd.set_option("display.width", 260); print(T.round(3).to_string(index=False)); T.round(4).to_csv(os.path.join(H, "charts", "plenum_shape.csv"), index=False)
if __name__ == "__main__":
    if "--report" in sys.argv: report(); sys.exit()
    for V, Ln in CASES: print(V, Ln, cfg(V, Ln)[1])
    unthrottle(os.getpid()); have = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            x = json.loads(l)
            if "error" not in x: have.add((x["V"], round(x["neck_mm"]), x["rpm"]))
    jobs = [(V, Ln, r) for V, Ln in CASES for r in RPMS if (V, round(Ln * 1e3), r) not in have]; print(len(jobs), "to run", flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for line in ex.map(run, jobs): f.write(line + chr(10)); f.flush()
    print("done", flush=True); report()
