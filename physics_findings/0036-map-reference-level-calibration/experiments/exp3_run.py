import os, sys
S = "C:/Users/nick5/AppData/Local/Temp/claude/C--Users-nick5/86aaf203-f5d9-4d19-95a0-d6f4a6685368/scratchpad"
os.environ["HUNTEXP"] = S + "/exp3/target/release/huntexp.exe"
os.environ["RUNS_0035"] = S + "/exp3runs"
sys.path.insert(0, "C:/Users/nick5/helios/physics_findings/0035-collector-merge-lambda-lag/scripts")
import lib
from lib import *
GRIDR = list(range(4000, 10751, 250))
BASE = CFG + "/sdm26_asbuilt_exhaust.json"
M = ["exhaust_junction_momentum=1"]
V = {
 "base": [],
 "cdex_0.8": ["cdscale_ex=0.8"], "cdex_1.2": ["cdscale_ex=1.2"],
 "cdin_0.8": ["cdscale_in=0.8"], "cdin_1.2": ["cdscale_in=1.2"],
 "evo_-10": ["exhaust_valve_open_angle=130"], "evo_+10": ["exhaust_valve_open_angle=150"],
 "ivc_-10": ["intake_valve_close_angle=574"], "ivc_+10": ["intake_valve_close_angle=594"],
 "exlift_-15": ["exhaust_valve_max_lift=0.0062475"], "exlift_+15": ["exhaust_valve_max_lift=0.0084525"],
 "inlift_-15": ["intake_valve_max_lift=0.007276"], "inlift_+15": ["intake_valve_max_lift=0.009844"],
 "shape_1.0": ["valve_lift_shape_exponent=1.0"], "shape_1.6": ["valve_lift_shape_exponent=1.6"],
 "entryk_0.05": ["intake_runner_entry_k=0.05"], "entryk_0.5": ["intake_runner_entry_k=0.5"],
 "spark_+5": ["spark_advance=30"],
}
sel = sys.argv[1:] or list(V)
for n in sel:
    run_variant(n, BASE, M + V[n], rpms=GRIDR, threads=6); print(n, "done", flush=True)
