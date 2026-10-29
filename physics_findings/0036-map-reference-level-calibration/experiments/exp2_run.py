import os, sys
os.environ["HUNTEXP"] = os.path.abspath("huntexp/target/release/huntexp.exe")
os.environ["RUNS_0035"] = os.path.abspath("runs")
sys.path.insert(0, "C:/Users/nick5/helios-exp-damping/physics_findings/0035-collector-merge-lambda-lag/scripts")
import lib
from lib import *
AB = CFG + "/sdm26_asbuilt_exhaust.json"
G28 = list(range(4000, 10751, 250))
M = ["exhaust_junction_momentum=1"]
V = [("base", M), ("fric0", M + ["pipe_friction_multiplier=0"]), ("fric05", M + ["pipe_friction_multiplier=0.5"]),
     ("fric2", M + ["pipe_friction_multiplier=2"]), ("heat0", M + ["pipe_heat_transfer_multiplier=0"]),
     ("heat2", M + ["pipe_heat_transfer_multiplier=2"]),
     ("fh0", M + ["pipe_friction_multiplier=0", "pipe_heat_transfer_multiplier=0"]),
     ("superbee", M + ["limiter=2"]), ("weno5", M + ["use_weno5_in_pipes=1"]), ("cfl03", M + ["cfl=0.3"]),
     ("grid2x", M + ["runner_n_cells=80", "plenum_n_cells=40", "primary_n_cells=94", "secondary_n_cells=104", "collector_n_cells=148"])]
sel = sys.argv[1:] or [n for n, _ in V]
for n, e in V:
    if n in sel:
        run_variant(n, AB, e, rpms=G28, threads=6); print(n, "done", flush=True)
