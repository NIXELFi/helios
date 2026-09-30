import os, sys
os.environ["HUNTEXP"] = os.path.abspath("huntexpB/target/release/huntexp.exe")
os.environ["RUNS_0035"] = os.path.abspath("runs")
sys.path.insert(0, "C:/Users/nick5/helios-exp-damping/physics_findings/0035-collector-merge-lambda-lag/scripts")
from lib import *
AB = CFG + "/sdm26_asbuilt_exhaust.json"
G28 = list(range(4000, 10751, 250)); M = ["exhaust_junction_momentum=1"]
V = [("heatEx0", M + ["exhaust_heat_transfer_multiplier=0"]),
     ("heatIn0", M + ["pipe_heat_transfer_multiplier=0.001", "exhaust_heat_transfer_multiplier=1000"])]
for n, e in V:
    run_variant(n, AB, e, rpms=G28, threads=3); print(n, "done", flush=True)
