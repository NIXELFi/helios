# Finding 0038 phase 1: likelihood weighting of the prior ensemble against the car.
#
# Why Python and not in helios-bench: the car references (MAP-VE from the raw
# ECU log, the dyno CSV), the error model and the tempering are study choices
# that change faster than the runner, and the MAP-VE reference has to be
# recomputed per sample (baro is a prior). helios-bench only samples + runs.
#
# Usage: python analyze.py [ndjson] [outdir]
import os, sys, json
import numpy as np, pandas as pd

H = os.path.dirname(os.path.abspath(__file__))
F = os.path.normpath(os.path.join(H, ".."))
PF = os.path.normpath(os.path.join(F, ".."))
ND = sys.argv[1] if len(sys.argv) > 1 else os.path.join(F, "out", "phase1.ndjson")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(F, "out")
sys.path.insert(0, os.path.join(PF, "references", "ecu", "scripts"))
import mapve  # noqa: E402  (loads log.pkl; see references/ecu/scripts/load.py)

GRID = np.arange(4000, 10751, 250)          # MAP-VE / intake-dp bins
DGRID = np.arange(6000, 12501, 500)         # dyno comparison grid
BAND = (5500, 10000)                         # in-phase slope band (0036)
SIG_VE = np.hypot(0.03, 0.02)                # MAP-VE half-band + model discrepancy (normalised VE)
SIG_DP = 0.5                                 # kPa, car intake dp (0036 exp 5 match quality)
SIG_P = 2.0                                  # kW, dyno wheel power incl. discrepancy (0036 RMSE)
ESS_MIN = 10.0
ETA_DT = (0.85, 0.98)                        # drivetrain efficiency bounds (0036 section 5)

dyno = pd.read_csv(os.path.join(PF, "references", "dyno", "sdm26-team-dyno.csv")).set_index("rpm").brake_power_kW


def load(nd):
    hdr, rows = None, []
    for line in open(nd):
        v = json.loads(line)
        if v["kind"] == "header":
            hdr = v
        elif v["kind"] == "point":
            r = dict(sample=v["sample"], rpm=int(round(v["rpm"])))
            r.update(v["out"]); r.update({"prior:" + k: x for k, x in v["prior"].items()})
            r.update({"applied:" + k: x for k, x in v["applied"].items()})
            rows.append(r)
    d = pd.DataFrame(rows).drop_duplicates(["sample", "rpm"], keep="last")
    return hdr, d


_ref_cache = {}
def car_ref(baro_kpa):
    """MAP-VE shape (normalised over GRID) and car intake dp (kPa) at this baro."""
    k = round(baro_kpa, 1)
    if k not in _ref_cache:
        g = mapve.ve_map(p0=k).reindex(GRID)          # eta 0.5, the 0036 reference convention
        ve = g.ve / g.ve.mean()
        dp = k - g["map"]
        _ref_cache[k] = (ve, dp)
    return _ref_cache[k]


def per_sample(d):
    out = []
    for s, g in d.groupby("sample"):
        g = g.set_index("rpm").sort_index()
        if not set(GRID) <= set(g.index) or not set(DGRID) <= set(g.index):
            continue
        p_amb = g["applied:p_ambient"].iloc[0]
        ref_ve, ref_dp = car_ref(p_amb / 1000.0)
        ve = g.ve_del.reindex(GRID); ven = ve / ve.mean()
        dp = (p_amb - g.p_plenum_Pa.reindex(GRID)) / 1000.0
        pb = g.brake_kW.reindex(DGRID).values; pd_ = dyno.reindex(DGRID).values
        eta = float(np.clip((pb * pd_).sum() / (pb * pb).sum(), *ETA_DT))
        rv, rd, rp = (ven - ref_ve).values, (dp - ref_dp).values, eta * pb - pd_
        m = ~np.isnan(rv)
        w = pd.concat([ven, ref_ve], axis=1).dropna().loc[BAND[0]:BAND[1]]
        slope = np.polyfit(w.iloc[:, 1] - 1, w.iloc[:, 0] - 1, 1)[0]
        ll = -0.5 * (np.nansum(rv[m] ** 2) / SIG_VE ** 2 + np.nansum(rd ** 2) / SIG_DP ** 2 + np.sum(rp ** 2) / SIG_P ** 2)
        r = dict(sample=s, loglik=ll, eta_dt=eta, rmse_ve=np.sqrt(np.nanmean(rv[m] ** 2)),
                 rmse_dp=np.sqrt(np.nanmean(rd ** 2)), rmse_P=np.sqrt(np.mean(rp ** 2)), slope=slope,
                 r_ve=np.corrcoef(ven.values[m], ref_ve.values[m])[0, 1])
        r.update({c: g[c].iloc[0] for c in g.columns if c.startswith("prior:") or c.startswith("applied:")})
        out.append(r)
    return pd.DataFrame(out).set_index("sample")


