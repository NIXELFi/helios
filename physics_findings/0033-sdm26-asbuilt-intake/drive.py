import subprocess, os, sys, json
from concurrent.futures import ThreadPoolExecutor
H=os.path.dirname(os.path.abspath(__file__)); EXE=H+"/../hunt/exp/target/release/huntexp.exe"
C="C:/Users/nmurray/Documents/Helios-worktrees/audit-1dcfd-0929/apps/desktop/src-tauri/resources/cfd/configs"
RPMS=sorted(set(list(range(4000,12501,250))+list(range(5000,10001,100))))
def variants():
    v={"S_shipped":C+"/sdm26.json","V2cam":C+"/sdm26-physics-v2.json"}
    for f in sorted(os.listdir(H+"/cfg")): v[f[:-5]]=H+"/cfg/"+f
    return v
def run(job):
    n,cfg,rpm=job; d=f"{H}/runs/{n}"; os.makedirs(d,exist_ok=True); out=f"{d}/{rpm}.json"
    if os.path.exists(out) and os.path.getsize(out)>10: return
    r=subprocess.run([EXE,cfg,str(rpm),str(rpm),'250','30'],capture_output=True,text=True)
    open(out,'w').write(r.stdout)
V=variants(); sel=sys.argv[1:] or list(V)
jobs=[(n,V[n],r) for n in sel for r in RPMS]
print(len(jobs),"jobs",flush=True)
with ThreadPoolExecutor(22) as ex: list(ex.map(run,jobs))
print("done",flush=True)
