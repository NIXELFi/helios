import os, sys, pandas as pd, numpy as np
# Usage: python load.py "<path to Log 7.5.csv>"   (raw Link G4X CSV export, ~98 MB, NOT in git)
f=sys.argv[1] if len(sys.argv)>1 else os.environ.get("SDM_ECU_LOG","Log 7.5.csv")
cols=["Section Time","Engine Speed","AFR/Lambda Target","Lambda 1","Lambda 1 Status","APS (Main)","TPS (Main)","MAP","ECT","Ignition Angle","% Ignition Cut","% Fuel Cut","CL Lambda  Fuel  Corr.","CL Lambda LT corr.","Fuel Pressure","Injection Actual PW","Batt Voltage","Gear","Driving Wheel Speed","Driven Wheel Speed","Current Gear Ratio","Oil Temperature"]
d=pd.read_csv(f,skiprows=[0,2],usecols=cols,low_memory=False).apply(pd.to_numeric,errors='coerce')
d=d.dropna(subset=["Section Time","Engine Speed"]).reset_index(drop=True)
d.to_pickle(os.path.join(os.path.dirname(os.path.abspath(__file__)),"log.pkl"))
print(d.describe().T[['mean','min','max']].round(3).to_string())
t=d["Section Time"].values; print("dt",np.median(np.diff(t)), "resets",(np.diff(t)<0).sum())
