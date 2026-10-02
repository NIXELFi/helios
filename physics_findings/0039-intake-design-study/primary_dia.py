"""Finding 0039: does the exhaust primary diameter matter? 1.25 in OD (29.75 mm bore, the CAD) against 1.5 in OD (36.10 mm bore).

All-measured car: runners 260.2 / 256.0 mm (bellmouth lip to flange) + 80 mm port, plenum 1.807 L / 140.9 mm as a dump (plain
cylinder), exhaust primaries 481.2 mm and secondaries 576.4 mm, logged AFR and spark, 160-cell plenum, venturi inertance 400 1/m.
p125 = the CAD (primaries 29.75 mm bore, collector legs / secondaries 36.10 mm, final 48.1-48.8 mm). p150 = a scaled system: primaries
36.10 mm, everything downstream x 1.176 in diameter (42.45 mm, final 56.6-57.4 mm). p150only = primaries 36.10 mm, the rest as CAD.
Lengths, merge positions, wall temperatures and the 65 mm head port (27.65 -> 29.75 mm) are the same in all three.
  --scan    junction settings at 9000 rpm (how much of a pulse crosses between paired primaries)
  (default) torque curves at 250 rpm steps for both diameters and each junction setting in JUNCTIONS -> primary_dia.ndjson
  --traces  exhaust_bc/exhaust_allmeasured_{p125,p150}_{rpm}rpm.csv and the per-speed table
"""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, json, math, subprocess, sys
import numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
import study
from nothrottle import unthrottle

H = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(H, "primary_dia.ndjson"); REL = os.path.join(H, "driver", "target", "release")
B = [f"plenum_n_cells={study.CELLS}", "restrictor_inertance=400"]; RPMS = list(range(4000, 12501, 250))
K = 42.45 / 36.10                                               # p150: everything downstream of the primaries scales by this (Nick: an estimate)
SEC = [[0.0, 0.05105], [0.0756, 0.0361], [0.5764, 0.0361]]; FIN = [[0.0, 0.05105], [0.0507, 0.0361], [0.1039, 0.0481], [0.1224, 0.0488], [0.6647, 0.0488]]
scale = lambda prof: [[x, round(d * K, 5)] for x, d in prof]
# name -> (primary profile, secondary profile, final profile). Primary = 65 mm head port, tube, 105.8 mm collector leg.
PROF = {"p125": ([[0.0, 0.02765], [0.065, 0.02975], [0.3654, 0.02975], [0.3754, 0.0361], [0.4812, 0.0361]], SEC, FIN),                                    # the CAD
        "p150": ([[0.0, 0.02765], [0.065, 0.02975], [0.075, 0.0361], [0.3654, 0.0361], [0.3754, 0.04245], [0.4812, 0.04245]], scale(SEC), scale(FIN)),      # scaled system
        "p150only": ([[0.0, 0.02765], [0.065, 0.02975], [0.075, 0.0361], [0.4812, 0.0361]], SEC, FIN)}                                                     # primaries only
# junction settings: name -> overrides. "as modelled" is the 0035 momentum merge at 10 deg.
JUNCTIONS = {"as modelled": [], "momentum off": ["exhaust_junction_momentum=0"]}
def cfgs():
    d0 = json.load(open(os.path.join(H, "cfg", "ASMEASURED_all_r260.json"))); V, L = 1.807e-3, 0.1409; D = math.sqrt(4 * V / (math.pi * L))
    d0["plenum"].update(volume=V, length=L, diameter_profile=[[0.0, round(D, 6)], [L, round(D, 6)]]); out = {}
    for k, (prof, sec, fin) in PROF.items():
        d = json.loads(json.dumps(d0))
        for p in d["exhaust_primaries"]: p["diameter_profile"] = prof; p["diameter"] = prof[0][1]; p["diameter_out"] = prof[-1][1]
        for p in d["exhaust_secondaries"]: p["diameter_profile"] = sec; p["diameter"] = sec[0][1]; p["diameter_out"] = sec[-1][1]
        d["exhaust_collector"].update(diameter_profile=fin, diameter=fin[0][1], diameter_out=fin[-1][1])
        d["name"] = "all measured, dump plenum, primaries " + k; out[k] = os.path.join(H, "cfg", f"PRIMARY_{k}.json"); json.dump(d, open(out[k], "w"), indent=1)
    return out
def engine(exe, cfg, rpm, extra):
    p = subprocess.Popen([os.path.join(REL, exe), cfg, str(rpm), "20", *B, *extra], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid); return p.communicate()
def stations(cfg, rpm, extra):
    x = pd.read_csv(io.StringIO(engine("exhstations.exe", cfg, rpm, extra)[0])); x["th"] = x.theta_deg.round().astype(int); x = x.set_index("th"); v = x.pri1_start_p / 1e3; e = x.pri1_end_p / 1e3
    return dict(hump_pri_end_270_300=e.loc[270:300].max(), partner_peak=v.loc[560:660].max(), partner_peak_deg=v.loc[560:660].idxmax(), blowdown_peak=v.loc[165:260].max(),
                overlap_mean=v.loc[322:365].mean(), overlap_min=v.loc[322:365].min(), hump_valve=v.loc[290:370].max(), hump_valve_deg=v.loc[290:370].idxmax())