def temper(ll, ess_min=ESS_MIN):
    """Smallest temperature T >= 1 with ESS(exp(ll/T)) >= ess_min (bisection).
    ess_min is capped at half the sample count (smoke runs)."""
    ess_min = min(ess_min, 0.5 * len(ll))
    def ess(T):
        w = np.exp((ll - ll.max()) / T); w /= w.sum(); return 1.0 / np.sum(w ** 2), w
    e1, w1 = ess(1.0)
    if e1 >= ess_min:
        return 1.0, e1, w1, e1
    lo, hi = 1.0, 2.0
    while ess(hi)[0] < ess_min and hi < 1e6: hi *= 2
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        (lo, hi) = (mid, hi) if ess(mid)[0] < ess_min else (lo, mid)
    e, w = ess(hi)
    return hi, e, w, e1


def wq(x, w, qs):
    i = np.argsort(x); x, w = np.asarray(x)[i], np.asarray(w)[i]
    c = np.cumsum(w) - 0.5 * w; c /= w.sum()
    return np.interp(qs, c, x)


def bands(d, S, w):
    qs = [0.025, 0.1, 0.5, 0.9, 0.975]
    rows = []
    wmap = dict(zip(S.index, w))
    for rpm, g in d[d["sample"].isin(S.index)].groupby("rpm"):
        g = g.set_index("sample")
        ww = np.array([wmap[s] for s in g.index])
        ve = g.ve_del / d[d["sample"].isin(g.index) & d.rpm.isin(GRID)].groupby("sample").ve_del.mean().reindex(g.index)
        eta = S.eta_dt.reindex(g.index)
        tq = g.bt_Nm * eta; pw = g.brake_kW * eta
        dp = (g["applied:p_ambient"] - g.p_plenum_Pa) / 1000.0
        for name, x in [("ve_norm", ve), ("wheel_torque_Nm", tq), ("wheel_power_kW", pw), ("intake_dp_kPa", dp)]:
            x = x.values; m = ~np.isnan(x)
            if m.sum() == 0: continue
            q = wq(x[m], ww[m], qs)
            rows.append(dict(rpm=rpm, qty=name, **{f"q{int(1000*a)/10:g}": v for a, v in zip(qs, q)},
                             prior_lo=np.nanmin(x), prior_hi=np.nanmax(x)))
    return pd.DataFrame(rows)


def param_table(S, w, hdr):
    rows = []
    for p in hdr["params"]:
        x = S["prior:" + p["name"]].values
        pm, ps = x.mean(), x.std()
        mu = np.sum(w * x); sd = np.sqrt(np.sum(w * (x - mu) ** 2))
        q = wq(x, w, [0.1, 0.5, 0.9])
        rows.append(dict(param=p["name"], mode=p["mode"], prior_min=p["min"], prior_max=p["max"],
                         prior_mean=pm, prior_sd=ps, post_mean=mu, post_sd=sd, post_q10=q[0], post_q50=q[1], post_q90=q[2],
                         sd_ratio=sd / ps if ps > 0 else np.nan))
    return pd.DataFrame(rows)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    hdr, d = load(ND)
    S = per_sample(d)
    T, ess, w, ess1 = temper(S.loglik.values)
    S["weight"] = w
    S.to_csv(os.path.join(OUT, "samples_scored.csv"))
    P = param_table(S, w, hdr); P.to_csv(os.path.join(OUT, "param_posterior.csv"), index=False)
    B = bands(d, S, w); B.to_csv(os.path.join(OUT, "bands.csv"), index=False)
    best = S.weight.idxmax()
    slope_q = wq(S.slope.values, w, [0.1, 0.5, 0.9])
    summ = dict(n_samples=len(S), temperature=T, ess_tempered=ess, ess_untempered=ess1,
                best_sample=int(best), best_weight=float(S.weight.max()), nominal_weight=float(S.weight.get(0, np.nan)),
                slope_prior=[float(np.percentile(S.slope, q)) for q in (10, 50, 90)], slope_post=[float(v) for v in slope_q],
                slope_nominal=float(S.slope.get(0, np.nan)),
                sigmas=dict(ve=SIG_VE, dp=SIG_DP, power=SIG_P))
    json.dump(summ, open(os.path.join(OUT, "summary.json"), "w"), indent=1)
    pd.set_option("display.width", 220)
    print(json.dumps(summ, indent=1))
    print(P.round(4).to_string(index=False))
    print(S.sort_values("weight", ascending=False).head(8)[["loglik", "weight", "eta_dt", "rmse_ve", "rmse_dp", "rmse_P", "slope", "r_ve"]].round(3).to_string())
