# Finding 0036 corrected SDM26 config: as-built + real tune + momentum collector + exhaust gas gamma/R
# + Tempe ambient + measured-dp restrictor recovery + realistic exhaust wall temperatures.
import json, os
_PF = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CFG = os.path.join(_PF, "..", "apps", "desktop", "src-tauri", "resources", "cfd", "configs")
import pandas as pd
_W = pd.read_csv(os.path.join(_PF, "references", "ecu", "proxy_wotA.csv")).set_index("bin").lam
AFR_WOT = [[float(r), round(float(l) * 14.7, 3)] for r, l in _W.dropna().items()]   # lambda at the WOT-measured lag
def make(name, losses=True, eta_comb=None, walls=(900.0, 750.0, 650.0), fmep_scale=1.0, out_dir="cfg", afr_wot=False):
    d = json.load(open(f"{CFG}/sdm26_asbuilt_realtune.json"))
    ph = d["physics"]
    ph.update({"exhaust_junction_momentum": True, "exhaust_gas_gamma": 1.30, "exhaust_gas_r": 295.0,
               "restrictor_diffuser_efficiency": 0.62})
    d["p_ambient"], d["T_ambient"] = 97300.0, 305.0
    for p in d["exhaust_primaries"]: p["wall_temperature"] = walls[0]
    for p in d["exhaust_secondaries"]: p["wall_temperature"] = walls[1]
    d["exhaust_collector"]["wall_temperature"] = walls[2]
    if losses:
        for p in d["intake_pipes"]: p["local_losses"] = [[0.12, 0.15]]
        for p in d["exhaust_primaries"]: p["local_losses"] = [[0.12, 0.2], [0.25, 0.2]]
        for p in d["exhaust_secondaries"]: p["local_losses"] = [[0.25, 0.35]]
        d["exhaust_collector"]["local_losses"] = [[0.26, 0.25], [0.51, 0.5]]
    if afr_wot: ph["afr_map"] = AFR_WOT
    if eta_comb is not None: d["combustion"]["combustion_efficiency"] = eta_comb
    if fmep_scale != 1.0:
        for k, dv in (("fmep_a", 0.5), ("fmep_b", 0.1), ("fmep_c", 0.0)):
            ph[k] = ph.get(k, dv) * fmep_scale
    os.makedirs(out_dir, exist_ok=True)
    f = os.path.abspath(f"{out_dir}/{name}.json").replace("\\", "/"); json.dump(d, open(f, "w"), indent=1); return f
