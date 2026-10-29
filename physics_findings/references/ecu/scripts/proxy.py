import os, pandas as pd, numpy as np, json
# ECU VE proxy = (injector PW - dead time) x lambda(t+lag), WOT pulls, 250 rpm bins. Run load.py first (creates log.pkl).
H=os.path.dirname(os.path.abspath(__file__))
PF=os.path.normpath(os.path.join(H,"..","..",".."))  # physics_findings/
d=pd.read_pickle(H+"/log.pkl"); t=d["Section Time"].values
ns=pd.Series(d["Engine Speed"].values).rolling(51,center=True,min_periods=1).mean().values
d["rate"]=pd.Series(np.gradient(ns,t)).rolling(101,center=True,min_periods=1).mean().values
GRID=np.arange(4000,10751,250)
def proxy(lag=0.12,dead=1.0,sel=None,lamcol="Lambda 1",minrows=50,retw=False):
    lg=int(round(lag/0.001)); x=d.copy(); x["lam"]=x[lamcol].shift(-lg)
    m=(x["APS (Main)"]>=85)&(x["Fuel Pressure"]>300)&(x["% Ignition Cut"]==0)&(x["% Fuel Cut"]==0)&(x["Injection Actual PW"]>0.5)&(x["lam"]>0.6)&(x["lam"]<1.1)&(x["Engine Speed"]>3500)
    # also require no cut within the lag window ahead (lambda would see the cut)
    cut=((x["% Fuel Cut"]>0)|(x["% Ignition Cut"]>0)).astype(float).rolling(lg+300,min_periods=1).max().shift(-(lg+300)).fillna(1)
    m&=(cut==0)
    if sel is not None: m&=sel(x)
    w=x[m].copy(); w["ve"]=(w["Injection Actual PW"]-dead)*w["lam"]
    w["bin"]=(w["Engine Speed"]/250).round()*250
    g=w.groupby("bin").agg(n=("ve","size"),ve=("ve","median"))
    g=g[g.n>=minrows].reindex(GRID)
    return (g,w) if retw else g
def extrema(x,y):
    pk,tr=[],[]
    for i in range(1,len(y)-1):
        a,b,c=y[i-1],y[i],y[i+1]
        if np.isnan([a,b,c]).any(): continue
        if (b>a and b>=c) or (b<a and b<=c):
            den=a-2*b+c; dx=0.5*(a-c)/den if den else 0
            (pk if b>a else tr).append(int(round(x[i]+dx*(x[1]-x[0]),-1)))
    return pk,tr
def model(path,col="ve_atm"):
    r=[json.loads(l) for l in open(path) if l.strip().startswith("{")]
    r=[x for x in r if x.get("kind","trial")=="trial"]
    s=pd.DataFrame(r).drop_duplicates("rpm").set_index("rpm").sort_index()[col]
    return s.reindex(GRID)
def corr(a,b):
    j=pd.concat([a,b],axis=1).dropna()
    return np.corrcoef(j.iloc[:,0]/j.iloc[:,0].mean(),j.iloc[:,1]/j.iloc[:,1].mean())[0,1]
dyno=pd.read_csv(PF+"/references/dyno/sdm26-team-dyno.csv").set_index("rpm")["brake_torque_Nm"]
dyno_g=dyno.reindex(dyno.index.union(GRID)).interpolate("index").reindex(GRID)
dyno_g[GRID<4500]=np.nan
