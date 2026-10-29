# Lumped minor-loss variants (finding 0035). K from standard bend data
# (Idelchik/Miller, smooth mandrel bends R/D~1.5-2, Re~1e5): 90 deg ~0.2, 180 deg U ~0.35;
# straight-through perforated muffler ~0.5 (uncertain). Positions from the 0034 geometry.
import json, copy, sys, os
from lib import CFG
def make(src, name, s=1.0, runners=True, prim=True, sec=True, col=True, muffler=0.5, momentum=False, extra=None):
    d = json.load(open(f"{CFG}/{src}.json"))
    if runners:
        for p in d["intake_pipes"]: p["local_losses"] = [[0.12, 0.15 * s]]
    if prim:
        for p in d["exhaust_primaries"]: p["local_losses"] = [[0.12, 0.2 * s], [0.25, 0.2 * s]]
    if sec:
        for p in d["exhaust_secondaries"]: p["local_losses"] = [[0.25, 0.35 * s]]
    if col:
        d["exhaust_collector"]["local_losses"] = [[0.26, 0.25 * s]] + ([[0.51, muffler * s]] if muffler > 0 else [])
    if momentum: d["physics"]["exhaust_junction_momentum"] = True
    if extra: d["physics"].update(extra)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cfg", f"{name}.json")
    json.dump(d, open(out, "w"), indent=1)
    return os.path.abspath(out).replace("\\", "/")
