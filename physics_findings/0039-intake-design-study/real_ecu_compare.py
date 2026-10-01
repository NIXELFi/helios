"""Finding 0039: real-ECU-log comparison of the VRLI (198-298 mm) in the 2.75 L box vs today's 1.44 L box (real_ecu.py outputs)."""
from vrli_common import *
import vrli_common
OUT = vrli_common.OUT = os.path.join(H, "charts", "real_ecu")
A = pd.read_csv(os.path.join(OUT, "real_ecu_by_event.csv"), index_col=0); B = pd.read_csv(os.path.join(OUT, "box1.44", "real_ecu_by_event.csv"), index_col=0)
ev = list(A.index); y = np.arange(len(ev)); C2, C1 = "#eb6834", "#2a78d6"
fig, axs = plt.subplots(1, 3, figsize=(18, 4.8), sharey=True)
panels = [("gain", "Torque gain on throttle (%)", "{:+.1f} %"), ("saved_per_min", "Time gained from torque (s per min on throttle)", "{:.2f} s"), ("net_per_min", "NET of throttle-response lag (s per min on throttle)", "{:+.2f} s")]
for ax, (k, nm, fmt) in zip(axs, panels):
    ax.barh(y - 0.19, B[k], height=0.36, color=C1, label="today's 1.44 L box"); ax.barh(y + 0.19, A[k], height=0.36, color=C2, label="2.75 L box")
    for yi, (b, a) in enumerate(zip(B[k], A[k])):
        ax.text(b + 0.01 * max(B[k].max(), A[k].max()), yi - 0.19, fmt.format(b), va="center", fontsize=9.5, color=INK); ax.text(a + 0.01 * max(B[k].max(), A[k].max()), yi + 0.19, fmt.format(a), va="center", fontsize=9.5, color=INK)
    ax.set_title(nm, loc="left", fontsize=11.5, fontweight="semibold", color=INK); ax.axvline(0, color=INK, lw=1); ax.set_xlim(0, max(B[k].max(), A[k].max()) * 1.25); ax.grid(axis="y", visible=False)
axs[0].set_yticks(y); axs[0].set_yticklabels([f"{e}\n{A.loc[e, 'onthr_s']:.0f} s on throttle, median {A.loc[e, 'median_rpm'] / 1000:.1f}k rpm" for e in ev], fontsize=9.5); axs[0].invert_yaxis(); axs[2].legend(fontsize=9.5, loc="lower right")
head(fig, "Real ECU logs: which plenum box for the VRLI?", "Same 198 -> 298 mm VRLI and 200 mm/s actuator on every real session. The bigger box makes slightly more torque but fills slower after each throttle snap; real driving has ~50-80 snap-equivalents per on-throttle minute.",
     "Time figures are first-order: extra wheel force -> extra speed, discarded at each lift; lag = tip-in sims' lost full-torque time per snap, weighted by lift depth and duration; 1st gear excluded; 300 kg effective mass.")
fig.subplots_adjust(left=0.17, right=0.98, top=TOP(fig) - 0.05, bottom=0.12, wspace=0.08); save(fig, "E4_box_comparison.png")
