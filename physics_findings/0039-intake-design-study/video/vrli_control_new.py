"""VRLI plate control over a lap of telemetry, on the finding-0039 DIRECT 1D runs (newintake.ndjson).

Same smooth controller as 0037's vrli_control.py (rate-feasible DP schedule, rpm low-pass + lead, speed- and
acceleration-limited servo), but the torque comes from real engine runs of the recommended intake: 2.75 L box,
~123 mm venturi, trumpets displacing plenum air, positions 198-298 mm above the head flange in 10 mm steps x
4000-12500 rpm in 250 rpm steps. Gains are vs today's static intake (248 mm, 1.44 L, 228 mm venturi), same settings.
"""
import json, math, os, numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
def load(path=os.path.join(HERE, "..", "newintake.ndjson")):
    """(Re)load the direct-run torque grid; newintake.ndjson = 2.75 L box, newintake_box1.44.ndjson = today's 1.44 L box."""
    global RPMS, BASE_T, POSG, TQ, R_LO, R_HI
    rows = [json.loads(l) for l in open(path)]
    N = pd.DataFrame([r for r in rows if "bt" in r])
    RPMS = np.array(sorted(N[N.case == "base"].rpm.unique()), float)
    BASE_T = N[N.case == "base"].groupby("rpm").bt.mean().reindex(RPMS).values
    G = N[N.case == "new"].pivot_table(index="pos", columns="rpm", values="bt").reindex(columns=RPMS)
    POSG = G.index.values.astype(float); TQ = G.values; R_LO, R_HI = RPMS[0], RPMS[-1]
load()
BASE = 0.0                      # positions are already absolute mm above the flange

def base_torque(rpm): return float(np.interp(min(max(rpm, R_LO), R_HI), RPMS, BASE_T))
def torque(pos, rpm):
    rpm = min(max(rpm, R_LO), R_HI)
    i = int(np.clip(np.searchsorted(POSG, pos) - 1, 0, len(POSG) - 2)); fi = float(np.clip((pos - POSG[i]) / (POSG[i + 1] - POSG[i]), 0, 1))
    j = int(np.clip(np.searchsorted(RPMS, rpm) - 1, 0, len(RPMS) - 2)); fj = float(np.clip((rpm - RPMS[j]) / (RPMS[j + 1] - RPMS[j]), 0, 1))
    a = TQ[i, j] * (1 - fj) + TQ[i, j + 1] * fj; b = TQ[i + 1, j] * (1 - fj) + TQ[i + 1, j + 1] * fj
    return a * (1 - fi) + b * fi

class Design:
    def __init__(self, lo=198.1, hi=298.1, speed=200.0, accel=3000.0, rdot_design=3000.0, lead_s=0.12):
        self.lo, self.hi = lo, hi
        self.speed, self.accel, self.rdot, self.lead = speed, accel, rdot_design, lead_s
        self.r = np.arange(R_LO, R_HI + 1, 50.0)
        self.pos = np.arange(lo, hi + 1e-9, 1.0)
        base = np.array([base_torque(r) for r in self.r])
        self.G = np.array([[torque(p, r) / b - 1 for p in self.pos] for r, b in zip(self.r, base)])
        self.opt = self.pos[np.argmax(self.G, axis=1)]
        self.sched = self._dp()
        self.failsafe = float(self.pos[np.argmax((self.G * self.weights()[:, None]).sum(0))])

    def weights(self):
        w = np.where((self.r >= 6000) & (self.r <= 12000), 1.0, 0.15)
        w[(self.r >= 7000) & (self.r <= 10500)] = 2.0
        return w

    def _dp(self):
        step = max(1, int(round(self.speed / self.rdot * 50.0)))
        w = self.weights(); n, m = self.G.shape
        V = w[0] * self.G[0].copy(); back = np.zeros((n, m), dtype=int)
        for k in range(1, n):
            Vn = np.full(m, -1e18)
            for j in range(m):
                a, b = max(0, j - step), min(m, j + step + 1)
                jj = a + int(np.argmax(V[a:b])); Vn[j] = V[jj] + w[k] * self.G[k, j]; back[k, j] = jj
            V = Vn
        path = np.zeros(n, dtype=int); path[-1] = int(np.argmax(V))
        for k in range(n - 1, 0, -1): path[k - 1] = back[k, path[k]]
        return self.pos[path]

    def table(self, rpm, which="sched"):
        arr = self.sched if which == "sched" else self.opt
        return float(np.interp(min(max(rpm, R_LO), R_HI), self.r, arr))

def run_lap(t, rpm, tps, d: Design, tps_on=60.0):
    n = len(t); cmd = np.zeros(n); act = np.zeros(n); gain = np.full(n, np.nan); ideal = np.full(n, np.nan)
    t_new = np.full(n, np.nan); t_old = np.full(n, np.nan)
    rf = rpm[0]; rd = 0.0; pos = d.failsafe; v = 0.0
    for k in range(n):
        dt = max((t[k] - t[k - 1]) if k else 0.01, 1e-3)
        a = dt / (0.05 + dt); rf_new = rf + a * (rpm[k] - rf)
        rd += (dt / (0.10 + dt)) * ((rf_new - rf) / dt - rd); rf = rf_new
        c = d.table(rf + float(np.clip(rd, -8000, 8000)) * d.lead, "sched")
        e = c - pos; vdem = float(np.clip(12.0 * e, -d.speed, d.speed))
        dv = float(np.clip(vdem - v, -d.accel * dt, d.accel * dt)); v += dv; pos = min(max(pos + v * dt, d.lo), d.hi)
        cmd[k] = c; act[k] = pos
        if tps[k] >= tps_on and R_LO <= rpm[k] <= R_HI:
            b = base_torque(rpm[k]); tn = torque(pos, rpm[k])
            gain[k] = tn / b - 1; ideal[k] = torque(d.table(rpm[k], "opt"), rpm[k]) / b - 1; t_new[k] = tn; t_old[k] = b
    return dict(cmd=cmd, act=act, gain=gain, ideal=ideal, t_new=t_new, t_old=t_old, mean=np.nanmean(gain), mean_ideal=np.nanmean(ideal))
