from lib import *
AB=CFG+"/sdm26_asbuilt_exhaust.json"; RT=CFG+"/sdm26_asbuilt_realtune.json"
V=[("AB_ex",AB,[]),("M10",AB,["exhaust_junction_momentum=1"]),("M0",AB,["exhaust_junction_momentum=1","exhaust_merge_angle_deg=0"]),
   ("M20",AB,["exhaust_junction_momentum=1","exhaust_merge_angle_deg=20"]),("RT",RT,[]),("RT_M10",RT,["exhaust_junction_momentum=1"])]
for n,c,e in V:
    run_variant(n,c,e); print(n,"done",flush=True)
print(table([n for n,_,_ in V]).to_string())
