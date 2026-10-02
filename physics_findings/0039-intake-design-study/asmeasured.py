"""Finding 0039: the as-MEASURED intake (Fluent agent's cut of the assembly CAD, 26_06_IN_ASSY_ASM_U) vs the as-modelled one.

Measured: plenum 1.826 L, 140.9 mm from the restrictor exit plane to the floor (model: 1.44 L, 120 mm, both estimates);
runners 252 mm (outer pair) and 230 mm (inner pair) mouth to head flange (model: 248.1 mm for all); mouths are plain
sharp-edged counterbores in the flat floor (model entry K = 0.2, a rounded-mouth value). The 80 mm head port stays an
estimate. Cases, all with the venturi inertance on (400 1/m), 160-cell plenum, 4000-12500 rpm in 500 steps:
  model      : 1.44 L / 120 mm, 248.1 mm x4                       (reused from plenum2.ndjson)
  plenum     : 1.826 L / 140.9 mm, 248.1 mm x4
  measured   : real plenum, runners 252 (cyl 1, 4) / 230 (cyl 2, 3)
  swapped    : real plenum, runners 230 (cyl 1, 4) / 252 (cyl 2, 3)
  sharp      : measured + runner entry K = 0.5
and the VRLI (198-298 mm, five positions) in the real plenum, as the reference for the new design.
"""
import json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
import study
from nothrottle import unthrottle

H = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(H, "asmeasured.ndjson")
RPM = list(range(4000, 12501, 500)); PORT = 0.080; INERT = 400.0
V_REAL, H_REAL = 1.826e-3, 140.9

def cfg_real(name, lengths=None):
    _, p = study.make_cfg(V=V_REAL, lenfac=H_REAL / 120.0)
    if lengths is None: return p
    d = json.load(open(p))
    for pipe, L in zip(d["intake_pipes"], lengths):
        pipe["length"] = round(L + PORT, 4); pipe["diameter_profile"] = [[0.0, 0.040], [round(L, 4), 0.036], [round(L + PORT, 4), 0.033]]
    q = os.path.join(H, "cfg", f"ASMEASURED_{name}.json"); json.dump(d, open(q, "w"), indent=1); return q

CASES = {"plenum": (cfg_real("plenum"), []), "measured": (cfg_real("measured", [0.252, 0.230, 0.230, 0.252]), []),
         "swapped": (cfg_real("swapped", [0.230, 0.252, 0.252, 0.230]), []), "sharp": (cfg_real("measured", [0.252, 0.230, 0.230, 0.252]), ["intake_runner_entry_k=0.5"])}
VPOS = [198.1, 223.1, 248.1, 273.1, 298.1]

def run(job):
    case, cfgp, rpm, extra = job
    p = subprocess.Popen([study.EXE, cfgp, str(rpm), "20", f"plenum_n_cells={study.CELLS}", f"restrictor_inertance={INERT}", *extra], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); unthrottle(p.pid)
    out, err = p.communicate()
    try: x = json.loads(out.strip().splitlines()[-1])
    except Exception: x = {"rpm": rpm, "error": err[-300:]}
    x.update(case=case); return json.dumps(x)

if __name__ == "__main__":
    unthrottle(os.getpid())
    have = set()
    if os.path.exists(OUT):
        for l in open(OUT):
            x = json.loads(l)
            if "error" not in x: have.add((x["case"], x["rpm"]))
    jobs = [(c, p, r, ["runner_mouth_extension=0.0000", *e]) for c, (p, e) in CASES.items() for r in RPM]
    jobs += [(f"vrli_{pos:.0f}", CASES["plenum"][0], r, [f"runner_mouth_extension={(pos - 248.1) / 1000:.4f}", "vrli_trumpet_od=0.040", "vrli_displacement_ref=-0.0500"]) for pos in VPOS for r in RPM]
    jobs = [j for j in jobs if (j[0], j[2]) not in have]
    print(len(jobs), "to run,", study.THREADS, "threads", flush=True)
    with open(OUT, "a") as f, ThreadPoolExecutor(study.THREADS) as ex:
        for line in ex.map(run, jobs): f.write(line + "\n"); f.flush()
    print("done", flush=True)
