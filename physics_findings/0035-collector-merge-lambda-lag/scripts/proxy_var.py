# ECU VE proxy with an rpm-dependent lambda lag (WOT transport + sensor), finding 0035.
import pandas as pd, numpy as np, sys
import os
# needs references/ecu/scripts/log.pkl (run load.py on the raw Log 7.5.csv from the vault first)
d=pd.read_pickle(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','references','ecu','scripts','log.pkl'))
GRID=np.arange(4000,10751,250)
def proxy_lagfn(lagfn, dead=1.0, minrows=50):
    x=d.copy(); n=len(x); rpm=x["Engine Speed"].values
    lg=np.clip(np.round(lagfn(np.maximum(rpm,1000.0))).astype(int),0,1000)   # ms == samples (1 kHz)
    idx=np.clip(np.arange(n)+lg,0,n-1); x["lam"]=x["Lambda 1"].values[idx]
    m=(x["APS (Main)"]>=85)&(x["Fuel Pressure"]>300)&(x["% Ignition Cut"]==0)&(x["% Fuel Cut"]==0)&(x["Injection Actual PW"]>0.5)&(x["lam"]>0.6)&(x["lam"]<1.1)&(x["Engine Speed"]>3500)
    cut=((x["% Fuel Cut"]>0)|(x["% Ignition Cut"]>0)).astype(float).rolling(700,min_periods=1).max().shift(-700).fillna(1)
    m&=(cut==0)
    w=x[m].copy(); w["ve"]=(w["Injection Actual PW"]-dead)*w["lam"]; w["bin"]=(w["Engine Speed"]/250).round()*250
    g=w.groupby("bin").agg(n=("ve","size"),ve=("ve","median"),lam=("lam","median"),pw=("Injection Actual PW","median"))
    return g[g.n>=minrows].reindex(GRID)
LAGS={"c270":lambda r:270+0*r,"c120":lambda r:120+0*r,"c90":lambda r:90+0*r,
      "wotA":lambda r:40+50*10800/r,          # 40 ms sensor + transport ~1/rpm, 90 ms @10.8k
      "wotB":lambda r:90*10800/r}             # all transport, 90 ms @10.8k
if __name__=="__main__":
    out={}
    for k,f in LAGS.items():
        g=proxy_lagfn(f); out[k]=g.ve/g.ve.mean(); g.to_csv(f"proxy_{k}.csv")
    D=pd.DataFrame(out); print(D.round(3).to_string())
    for k in D:
        s=D[k]; print(k,"trough 7.3-8.2k",round(s.loc[7250:8250].min()-0.5*(s.loc[6000:6750].max()+s.loc[8500:9500].max()),3))
