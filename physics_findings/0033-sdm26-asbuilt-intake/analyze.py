import sys, os, json, glob
H=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,H+"/../hunt")
from proxy import *          # d, GRID (4000-10750/250), proxy(), extrema(), corr(), dyno_g
H=os.path.dirname(os.path.abspath(__file__))
PF="C:/Users/nmurray/Documents/Helios-worktrees/audit-1dcfd-0929/physics_findings"
P=proxy(0.27).ve; P12=proxy(0.12).ve
dy=pd.read_csv(PF+"/references/dyno/sdm26-team-dyno.csv").set_index("rpm")
def load(n):
    rows=[]
    for f in glob.glob(f"{H}/runs/{n}/*.json"):
        t=open(f).read().strip()
        if t: rows.append(json.loads(t))
    m=pd.DataFrame(rows).set_index("rpm").sort_index(); m.index=m.index.astype(int)
    m["P_kW"]=m.bt*m.index*2*np.pi/60/1000; return m
def dom(s,lo,hi,fn):
    v=s.loc[lo:hi]; i=getattr(v,fn)(); return int(i)
def analyze(n):
    m=load(n); g=m.ve_del.reindex(GRID)
    coarse=m.ve_del[[r for r in m.index if r%250==0]]
    pk,tr=extrema(coarse.index.values,coarse.values)
    fine=m.ve_del.loc[5000:10000]
    r=dict(variant=n,npts=len(m),corr270=corr(g,P),corr120=corr(g,P12),corr_dynoT=corr(m.bt.reindex(GRID),dyno_g),
       pk_5p5_7=dom(fine,5500,7000,"idxmax"),tr_7_8p5=dom(fine,7000,8500,"idxmin"),pk_8p5_10=dom(fine,8500,10000,"idxmax"),
       tr_4_5p2=dom(m.ve_del,4000,5200,"idxmin"),ve_mean=g.mean(),
       p_pl_4_5k=m.p_plenum.loc[4000:5000].mean()/1000,p_pl_6_8k=m.p_plenum.loc[6000:8000].mean()/1000,p_pl_10k=m.p_plenum.loc[9500:10500].mean()/1000,
       dMAP_6_8k=(m.p_plenum.loc[6000:8000].mean()-m.p_plenum.loc[4000:5000].mean())/1000,
       dMAP_10k=(m.p_plenum.loc[9500:10500].mean()-m.p_plenum.loc[4000:5000].mean())/1000,
       peaks=[x for x in pk], troughs=[x for x in tr])
    j=dy.join(m[["P_kW"]],how="inner"); j["dP"]=j.P_kW*0.85-j.brake_power_kW
    for lab,lo,hi in [("6-12.5k",6000,12500),("6-8.5k",6000,8500),("7-11.5k",7000,11500),("10.5-12.5k",10500,12500)]:
        s=j.loc[lo:hi]; r[f"rmse {lab}"]=np.sqrt((s.dP**2).mean()); r[f"bias {lab}"]=s.dP.mean()
    return r
if __name__=="__main__":
    names=sys.argv[1:] or sorted(os.listdir(H+"/runs"))
    T=pd.DataFrame([analyze(n) for n in names]).set_index("variant")
    pd.set_option("display.width",300); pd.set_option("display.max_columns",40); pd.set_option("display.max_colwidth",60)
    print(T.drop(columns=["peaks","troughs"]).round(3).to_string())
    for n,r in T.iterrows(): print(n,"peaks",r.peaks,"troughs",r.troughs)
    print("ECU proxy 270:",extrema(GRID,P.values)," dyno T:",extrema(dy.index.values,dy.brake_torque_Nm.values))
    T.to_csv(H+"/summary.csv")
