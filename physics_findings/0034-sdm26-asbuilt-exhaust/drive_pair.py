import subprocess, os
from concurrent.futures import ThreadPoolExecutor
H=os.path.dirname(os.path.abspath(__file__)); EXE=H+"/../hunt/exp/target/release/huntexp.exe"
RPMS=sorted(set(list(range(4000,12501,250))+list(range(5000,10001,100))))
def run(rpm):
    d=f"{H}/runs/AB_ex_pair180"; os.makedirs(d,exist_ok=True); out=f"{d}/{rpm}.json"
    if os.path.exists(out) and os.path.getsize(out)>10: return
    r=subprocess.run([EXE,H+"/cfg/AB_ex.json",str(rpm),str(rpm),'250','30','firing=1-4-2-3'],capture_output=True,text=True)
    open(out,'w').write(r.stdout)
with ThreadPoolExecutor(22) as ex: list(ex.map(run,RPMS))
