import os
os.environ.setdefault("HUNTEXP", "huntexp")  # the 0035 driver built against this branch
import lib, gen
V = [("A_e94", gen.make("A_e94", losses=False, afr_wot=True)), ("A_e98", gen.make("A_e98", losses=False, afr_wot=True, eta_comb=0.98))]
for n, c in V:
    lib.run_variant(n, c, rpms=lib.RPMS5, threads=15); print(n, "done", flush=True)
import levelfit, numpy as np
best, err, g = levelfit.fit("A_e94", "A_e98")
print("best", best)
for e in (0.96, 0.98, 1.0):
    r = g[np.isclose(g.eta, e)].sort_values("rmse").iloc[0]; print("eta %.2f fmep x%.3f RMSE %.2f bias %+.2f" % (e, r.fmep_scale, r.rmse, r.bias))