if __name__ == "__main__":
    C = cfgs(); unthrottle(os.getpid())
    if "--scan" in sys.argv:
        S = {"as modelled (momentum, 10 deg)": [], "merge angle 0": ["exhaust_merge_angle_deg=0"], "merge angle 25": ["exhaust_merge_angle_deg=25"], "merge angle 45": ["exhaust_merge_angle_deg=45"],
             "momentum off": ["exhaust_junction_momentum=0"], "momentum off, Borda-Carnot x1": ["exhaust_junction_momentum=0", "exhaust_junction_borda_carnot=1", "exhaust_junction_loss_coef=1.0"],
             "momentum off, K 0.5": ["exhaust_junction_momentum=0", "exhaust_junction_loss_coef=0.5"], "momentum off, K 1.0": ["exhaust_junction_momentum=0", "exhaust_junction_loss_coef=1.0"]}
        def one(n):
            r = dict(junction=n, **stations(C["p125"], 9000, S[n])); o = engine("intakepoint.exe", C["p125"], 9000, S[n] + ["runner_mouth_extension=0.0000"])[0]; e = json.loads(o.strip().splitlines()[-1]); r.update(ve=e["ve"], bt=e["bt"]); return r
        with ThreadPoolExecutor(study.THREADS) as ex: T = pd.DataFrame(list(ex.map(one, S)))
        pd.set_option("display.width", 250); print("9000 rpm, p125. Fluent 3D: hump at primary end 125-129 kPa, overlap mean 101-103, partner peak 212 at 603"); print(T.round(1).to_string(index=False)); sys.exit()

    def point(job):
        case, jn, rpm = job; o, e = engine("intakepoint.exe", C[case], rpm, JUNCTIONS[jn] + ["runner_mouth_extension=0.0000"])
        try: x = json.loads(o.strip().splitlines()[-1])
        except Exception: x = {"rpm": rpm, "error": e[-300:]}
        x.update(case=case, junction=jn); return json.dumps(x)
    if "--traces" not in sys.argv:
        have = set()
        if os.path.exists(OUT):
            for l in open(OUT):
                x = json.loads(l)
                if "error" not in x: have.add((x["case"], x["junction"], x["rpm"]))
        jobs = [(c, j, r) for j in JUNCTIONS for c in C for r in RPMS if (c, j, r) not in have]; print(len(jobs), "to run,", study.THREADS, "threads", flush=True)
        with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
            for line in ex.map(point, jobs): f.write(line + chr(10)); f.flush()
        print("done", flush=True); sys.exit()
    # traces + per-speed table
    cyl = json.load(open(C["p125"]))["cylinder"]; bore, stroke, rod, cr = cyl["bore"], cyl["stroke"], cyl["con_rod_length"], cyl["compression_ratio"]
    Vd = math.pi / 4 * bore ** 2 * stroke; Vc = Vd / (cr - 1); a = stroke / 2
    vol = lambda th: Vc + math.pi / 4 * bore ** 2 * (rod + a - (a * np.cos(np.radians(th)) + np.sqrt(rod ** 2 - (a * np.sin(np.radians(th))) ** 2)))
    def trace(job):
        case, jn, rpm = job; tag = "" if jn == "as modelled" else "_" + jn.replace(" ", "")
        f = os.path.join(H, "exhaust_bc", f"exhaust_allmeasured_{case}{tag}_{rpm}rpm.csv"); out = engine("exhwave.exe", C[case], rpm, JUNCTIONS[jn])[0]
        assert out.count(chr(10)) > 700, (case, rpm)
        if jn == "as modelled": io.open(f, "w", newline=chr(10)).write(out)
        x = pd.read_csv(io.StringIO(out)); r = dict(case=case, junction=jn, rpm=rpm); dt = np.gradient(x.t_s.values); acc = {}
        for i in range(1, 5):
            ph = x[f"phase{i}_deg"].values; p = x[f"p_cyl{i}_Pa"].values; m = (ph >= 180) & (ph <= 360); o = np.argsort(ph[m]); V = vol(ph[m][o])
            acc.setdefault("pump_J", []).append(-float(np.trapezoid(p[m][o], V)))                      # work the piston does on the gas over the exhaust stroke
            pp = x[f"p_port{i}_Pa"].values / 1e3; ov = (ph >= 322) & (ph <= 365)
            acc.setdefault("overlap_mean_kPa", []).append(pp[ov].mean()); acc.setdefault("overlap_min_kPa", []).append(pp[ov].min())
            acc.setdefault("blowdown_peak_kPa", []).append(pp[(ph >= 140) & (ph <= 260)].max()); acc.setdefault("f_res_ivc", []).append(x[f"f_res_ivc{i}"].iloc[-1])
            acc.setdefault("exh_mg", []).append(1e6 * float(np.sum(x[f"mdot_valve{i}_kg_s"] * dt))); acc.setdefault("in_mg", []).append(1e6 * float(np.sum(x[f"mdot_ivalve{i}_kg_s"] * dt)))
        r.update({k: float(np.mean(v)) for k, v in acc.items()}); r["pump_kPa"] = r["pump_J"] / Vd / 1e3
        o = engine("intakepoint.exe", C[case], rpm, JUNCTIONS[jn] + ["runner_mouth_extension=0.0000"])[0]; e = json.loads(o.strip().splitlines()[-1]); r.update(ve=e["ve"], bt=e["bt"])
        st = stations(C[case], rpm, JUNCTIONS[jn]) if rpm == 9000 else {}; r.update(hump_pri_end=st.get("hump_pri_end_270_300", np.nan)); return r
    with ThreadPoolExecutor(study.THREADS) as ex: T = pd.DataFrame(list(ex.map(trace, [(c, j, r) for j in JUNCTIONS for r in (9000, 6000, 11500) for c in C])))
    T = T.sort_values(["junction", "rpm", "case"]); pd.set_option("display.width", 260); print(T.round(3).to_string(index=False)); T.round(4).to_csv(os.path.join(H, "charts", "asmeasured", "primary_dia_points.csv"), index=False)
