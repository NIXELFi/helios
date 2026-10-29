from analyze import *
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
names=["AB_intake","AB_ex","AB_ex_muf432","AB_ex_st200","AB_ex_st250","AB_ex_st350","AB_ex_st400","AB_ex_st200_muf432","AB_ex_st400_muf432","AB_ex_port40","AB_ex_port50","AB_ex_port80","AB_ex_port90","AB_ex_secB","AB_ex_secC","AB_full_tune"]
nm=lambda s:s/s.mean()
rows=[]
for n in names:
    m=nm(load(n).ve_del.reindex(GRID).dropna()) ; f=load(n).ve_del; f=f/load(n).ve_del.reindex(GRID).mean()
    rows.append(dict(v=n,pk63=f.loc[6000:6600].max(),tr78=f.loc[7300:8200].min(),pk9=f.loc[8600:9400].max(),
      depth=f.loc[7300:8200].min()-0.5*(f.loc[6000:6600].max()+f.loc[8600:9400].max()),
      rng_65_90=f.loc[6600:9000].max()-f.loc[6600:9000].min()))
car=nm(P); rows.append(dict(v="CAR",pk63=car.loc[6000:6600].max(),tr78=car.loc[7300:8200].min(),pk9=car.loc[8600:9400].max(),depth=car.loc[7300:8200].min()-0.5*(car.loc[6000:6600].max()+car.loc[8600:9400].max()),rng_65_90=car.loc[6600:9000].max()-car.loc[6600:9000].min()))
print(pd.DataFrame(rows).set_index("v").round(3).to_string())
fig,ax=plt.subplots(3,1,figsize=(11,12),sharex=True)
groups=[("downstream (step+elbow / muffler)",["AB_ex","AB_ex_muf432","AB_ex_st200","AB_ex_st250","AB_ex_st350","AB_ex_st400","AB_ex_st200_muf432","AB_ex_st400_muf432"]),
        ("head port length",["AB_ex_port40","AB_ex_port50","AB_ex","AB_ex_port80","AB_ex_port90"]),
        ("secondary interpretation",["AB_ex_secC","AB_ex","AB_ex_secB","AB_intake"])]
for a,(t,ns) in zip(ax,groups):
    a.plot(GRID/1000,nm(P),color='k',lw=2.6,label="car ECU proxy")
    cm=plt.cm.viridis(np.linspace(0,.9,len(ns)))
    for n,c in zip(ns,cm):
        m=load(n).ve_del.loc[4000:10750]; a.plot(m.index/1000,nm(m),color=c,lw=1.5,label=f"{n} r={corr(m.reindex(GRID),P):+.2f}")
    a.set_title(t,loc='left'); a.legend(fontsize=7,ncol=2); a.grid(alpha=.3)
    a.axvspan(7.4,8.0,color='r',alpha=.07); a.axvspan(6.0,6.4,color='g',alpha=.07); a.axvspan(8.9,9.1,color='g',alpha=.07)
fig.tight_layout(); fig.savefig(H+"/fig_sens.png",dpi=110)
