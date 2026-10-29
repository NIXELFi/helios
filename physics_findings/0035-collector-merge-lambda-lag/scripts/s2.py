import lib, gen_ll
from lib import *
V = [("LL1", gen_ll.make("sdm26_asbuilt_exhaust", "LL1")),
     ("M_LL1", gen_ll.make("sdm26_asbuilt_exhaust", "M_LL1", momentum=True)),
     ("LL2", gen_ll.make("sdm26_asbuilt_exhaust", "LL2", s=2.0)),
     ("M_LL2", gen_ll.make("sdm26_asbuilt_exhaust", "M_LL2", s=2.0, momentum=True)),
     ("RT_M_LL1", gen_ll.make("sdm26_asbuilt_realtune", "RT_M_LL1", momentum=True))]
for n, c in V:
    run_variant(n, c); print(n, "done", flush=True)
print(table(["AB_ex", "M10", "RT", "RT_M10"] + [n for n, _ in V]).to_string())
