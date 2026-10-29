# Write an engine config JSON for one ensemble sample: the 0036 base with the
# sample's applied override values written into the matching JSON keys.
# Used for the "most plausible physics" candidate and for phase 2 (VRLI).
import os, json, copy

H = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(H, "..", "..", ".."))
BASE = os.path.join(REPO, "apps", "desktop", "src-tauri", "resources", "cfd", "configs", "sdm26_asbuilt_cal.json")


def sample_config(applied, eta_dt=None, base_path=BASE, name=None, neutral_tune=False):
    """applied: {override path: value} from the ensemble ndjson ('applied' map)."""
    d = json.load(open(base_path))
    d = copy.deepcopy(d)
    ph = d.setdefault("physics", {})
    for k, v in applied.items():
        if k == "exhaust_valve_open_angle": d["exhaust_valve"]["open_angle"] = v
        elif k == "exhaust_valve_close_angle": d["exhaust_valve"]["close_angle"] = v
        elif k == "exhaust_valve_max_lift": d["exhaust_valve"]["max_lift"] = v
        elif k == "intake_valve_open_angle": d["intake_valve"]["open_angle"] = v
        elif k == "intake_valve_close_angle": d["intake_valve"]["close_angle"] = v
        elif k == "intake_valve_max_lift": d["intake_valve"]["max_lift"] = v
        elif k == "primary_wall_t":
            for p in d["exhaust_primaries"]: p["wall_temperature"] = v
        elif k == "secondary_wall_t":
            for p in d.get("exhaust_secondaries", []): p["wall_temperature"] = v
        elif k == "collector_wall_t": d["exhaust_collector"]["wall_temperature"] = v
        elif k == "p_ambient": d["p_ambient"] = v
        elif k == "t_ambient": d["T_ambient"] = v
        elif k in ("intake_cd_multiplier", "exhaust_cd_multiplier", "intake_port_length_delta",
                   "exhaust_port_length_delta", "restrictor_diffuser_efficiency"):
            ph[k] = v
        else:
            raise KeyError(f"no JSON mapping for override {k!r}")
    if eta_dt is not None:
        d["drivetrain_efficiency"] = round(float(eta_dt), 4)
    if neutral_tune:
        ph.pop("afr_map", None); ph.pop("spark_advance_map", None)
    if name:
        d["name"] = name
    return d


if __name__ == "__main__":
    import sys, pandas as pd
    F = os.path.normpath(os.path.join(H, ".."))
    S = pd.read_csv(os.path.join(F, "out", "samples_scored.csv"), index_col=0)
    best = S.weight.idxmax()
    r = S.loc[best]
    applied = {c.split(":", 1)[1]: float(r[c]) for c in S.columns if c.startswith("applied:")}
    d = sample_config(applied, eta_dt=r.eta_dt, name=f"SDM26 as-built, 0038 UQ best-weighted sample {best} (candidate, NOT calibrated)")
    d["description"] = ("Finding 0038: the highest-posterior-weight sample of the phase-1 UQ ensemble on top of sdm26_asbuilt_cal. "
                        "A candidate 'most plausible physics' set for review, not a calibration: every value is inside its prior "
                        "and the weight comes from a tempered likelihood.")
    out = os.path.join(F, "out", "best_sample_config.json")
    json.dump(d, open(out, "w"), indent=1)
    print(out, "sample", best, "weight", round(r.weight, 3))
    print(json.dumps(applied, indent=1))
