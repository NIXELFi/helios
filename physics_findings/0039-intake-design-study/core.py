"""Shared loaders + physics helpers for the intake design study (finding 0039)."""
import os, json, glob, math, numpy as np, pandas as pd
H = os.path.dirname(os.path.abspath(__file__))
BASE_L = 328.1            # as-built runner incl. 80 mm port (mm)
PORT = 80.0               # head port, flange -> valve seat
OUTSIDE0 = BASE_L - PORT  # 248.1 mm runner above the head flange today
BORE_A = 4 * math.pi / 4 * 0.040 ** 2 * 1e3 * 1e-3   # L per mm of 4 runners' 40 mm bore = 0.005027 L/mm
BANDS = {"P1 6-12k": (6000, 12000), "driver 7-10.5k": (7000, 10500), "top 10.5-12.5k": (10500, 12500)}

def load():
    rows = [json.loads(l) for l in open(os.path.join(H, "results_c160.ndjson"))]
    d = pd.DataFrame(rows); d = d[d.bt.notna()] if "bt" in d else d
    pr = d.cfg.str.extract(r"V([\d.]+)_L([\d.]+)_D(\d+)_A([\d.]+)(?:_cd([\d.]+))?")
    d["V"] = pr[0].astype(float); d["lf"] = pr[1].astype(float); d["dout"] = pr[2].astype(float)
    d["ang"] = pr[3].astype(float); d["cd"] = pr[4].astype(float).fillna(0.95)
    return d

def today():
    cal = pd.DataFrame([json.load(open(f)) for f in glob.glob(os.path.join(H, "data", "cal_A_e94", "[0-9]*.json"))]).set_index("rpm").sort_index()
    return lambda r: np.interp(r, cal.index.values, cal.bt.values) * 0.94     # calibrated wheel torque today

def dyno():
    return pd.read_csv(os.path.join(H, "data", "dyno_raw_25rpm.csv"))

class Surface:
    """T(V, ext, rpm) from the static grid G1, log-V and linear-ext interpolation."""
    def __init__(self, d):
        g = d[(d.grid == "G1")]
        self.Vs = np.array(sorted(g.V.unique())); self.exts = np.array(sorted(g.ext.unique()), float)
        self.rpm = np.array(sorted(g.rpm.unique()), float)
        self.T = np.full((len(self.Vs), len(self.exts), len(self.rpm)), np.nan)
        self.S = np.full_like(self.T, np.nan)
        for (V, e, r), x in g.groupby(["V", "ext", "rpm"]):
            i, j, k = np.searchsorted(self.Vs, V), np.searchsorted(self.exts, e), np.searchsorted(self.rpm, r)
            self.T[i, j, k] = x.bt.iloc[-1]; self.S[i, j, k] = x.spread.iloc[-1]
        self.base = self.at(1.44, 0.0)
    def at(self, V, ext):
        """torque vs rpm (model, brake) at plenum air volume V (L) and extension ext (mm)."""
        lv = np.log(self.Vs); x = np.clip(math.log(V), lv[0], lv[-1])
        i = int(np.clip(np.searchsorted(lv, x) - 1, 0, len(lv) - 2)); fi = (x - lv[i]) / (lv[i + 1] - lv[i])
        e = np.clip(ext, self.exts[0], self.exts[-1])
        j = int(np.clip(np.searchsorted(self.exts, e) - 1, 0, len(self.exts) - 2)); fj = (e - self.exts[j]) / (self.exts[j + 1] - self.exts[j])
        a = self.T[i, j] * (1 - fj) + self.T[i, j + 1] * fj; b = self.T[i + 1, j] * (1 - fj) + self.T[i + 1, j + 1] * fj
        return a * (1 - fi) + b * fi

def band_mean(rpm, y, band):
    lo, hi = BANDS[band] if isinstance(band, str) else band
    m = (rpm >= lo) & (rpm <= hi); return float(np.trapezoid(y[m], rpm[m]) / (rpm[m][-1] - rpm[m][0]))

def dp_schedule(G, w, maxstep):
    """max sum_k w_k G[k, j_k] s.t. |j_{k+1}-j_k| <= maxstep. G: [rpm, pos]."""
    n, m = G.shape; V = w[0] * G[0].copy(); back = np.zeros((n, m), int)
    for k in range(1, n):
        Vn = np.empty(m)
        for j in range(m):
            a, b = max(0, j - maxstep), min(m, j + maxstep + 1); jj = a + int(np.argmax(V[a:b])); Vn[j] = V[jj] + w[k] * G[k, j]; back[k, j] = jj
        V = Vn
    path = np.zeros(n, int); path[-1] = int(np.argmax(V))
    for k in range(n - 1, 0, -1): path[k - 1] = back[k, path[k]]
    return path

def vrli(S, V_env, lo, hi, speed=200.0, rdot=3000.0, band="P1 6-12k", dpos=5.0, displace=True):
    """Telescoping runners inside the plenum: outside length fixed at lo, the extension (p-lo) sits in the plenum and
    moves bore air from plenum to runner. Returns (torque vs rpm, schedule ext vs rpm)."""
    pos = np.arange(lo, hi + 1e-9, dpos)
    Veff = V_env - (BORE_A * (pos - lo) if displace else 0 * pos)
    T = np.array([S.at(max(v, 0.3), p) for v, p in zip(Veff, pos)]).T        # [rpm, pos]
    G = T / S.base[:, None]
    lo_b, hi_b = BANDS[band]; w = np.where((S.rpm >= lo_b) & (S.rpm <= hi_b), 1.0, 0.15)
    step = max(1, int(round(speed / rdot * (S.rpm[1] - S.rpm[0]) / dpos)))
    path = dp_schedule(G, w, step)
    return T[np.arange(len(S.rpm)), path], pos[path], Veff[path]
