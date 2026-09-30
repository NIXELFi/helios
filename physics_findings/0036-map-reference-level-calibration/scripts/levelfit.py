# Offline level fit: eta_comb (interpolated between two engine runs) x FMEP scale (post-processing).
import sys, numpy as np, pandas as pd, lib
VD, STROKE = 599.1e-6, 0.0425
FA, FB, FC = 0.5, 0.1, 0.00075
def fmep(rpm, s): sp = 2 * STROKE * rpm / 60; return s * (FA + FB * sp + FC * sp * sp)
def bt(imep, rpm, s): return (imep - fmep(rpm, s)) * 1e5 * VD / (4 * np.pi)
def fit(lo_name, hi_name, e_lo=0.94, e_hi=0.98, band=(6000, 12500)):
    a, b = lib.load(lo_name), lib.load(hi_name)
    rpm = a.index.values.astype(float)
    # check the bt formula on the lo run
    err = np.abs(bt(a.imep.values, rpm, 1.0) - a.bt.values).max()
    dy = lib.dy.brake_power_kW
    best = None; grid = []
    for e in np.arange(0.90, 1.0001, 0.005):
        imep = a.imep + (b.imep - a.imep) * (e - e_lo) / (e_hi - e_lo)
        for s in np.arange(0.5, 1.3001, 0.025):
            t = pd.Series(bt(imep.values, rpm, s), index=a.index)
            P = t * a.index * 2 * np.pi / 60 / 1000 * 0.85
            d = (P.reindex(dy.index) - dy).loc[band[0]:band[1]].dropna()
            rm = np.sqrt((d ** 2).mean()); grid.append((e, s, rm, d.mean()))
            if best is None or rm < best[2]: best = (e, s, rm, d.mean())
    return best, err, pd.DataFrame(grid, columns=["eta", "fmep_scale", "rmse", "bias"])
if __name__ == "__main__":
    for lo, hi in [("C0_e94", "C0_e98"), ("CL_e94", "CL_e98")]:
        best, err, g = fit(lo, hi)
        print(lo[:2], "bt-formula max err %.3f N.m" % err, " best eta %.3f fmep x%.3f RMSE %.2f bias %+.2f" % best)
        for e in (0.94, 0.96, 0.98, 1.0):
            r = g[np.isclose(g.eta, e)].sort_values("rmse").iloc[0]; print("   eta %.2f -> best fmep x%.3f RMSE %.2f bias %+.2f" % (e, r.fmep_scale, r.rmse, r.bias))
