"""Full intake design study (static + VRLI) on sdm26_asbuilt_cal, neutral tune. Resumable."""
import json, os, sys, math, subprocess, copy, numpy as np
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.abspath(__file__))
EXE = os.path.join(H, "driver", "target", "release", "intakepoint.exe")
BASE = os.path.join(H, "..", "..", "apps", "desktop", "src-tauri", "resources", "cfd", "configs", "sdm26_asbuilt_cal.json")
# Plenum mesh: 20 cells was far from grid-converged for the flared bell (diag/plenum_cells.py: the 3.5-vs-1.44 L
# delta went -4.6 % -> -0.2 % at 12k from 20 -> 320 cells). 160 cells is within ~0.5 % of the limit.
CELLS = 160
OUT = os.path.join(H, "results_c160.ndjson"); CFGD = os.path.join(H, "cfg"); os.makedirs(CFGD, exist_ok=True)
V0 = 0.00144
def idelchik_phi(a):
    pts = [(5, .10), (10, .27), (15, .50), (20, .80), (30, 1.0)]
    if a <= 5: return .10
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if a <= x1: return y0 + (a - x0) / (x1 - x0) * (y1 - y0)
    return 1.0
def R_idel(dout, ang, dt=0.020):
    s = (dt / dout) ** 2; return (1 - s * s) - idelchik_phi(ang) * (1 - s) ** 2
ETA_REL = 0.62 * (1 - (0.020 / 0.038) ** 4) / R_idel(0.038, 3.2)   # keeps the car-calibrated as-built recovery
def make_cfg(V=V0, lenfac=1.0, dout=0.038, ang=3.2, cd=None):
    name = f"V{V*1e3:.2f}_L{lenfac:.2f}_D{dout*1e3:.0f}_A{ang:.1f}" + (f"_cd{cd:.3f}" if cd else "")
    path = os.path.join(CFGD, name + ".json")
    if os.path.exists(path): return name, path
    d = json.load(open(BASE))
    ph = d["physics"]; ph.pop("afr_map", None); ph.pop("spark_advance_map", None)
    prof = d["plenum"]["diameter_profile"]; k = V / V0
    newp = []
    for i, (x, D) in enumerate(prof):
        x2 = x * lenfac
        D2 = dout if i == 0 else D * math.sqrt(k / lenfac)
        newp.append([round(x2, 6), round(D2, 6)])
    # exact volume of the new profile (frustum sum), written back so the loader agrees
    vol = sum(math.pi / 12 * (x1 - x0) * (a * a + a * b + b * b) for (x0, a), (x1, b) in zip(newp, newp[1:]))
    d["plenum"]["diameter_profile"] = newp; d["plenum"]["volume"] = vol; d["plenum"]["length"] = newp[-1][0]
    d["restrictor"]["outlet_diameter"] = dout; d["restrictor"]["diverging_half_angle"] = ang
    s = (0.020 / dout) ** 2; R = ETA_REL * R_idel(dout, ang)
    ph["restrictor_diffuser_efficiency"] = round(R / (1 - s * s), 5)
    if cd: d["restrictor"]["discharge_coefficient"] = cd
    d["name"] = "intake study " + name
    json.dump(d, open(path, "w"), indent=1); return name, path
def jobs():
    J = []
    rpm_c = list(range(4000, 12501, 500)); rpm_f = rpm_c   # 500 rpm steps: the 160-cell plenum costs ~5x per point
    ext_f = sorted(set(range(-190, 161, 25)) | {0}); ext_c = [-140, -40, 60, 160]
    for V in (1.44, 3.5, 2.0, 2.75, 1.0, 0.75, 0.5):                       # G1 static grid (as-built + big plenums first)
        n, p = make_cfg(V=V * 1e-3)
        J += [("G1", n, p, e, r) for e in ext_f for r in rpm_f]
    for V in (0.75, 1.44, 2.75):                                            # G2 plenum geometry
        for lf in (0.5, 2.0):
            n, p = make_cfg(V=V * 1e-3, lenfac=lf)
            J += [("G2", n, p, e, r) for e in ext_c for r in rpm_c]
    for dout in (0.030, 0.034, 0.038, 0.044, 0.050):                        # G3 restrictor
        for ang in (3.2, 6.0, 8.0):
            n, p = make_cfg(dout=dout, ang=ang)
            J += [("G3", n, p, e, r) for e in (0, 100) for r in rpm_c]
    for dout in (0.030, 0.038, 0.050):                                      # G3b restrictor x big plenum (Nick: "we can go bigger plenum")
        for ang in (3.2, 8.0):
            n, p = make_cfg(V=2.75e-3, dout=dout, ang=ang)
            J += [("G3", n, p, 0, r) for r in rpm_c]
    for cd in (0.93, 0.97):
        n, p = make_cfg(cd=cd)
        J += [("G3", n, p, e, r) for e in (0, 100) for r in rpm_c]
    return J
def done():
    s = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            try:
                x = json.loads(l)
                if "bt" in x: s.add((x["cfg"], x["ext"], x["rpm"]))
            except Exception: pass
    return s
def run(j):
    g, n, p, e, r = j
    out = subprocess.run([EXE, p, str(r), "20", f"plenum_n_cells={CELLS}", f"runner_mouth_extension={e/1000:.4f}"], capture_output=True, text=True)
    try: x = json.loads(out.stdout.strip().splitlines()[-1])
    except Exception: x = {"rpm": r, "error": out.stderr[-300:]}
    x.update(grid=g, cfg=n, ext=e)
    return json.dumps(x)
if __name__ == "__main__":
    J = jobs(); d = done(); todo = [j for j in J if (j[1], j[3], j[4]) not in d]
    print(len(J), "jobs,", len(todo), "to run; ETA_REL", round(ETA_REL, 4), flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(15) as ex:
        for i, line in enumerate(ex.map(run, todo)):
            f.write(line + "\n"); f.flush()
            if i % 250 == 0: print(i, "/", len(todo), flush=True)
    print("done", flush=True)
