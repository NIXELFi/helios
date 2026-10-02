"""Finding 0039: exhaust-port boundary traces from the 1D model for the Fluent 3D exhaust run (exhaust_bc/).

  exhaust_ports_{rpm}rpm.csv         as modelled in 0036 (short exhaust: primaries 424 mm, secondaries 467 mm)
  exhaust_allmeasured_{rpm}rpm.csv   all-measured car (cfg/ASMEASURED_all.json: primaries 481 mm, secondaries 576 mm, real intake)
Logged AFR and spark, 160-cell plenum, venturi inertance 400 1/m, 20th cycle at 1 deg. Driver: driver/src/bin/exhwave.rs.
The valve mass flow is the mean over each 1 deg sample interval (the point value chatters when cylinder and port pressure are close).
"""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, subprocess, sys
import numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
import study
from nothrottle import unthrottle
H = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(H, "exhaust_bc"); EXE = os.path.join(H, "driver", "target", "release", "exhwave.exe")
CFG = {"ports": study.BASE, "allmeasured": os.path.join(H, "cfg", "ASMEASURED_all.json")}
def run(job):
    case, rpm = job; f = os.path.join(OUT, f"exhaust_{case}_{rpm}rpm.csv")
    p = subprocess.Popen([EXE, CFG[case], str(rpm), "20", "plenum_n_cells=160", "restrictor_inertance=400"], stdout=subprocess.PIPE, text=True); unthrottle(p.pid)
    out = p.communicate()[0]; assert out.count(chr(10)) > 700, f"{case} {rpm}: engine run returned no trace"; io.open(f, "w", newline="\n").write(out); x = pd.read_csv(f); dt = np.gradient(x.t_s.values)
    return dict(case=case, rpm=rpm, **{f"out{i}_mg": 1e6 * float(np.sum(x[f"mdot_valve{i}_kg_s"] * dt)) for i in range(1, 5)},
                **{f"port{i}_mg": 1e6 * float(np.sum(x[f"mdot_port{i}_kg_s"] * dt)) for i in range(1, 5)},
                max_jump_g_s=1000 * max(float(x[f"mdot_valve{i}_kg_s"].diff().abs().max()) for i in range(1, 5)),
                jumps_over_30=int(sum((x[f"mdot_valve{i}_kg_s"].diff().abs() > 0.030).sum() for i in range(1, 5))))
if __name__ == "__main__":
    with ThreadPoolExecutor(2) as ex: R = list(ex.map(run, [(c, r) for c in CFG for r in (9000, 6000, 11500)]))
    pd.set_option("display.width", 220); print(pd.DataFrame(R).round(2).to_string(index=False))
