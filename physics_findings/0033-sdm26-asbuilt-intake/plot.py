import sys
from analyze import *
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
out=sys.argv[1] if len(sys.argv)>1 else H+"/fig_asbuilt.png"
INK2,GR,SURF='#52514e','#e4e3df','#fcfcfb'
plt.rcParams.update({'font.size':9,'axes.edgecolor':INK2,'axes.labelcolor':INK2,'xtick.color':INK2,'ytick.color':INK2,
  'axes.facecolor':SURF,'figure.facecolor':SURF,'axes.grid':True,'grid.color':GR,'axes.spines.top':False,'axes.spines.right':False})
fig,ax=plt.subplots(4,1,figsize=(11,15.5),sharex=True)
nm=lambda s:s/s.mean()
k=GRID/1000
PORTS=[50,65,80,95,110]; SEQ=['#b7d3f2','#86b6ea','#4f8fdc','#2a66b8','#173f7a']
car=dict(color='k',lw=2.4,label="car: ECU VE proxy PW×λ (λ lag 270 ms)")
def shade(a):
    a.axvspan(6.0,6.4,color='#2ca25f',alpha=.10); a.axvspan(8.9,9.1,color='#2ca25f',alpha=.10)
    a.axvspan(7.4,8.0,color='#de2d26',alpha=.08); a.axvspan(4.5,4.7,color='#de2d26',alpha=.08)
# panel 1: reference models
a=ax[0]; a.plot(k,nm(P),**car); a.plot(dy.loc[4500:10750].index/1000,nm(dy.brake_torque_Nm.loc[4500:10750]),color='#c0392b',lw=1.8,marker='o',ms=4,label="car: dyno torque (shape)")
for n,c,l in [("S_shipped",'#e08a2b',"model shipped sdm26.json"),("V2cam",'#1baf7a',"model physics v2 + real cam")]:
    m=load(n).ve_del.loc[4000:10750]; a.plot(m.index/1000,nm(m),color=c,lw=1.8,label=f"{l}  r={corr(m.reindex(GRID),P):+.2f}")
a.set_title("Car VE shape vs pre-as-built models (green = car VE peaks, red = car troughs)"); a.set_ylabel("VE / mean"); a.legend(fontsize=8,ncol=2); shade(a)
# panel 2: as-built port sweep
a=ax[1]; a.plot(k,nm(P),**car)
for p,c in zip(PORTS,SEQ):
    n=f"AB_port{p}"
    if not os.path.isdir(f"{H}/runs/{n}"): continue
    m=load(n).ve_del.loc[4000:10750]; a.plot(m.index/1000,nm(m),color=c,lw=1.8,label=f"as-built, head port {p} mm  r={corr(m.reindex(GRID),P):+.2f}")
a.set_title("As-built intake (1.44 L bell plenum, 248 mm Ø40→36 runner + port Ø36→33), port-length sweep"); a.set_ylabel("VE / mean"); a.legend(fontsize=8,ncol=2); shade(a)
# panel 3: wheel power vs dyno
a=ax[2]; a.plot(dy.index/1000,dy.brake_power_kW,color='k',lw=2.4,marker='o',ms=4,label="SDM26 team dyno (wheel)")
for n,c,l in [("S_shipped",'#e08a2b',"shipped"),("V2cam",'#1baf7a',"v2 + cam")]+[(f"AB_port{p}",c,f"as-built port {p}") for p,c in zip(PORTS,SEQ)]:
    if not os.path.isdir(f"{H}/runs/{n}"): continue
    m=load(n); a.plot(m.index/1000,m.P_kW*0.85,color=c,lw=1.5,label=l)
a.set_title("Wheel power: model brake × 0.85 vs dyno (calibration was fitted to the shipped model; not re-fit)"); a.set_ylabel("kW"); a.legend(fontsize=8,ncol=3)
a=ax[3]; a.plot(k,nm(P),**car)
for n,c,ls,l in [("AB_port95",'#2a66b8','-',"port 95, bell h 120 mm (base)"),("AB95_h84",'#8e44ad','--',"bell h 84 mm (-30 %)"),("AB95_h156",'#16a085','--',"bell h 156 mm (+30 %)"),
                 ("AB95_cyl120",'#7f8c8d',':',"uniform-area plenum, h 120"),("AB95_K0.04",'#d35400',':',"entry K 0.04 (good bellmouth)")]:
    m=load(n).ve_del.loc[4000:10750]; a.plot(m.index/1000,nm(m),color=c,ls=ls,lw=1.8,label=f"{l}  r={corr(m.reindex(GRID),P):+.2f}")
a.set_title("Plenum shape / height (fixed 1.44 L) and entry-loss sensitivity at port 95 mm"); a.set_ylabel("VE / mean"); a.legend(fontsize=8,ncol=2); shade(a)
a.set_xlabel("rpm (×1000)"); a.set_xlim(4,12.6)
plt.tight_layout(); plt.savefig(out,dpi=110); print(out)
