"""Finding 0039: lap trace of the new intake vs today's static intake over the fsae-sim autocross lap used in the video."""
import os, sys, json, numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE)); sys.path.insert(0, HERE)
from vrli_common import *
import vrli_common
from vrli_control_new import Design, run_lap
vrli_common.OUT = os.path.join(H, "charts", "newintake")
RUN = os.path.expanduser("~/fsae-sim/sim/runs/20260928-224849-autocross-7hf6")
tel = pd.read_csv(os.path.join(RUN, "telemetry.csv"), usecols=["time_s", "engine.rpm", "engine.tps", "engine.gear"])
t, rpm, tps, gear = tel.time_s.values, tel["engine.rpm"].values, tel["engine.tps"].values, tel["engine.gear"].values
sim = run_lap(t, rpm, tps, Design(lo=198.1, hi=298.1))
wk = core.today()(np.clip(rpm, 4000, 12500)) / np.array([__import__("vrli_control_new").base_torque(r) for r in rpm])
old, new = sim["t_old"] * wk, sim["t_new"] * wk
fig, axs = plt.subplots(3, 1, figsize=(16, 11.5), sharex=True, gridspec_kw=dict(height_ratios=[1.4, 0.8, 1]))
ax = axs[0]; ax.plot(t, old, color=INK, lw=1.6, label="today's static intake"); ax.plot(t, new, color="#2a78d6", lw=1.8, label="new intake (VRLI 198-298 mm, 2.75 L, 123 mm venturi)")
ax.fill_between(t, old, new, where=np.isfinite(old) & (new >= old), color="#2a78d6", alpha=0.18, lw=0)
ax.set_ylabel("wheel torque on throttle (N·m)"); ax.legend(fontsize=10, loc="lower left", bbox_to_anchor=(0.0, 1.06), ncol=2); ax.set_title("Torque through the lap (on throttle only)", loc="right", fontsize=12.5, fontweight="semibold", color=INK)
ax = axs[1]; g = sim["gain"] * 100
ax.bar(t, np.nan_to_num(g), width=0.012, color=np.where(np.nan_to_num(g) >= 0, "#2a78d6", "#e34948")); ax.axhline(0, color=INK, lw=0.8)
ax.set_ylabel("gain (%)"); ax.set_title(f"Gain vs today: lap average on throttle {sim['mean'] * 100:+.1f} %", loc="left", fontsize=12.5, fontweight="semibold", color=INK)
ax = axs[2]; ax.plot(t, sim["act"], color="#2a78d6", lw=2, label="runner length (actual, 200 mm/s servo)"); ax.plot(t, sim["cmd"], color="#eb6834", lw=1, alpha=0.8, label="target")
ax.plot(t, 198 + (rpm - 4000) / 9000 * 100, color=MUTED, lw=0.9, ls=":", label="rpm (scaled 4k-13k)")
ax.axhline(248.1, color=INK2, lw=0.8, ls="--"); ax.text(t[0] + 0.3, 250, "today's 248 mm", fontsize=9, color=INK2)
ax.set_ylabel("runner above flange (mm)"); ax.set_xlabel("lap time (s)"); ax.legend(fontsize=9.5, loc="upper right", ncol=3)
ax.set_title("What the trumpets do", loc="left", fontsize=12.5, fontweight="semibold", color=INK)
head(fig, "New intake vs today over an fsae-sim autocross lap", "Bradley McClain 39.01 s clean lap (run 20260928-224849-autocross-7hf6). Torque from the direct 1D runs, scaled to today's calibrated car; same lap telemetry for both.", NOTE)
fig.subplots_adjust(left=0.06, right=0.99, top=TOP(fig) - 0.02, bottom=0.06, hspace=0.25); save(fig, "R5_lap_trace.png")
