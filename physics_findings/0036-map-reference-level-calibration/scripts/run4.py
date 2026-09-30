import os
os.environ.setdefault("HUNTEXP", "huntexp")  # the 0035 driver built against this branch
import lib, pandas as pd
lib.run_variant("CAL2", os.path.abspath("cfg/CAL2.json").replace("\\", "/"), rpms=lib.RPMS5, threads=15)
T = pd.DataFrame([lib.analyze5(n, p) for n, p in [("RT", 101325.0), ("CAL", 97300.0), ("CAL2", 97300.0)]]).set_index("variant"); pd.set_option("display.width", 250)
print(T.round(3).to_string()); T.to_csv("run4.csv")
