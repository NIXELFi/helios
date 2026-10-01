"""What the 1D plenum does at the restrictor exit: pressure waveform, and how much flow the quasi-steady venturi
boundary loses to pulsation (Fluent: a real diffuser's air column low-pass filters it; at 300 Hz +-5 kPa the mean flow
stays within 0.6 % of the steady flow at the MEAN pressure, while a quasi-steady element under-predicts by 3-5 %)."""
import os, subprocess, sys, io, numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, H)
import study, fluent_ingest as fi
from nothrottle import unthrottle
EXE = os.path.join(H, "driver", "target", "release", "plenumwave.exe"); P0 = 97300.0
_, CFG = study.make_cfg()                                   # as-built: Cd 0.95, R 0.572, 1.44 L
def run(rpm):
    p = subprocess.Popen([EXE, CFG, str(rpm), "20", f"plenum_n_cells={study.CELLS}"], stdout=subprocess.PIPE, text=True); unthrottle(p.pid)
    x = pd.read_csv(io.StringIO(p.communicate()[0])); x.to_csv(os.path.join(H, "diag", "plenumwave", f"asbuilt_{rpm}.csv"), index=False); return rpm, x
rows = []
for rpm, x in ThreadPoolExecutor(int(os.environ.get("INTAKE_THREADS", "6"))).map(run, [6000, 7500, 9000, 10500, 11500, 12500]):
    p = x.p_exit_Pa.values; m = x.mdot_exit_kg_s.values; pr = p / P0
    sp = np.abs(np.fft.rfft(p - p.mean())); k = int(np.argmax(sp[1:]) + 1); f = k / (x.t_s.iloc[-1] - x.t_s.iloc[0] + (x.t_s.iloc[1] - x.t_s.iloc[0]))
    qs_mean = float(np.mean(fi.venturi_mdot(pr, 0.95, 0.572)))             # the boundary's own law on the waveform
    at_mean = float(fi.venturi_mdot(np.array([pr.mean()]), 0.95, 0.572)[0]) # steady flow at the mean pressure
    rows.append(dict(rpm=rpm, firing_Hz=rpm / 30, dominant_Hz=round(f), p_mean_over_p0=pr.mean(), p_min=pr.min(), p_max=pr.max(), half_swing_kPa=(p.max() - p.min()) / 2000, rms_kPa=p.std() / 1000,
                     mdot_model_gs=m.mean() * 1000, mdot_qs_law_gs=qs_mean * 1000, mdot_at_mean_p_gs=at_mean * 1000, qs_penalty_pct=(qs_mean / at_mean - 1) * 100,
                     frac_choked=float(np.mean((pr - 0.572) / (1 - 0.572) <= fi.PRS))))
T = pd.DataFrame(rows).sort_values("rpm"); T.round(3).to_csv(os.path.join(H, "diag", "plenumwave", "summary.csv"), index=False)
pd.set_option("display.width", 250); print(T.round(3).to_string(index=False))
