import os, sys
os.environ["HUNTEXP"] = os.path.abspath(os.path.dirname(__file__) + "/../exp3/target/release/huntexp.exe")
import lib; lib.EXE = os.environ["HUNTEXP"]
from lib import *
AB = CFG + "/sdm26_asbuilt_exhaust.json"; RT = CFG + "/sdm26_asbuilt_realtune.json"
M = ["exhaust_junction_momentum=1"]; P97 = ["p_ambient=97300", "t_ambient=305"]
V = {
 "M_P97":        (AB, M + P97),
 "M_P97_R50":    (AB, M + P97 + ["restrictor_diffuser_efficiency=0.5"]),
 "M_P97_R0":     (AB, M + P97 + ["restrictor_diffuser_efficiency=0.01"]),
 "M_P97_R75":    (AB, M + P97 + ["restrictor_diffuser_efficiency=0.75"]),
 "M_P97_cd90":   (AB, M + P97 + ["restrictor_cd=0.90"]),
 "M_P97_legacy": (AB, M + P97 + ["restrictor_venturi_model=0", "restrictor_loss_coef=0.3"]),
 "M_P97_R62":    (AB, M + P97 + ["restrictor_diffuser_efficiency=0.62"]),
 "RT_M_P97":     (RT, M + P97),
 "RT_M_P97_R62": (RT, M + P97 + ["restrictor_diffuser_efficiency=0.62"]),
}
sel = sys.argv[1:] or [k for k in V if k not in ("M_P97_R62","RT_M_P97","RT_M_P97_R62")]
for n in sel:
    c, e = V[n]; run_variant(n, c, e, rpms=RPMS5, threads=4); print(n, "done", flush=True)
