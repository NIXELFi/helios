import lib, gen_ll
from lib import *
G = {"exhaust_gas_gamma": 1.30, "exhaust_gas_r": 295.0}
V = [("G130", gen_ll.make("sdm26_asbuilt_exhaust", "G130", runners=False, prim=False, sec=False, col=False, extra=G)),
     ("M_G130", gen_ll.make("sdm26_asbuilt_exhaust", "M_G130", runners=False, prim=False, sec=False, col=False, momentum=True, extra=G)),
     ("M_LL1_G130", gen_ll.make("sdm26_asbuilt_exhaust", "M_LL1_G130", momentum=True, extra=G)),
     ("RT_M_G130", gen_ll.make("sdm26_asbuilt_realtune", "RT_M_G130", runners=False, prim=False, sec=False, col=False, momentum=True, extra=G)),
     ("RT_M_LL1_G130", gen_ll.make("sdm26_asbuilt_realtune", "RT_M_LL1_G130", momentum=True, extra=G))]
for n, c in V:
    run_variant(n, c); print(n, "done", flush=True)
print(table(["AB_ex", "M10", "RT", "RT_M10"] + [n for n, _ in V]).to_string())
