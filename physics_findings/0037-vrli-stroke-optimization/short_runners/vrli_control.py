"""VRLI plate control over a lap of telemetry, on the finding-0037 1D-model torque surface.

Two controllers:
  naive  - follow the instantaneous torque-optimal table above a TPS threshold, hold otherwise
           (what the first video did).
  smooth - (1) a rate-feasible schedule: dynamic programming over rpm picks the runner length
           L(rpm) that maximises the weighted relative torque subject to |dL/drpm| <= v / rdot_design,
           so the plate can actually follow it through a design sweep; (2) the rpm is low-passed and
           the command leads it by the filtered rpm rate; (3) the plate always tracks (pre-positions
           off throttle for the exit); (4) the plate moves with speed AND acceleration limits.
Gain is scored only on throttle (TPS >= 60 %) inside the model's rpm range.
"""
import math, numpy as np, pandas as pd

import os as _os
SURF = _os.environ.get("VRLI_SURF", "C:/Users/nick5/helios-vrli/physics_findings/0037-vrli-stroke-optimization/out/A_neutral_disp/surface.csv")
BASE = 328.1
EXT_MIN = float(_os.environ.get("VRLI_EXT_MIN", "-80"))

_s = pd.read_csv(SURF); _s = _s[_s.converged]
_P = _s.pivot(index="ext_mm", columns="rpm", values="brake_torque_Nm").dropna()
EXT = _P.index.values.astype(float); RPMS = _P.columns.values.astype(float); TQ = _P.values
R_LO, R_HI = RPMS[0], RPMS[-1]

def torque(ext, rpm):
    rpm = min(max(rpm, R_LO), R_HI)
    i = int(np.clip(np.searchsorted(EXT, ext) - 1, 0, len(EXT) - 2)); fi = float(np.clip((ext - EXT[i]) / (EXT[i + 1] - EXT[i]), 0, 1))
    j = int(np.clip(np.searchsorted(RPMS, rpm) - 1, 0, len(RPMS) - 2)); fj = float(np.clip((rpm - RPMS[j]) / (RPMS[j + 1] - RPMS[j]), 0, 1))
    a = TQ[i, j] * (1 - fj) + TQ[i, j + 1] * fj; b = TQ[i + 1, j] * (1 - fj) + TQ[i + 1, j + 1] * fj
    return a * (1 - fi) + b * fi

class Design:
    def __init__(self, long_mm=40.0, stroke_mm=100.0, speed=200.0, accel=3000.0, rdot_design=3000.0, lead_s=0.12):
        self.hi = long_mm; self.lo = max(long_mm - stroke_mm, EXT_MIN)
        self.speed, self.accel, self.rdot, self.lead = speed, accel, rdot_design, lead_s
        self.r = np.arange(R_LO, R_HI + 1, 50.0)
        self.pos = np.arange(self.lo, self.hi + 1e-9, 1.0)
        base = np.array([torque(0.0, r) for r in self.r])
        self.G = np.array([[torque(p, r) / b - 1 for p in self.pos] for r, b in zip(self.r, base)])  # rel. gain [rpm, pos]
        self.opt = self.pos[np.argmax(self.G, axis=1)]                          # instantaneous optimum
        self.sched = self._dp()
        w = self.weights()
        self.failsafe = float(self.pos[np.argmax((self.G * w[:, None]).sum(0))])

    def weights(self):
        w = np.where((self.r >= 6000) & (self.r <= 12000), 1.0, 0.15)
        w[(self.r >= 7000) & (self.r <= 10500)] = 2.0   # driver band
        return w

    def _dp(self):
        """Max sum_w G subject to |L(r_k+1) - L(r_k)| <= speed/rdot * 50 rpm (rate-feasible)."""
        step = max(1, int(round(self.speed / self.rdot * 50.0)))   # mm per 50 rpm step, on the 1 mm grid
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

def run_lap(t, rpm, tps, d: Design, mode="smooth", tps_on=60.0):
    n = len(t); cmd = np.zeros(n); act = np.zeros(n); vel = np.zeros(n); gain = np.full(n, np.nan); ideal = np.full(n, np.nan)
    rf = rpm[0]; rd = 0.0; pos = d.failsafe; v = 0.0; c = d.failsafe
    for k in range(n):
        dt = (t[k] - t[k - 1]) if k else 0.01
        dt = max(dt, 1e-3)
        on = tps[k] >= tps_on
        if mode == "naive":
            if on: c = 2 * round(d.table(rpm[k], "opt") / 2)
            step = d.speed * dt; e = c - pos; pos += e if abs(e) <= step else math.copysign(step, e); v = 0.0
        else:
            a = dt / (0.05 + dt); rf_new = rf + a * (rpm[k] - rf)
            rd += (dt / (0.10 + dt)) * ((rf_new - rf) / dt - rd); rf = rf_new
            c = d.table(rf + float(np.clip(rd, -8000, 8000)) * d.lead, "sched")
            # speed + acceleration limited servo (proportional velocity demand)
            e = c - pos; vdem = float(np.clip(12.0 * e, -d.speed, d.speed))
            dv = float(np.clip(vdem - v, -d.accel * dt, d.accel * dt)); v += dv; pos += v * dt
            pos = min(max(pos, d.lo), d.hi)
        cmd[k] = c; act[k] = pos; vel[k] = v
        if on and R_LO <= rpm[k] <= R_HI:
            b = torque(0.0, rpm[k]); gain[k] = torque(pos, rpm[k]) / b - 1; ideal[k] = torque(d.table(rpm[k], "opt"), rpm[k]) / b - 1
    return dict(cmd=cmd, act=act, vel=vel, gain=gain, ideal=ideal, mean=np.nanmean(gain), mean_ideal=np.nanmean(ideal))

if __name__ == "__main__":
    import glob, os, sys
    D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shared")
    rk = pd.read_csv(os.path.join(os.path.dirname(D), "shared_ranked.csv"))
    clean = rk[(rk.cones == 0) & (rk.off == 0) & (rk.assists == 0) & (rk.in_model >= 0.8)].sort_values("raw").head(10)
    for long_mm in (40.0, 115.0):
        d = Design(long_mm=long_mm)
        res = []
        for _, row in clean.iterrows():
            f = glob.glob(os.path.join(D, f"*{row.file}.csv.gz"))[0]
            x = pd.read_csv(f, usecols=["time_s", "engine.rpm", "engine.tps", "sim.lap"]); x = x[x["sim.lap"] == row.lap]
            tt, rr, pp = x.time_s.values, x["engine.rpm"].values, x["engine.tps"].values
            a = run_lap(tt, rr, pp, d, "naive"); b = run_lap(tt, rr, pp, d, "smooth")
            res.append((row.file, a["mean"], b["mean"], b["mean_ideal"]))
        R = pd.DataFrame(res, columns=["lap", "naive", "smooth", "ideal_instant"])
        print(f"long end +{long_mm:.0f} mm, stroke 100 ({BASE+d.lo:.0f}-{BASE+d.hi:.0f} mm): on-throttle lap-average torque gain")
        print((R.set_index("lap") * 100).round(2).to_string()); print("mean", (R[["naive", "smooth", "ideal_instant"]].mean() * 100).round(2).to_dict(), "failsafe", BASE + d.failsafe, "\n")
