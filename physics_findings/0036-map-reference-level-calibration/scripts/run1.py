import os
os.environ.setdefault("HUNTEXP", "huntexp")  # the 0035 driver built against this branch
import lib, gen
V = [("C0_e94", gen.make("C0_e94", losses=False)), ("C0_e98", gen.make("C0_e98", losses=False, eta_comb=0.98)),
     ("CL_e94", gen.make("CL_e94")), ("CL_e98", gen.make("CL_e98", eta_comb=0.98))]
for n, c in V:
    lib.run_variant(n, c, rpms=lib.RPMS5, threads=15); print(n, "done", flush=True)
import pandas as pd
T = pd.DataFrame([lib.analyze5(n, 97300.0) for n, _ in V]).set_index("variant"); pd.set_option("display.width", 250)
print(T.round(3).to_string()); T.to_csv("run1.csv")
