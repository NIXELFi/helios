import sys; sys.path.insert(0,"../hunt")
from proxy import *
g,w=proxy(0.27,retw=True)
w["ign"]=w["Ignition Angle"]
t=w.groupby("bin").agg(n=("ign","size"),ign=("ign","median"),ign_iqr=("ign",lambda s:s.quantile(.75)-s.quantile(.25)),lam=("lam","median"),lam_tgt=("AFR/Lambda Target","median"),map=("MAP","median"))
t=t.loc[4000:12500]
print(t.round(3).to_string())
t.to_csv("tune_wot.csv")
