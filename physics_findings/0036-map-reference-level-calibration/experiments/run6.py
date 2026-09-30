import os, sys
os.environ["HUNTEXP"] = os.path.abspath(os.path.dirname(__file__) + "/../exp2/huntexpB/target/release/huntexp.exe")
import lib; lib.EXE = os.environ["HUNTEXP"]
from lib import *
AB = CFG + "/sdm26_asbuilt_exhaust.json"
B = ["exhaust_junction_momentum=1", "p_ambient=97300", "t_ambient=305", "restrictor_diffuser_efficiency=0.62"]
HOT = ["primary_wall_t=900", "secondary_wall_t=750", "collector_wall_t=650"]
VHOT = ["primary_wall_t=1000", "secondary_wall_t=850", "collector_wall_t=750"]
V = {"a_base": B, "b_hot": B + HOT, "c_vhot": B + VHOT,
     "d_hx03": B + ["exhaust_heat_transfer_multiplier=0.3"], "e_hx05": B + ["exhaust_heat_transfer_multiplier=0.5"],
     "f_hot_hx05": B + HOT + ["exhaust_heat_transfer_multiplier=0.5"]}
if __name__ == "__main__":
    for n in sys.argv[1:] or list(V):
        run_variant(n, AB, V[n], rpms=RPMS5, threads=8); print(n, "done", flush=True)
