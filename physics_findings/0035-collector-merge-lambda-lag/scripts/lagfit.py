import pandas as pd, numpy as np
import os
d=pd.read_pickle(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','references','ecu','scripts','log.pkl')); t=d['Section Time'].values
fc=d['% Fuel Cut'].values; lam=d['Lambda 1'].values; rpm=d['Engine Speed'].values; mp=d['MAP'].values; ic=d['% Ignition Cut'].values; aps=d['APS (Main)'].values
ev=[]
on=np.where((fc[1:]>=50)&(fc[:-1]<50))[0]+1
for i in on:
    dur=np.argmax(fc[i:i+3000]<50)
    if dur<250: continue
    base=np.nanmedian(lam[i-100:i]); pl=np.nanmedian(lam[i+dur-100:i+dur]) if dur>400 else np.nanmax(lam[i:i+dur])
    k=np.argmax((lam[i:i+dur]-base)/(pl-base)>0.5)
    ev.append(('overrun',rpm[i],np.median(mp[i-50:i+k]),k))
on=np.where((ic[1:]>0)&(ic[:-1]==0))[0]+1
for i in on:
    dur=np.argmax(ic[i:i+3000]==0)
    if aps[i]<80 or fc[i]>0 or dur<400: continue
    base=np.nanmedian(lam[i-60:i]); pl=np.nanmedian(lam[i+250:i+400])
    if abs(pl-base)<0.08: continue
    k=np.argmax((lam[i:i+400]-base)/(pl-base)>0.5); ev.append(('wot_igncut',rpm[i],np.median(mp[i-50:i+k]),k))
E=pd.DataFrame(ev,columns=['kind','rpm','MAP','t50']); E['x']=(10800*96)/(E.rpm*E.MAP)
print(E.round(2).to_string())
A=np.vstack([np.ones(len(E)),E.x]).T; c=np.linalg.lstsq(A,E.t50.astype(float),rcond=None)[0]
print('fit t50 = %.1f + %.1f * (10800*96)/(rpm*MAP)'%tuple(c))
for r,m in [(4000,96),(5000,96),(6000,94.3),(7000,93.6),(7500,93),(8000,92.4),(9000,89.6),(10000,88.6)]: print(r, round(c[0]+c[1]*10800*96/(r*m)),'ms')
np.save('lagfit.npy',c)
