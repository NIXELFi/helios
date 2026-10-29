"""Does hotter exhaust gas move the 1D model's waves onto Fluent's 3D timing?
3D (no wall layers, so little heat loss): gas 1120 / 1099 / 1053 K at primary / secondary / final middle; the other pair's pulse
reaches cylinder 1's closed valve at 496-506 deg (+72 kPa); overlap (322-365 deg) mean 101-103 kPa at the valve.
1D as calibrated: 1026 / 970 / 940 K, step at 525-530 deg (+46 kPa), overlap mean 148 kPa.
All-measured car, 9000 rpm, exhaust heat loss reduced or walls raised."""
import os; os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import io, json, subprocess, sys, numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, H)
import study
from nothrottle import unthrottle
CFG = os.path.join(H, "cfg", "ASMEASURED_all.json"); B = ["plenum_n_cells=160", "restrictor_inertance=400"]; RPM = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
CASES = {"as calibrated (walls 900/750/650)": [], "exhaust heat x0.5": ["exhaust_heat_transfer_multiplier=0.5"], "exhaust heat x0.25": ["exhaust_heat_transfer_multiplier=0.25"],
         "exhaust heat x0 (adiabatic)": ["exhaust_heat_transfer_multiplier=0.0"], "walls 1100/1050/1000": ["primary_wall_t=1100", "secondary_wall_t=1050", "collector_wall_t=1000"]}
def run(name):
    ex = CASES[name]; out = []
    for exe in ("exhstations.exe", "intakepoint.exe"):
        p = subprocess.Popen([os.path.join(H, "driver", "target", "release", exe), CFG, str(RPM), "20", *B, *ex] + (["runner_mouth_extension=0.0000"] if exe.startswith("intakepoint") else []), stdout=subprocess.PIPE, text=True)
        unthrottle(p.pid); out.append(p.communicate()[0])
    x = pd.read_csv(io.StringIO(out[0])); x["th"] = x.theta_deg.round().astype(int); x = x.set_index("th"); e = json.loads(out[1].strip().splitlines()[-1])
    pv = x.pri1_start_p / 1e3; w = pv.loc[480:545]; d = w.diff(5); k = d.idxmax()
    return dict(case=name, T_pri_mid=x.pri1_mid_T.mean(), T_sec_mid=x.sec1_mid_T.mean(), T_final_mid=x.final_mid_T.mean(), step_at_deg=k - 2, step_kPa=d.max(),
                partner_peak_deg=pv.loc[560:660].idxmax(), partner_peak_kPa=pv.loc[560:660].max(), blowdown_peak_kPa=pv.loc[165:260].max(), overlap_mean_kPa=pv.loc[322:365].mean(), overlap_min_kPa=pv.loc[322:365].min(),
                hump_deg=pv.loc[290:370].idxmax(), ve=e["ve"], bt=e["bt"])
if __name__ == "__main__":
    with ThreadPoolExecutor(5) as ex: R = list(ex.map(run, CASES))
    T = pd.DataFrame(R); pd.set_option("display.width", 250); print(f"{RPM} rpm"); print(T.round(1).to_string(index=False)); T.round(3).to_csv(os.path.join(H, "diag", f"exhaust_heat_{RPM}.csv"), index=False)
