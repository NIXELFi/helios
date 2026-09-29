import json, math, copy, os, sys
H=os.path.dirname(os.path.abspath(__file__))
C="C:/Users/nmurray/Documents/Helios-worktrees/audit-1dcfd-0929/apps/desktop/src-tauri/resources/cfd/configs"
V=json.load(open(C+"/sdm26-physics-v2.json"))
D0,D1,VOL=0.038,0.167,0.00144
RUN_BODY=0.2354; BELL=0.0127; RUN=RUN_BODY+BELL      # 248.1 mm
D_MOUTH,D_FLANGE,D_VALVE=0.040,0.036,0.033
def vol(prof): return sum(math.pi*(x1-x0)/12*(a*a+a*b+b*b) for (x0,a),(x1,b) in zip(prof,prof[1:]))
def bell(h,npts=13):
    # d(t)=D0+(D1-D0)*(1-(1-t)^n); solve n so V = VOL at height h
    def prof(n): return [(round(h*i/(npts-1),6), D0+(D1-D0)*(1-(1-i/(npts-1))**n)) for i in range(npts)]
    lo,hi=0.05,50.0
    for _ in range(200):
        m=math.sqrt(lo*hi); (lo,hi)=(m,hi) if vol(prof(m))<VOL else (lo,m)
    p=prof(math.sqrt(lo*hi)); return [[x,round(d,6)] for x,d in p], math.sqrt(lo*hi)
def cyl(h):
    d=math.sqrt(4*VOL/(math.pi*h)); return [[0.0,round(d,6)],[h,round(d,6)]]
def make(port=0.080,h=0.120,shape="bell",entry_k=0.2):
    d=copy.deepcopy(V)
    d["name"]="Honda CBR600RR (FSAE) - SDM26 as-built intake EXPERIMENTAL"
    L=round(RUN+port,6); n=max(20,round(L/0.0082))
    prof=[[0.0,D_MOUTH],[round(RUN,6),D_FLANGE],[L,D_VALVE]]
    for i,p in enumerate(d["intake_pipes"]):
        p.update(length=L,diameter=D_MOUTH,diameter_out=None,n_points=n,diameter_profile=prof)
    d["restrictor"].update(throat_diameter=0.020,converging_half_angle=8.0,diverging_half_angle=3.2,outlet_diameter=0.038)
    if shape=="bell": pp,nexp=bell(h)
    else: pp,nexp=cyl(h),None
    d["plenum"]={"volume":round(vol([tuple(r) for r in pp]),7),"length":h,"n_cells":20,
                 "initial_pressure":101325.0,"initial_temperature":300.0,"diameter_profile":pp}
    d["physics"]["intake_runner_entry_k"]=entry_k
    return d,nexp
if __name__=="__main__":
    jobs={}
    for pm in [50,65,80,95,110]:
        jobs[f"AB_port{pm}"]=make(port=pm/1000)
    json.dump(jobs,open(H+"/jobs_preview.json","w"))
    for k,(d,n) in jobs.items():
        json.dump(d,open(f"{H}/cfg/{k}.json","w"),indent=1); print(k,"bell n=%.3f"%n, "V=%.5f"%d["plenum"]["volume"])
