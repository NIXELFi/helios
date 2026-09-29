"""Finding 0032 validation driver: shipped vs physics-v2 (with / without the
real cam) plus single-fix decomposition, SDM26 + SDM25, 4000-13500 rpm /
250 rpm / 30 cycles, via helios-bench sweep (one process per rpm chunk)."""
import copy, json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

WT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
S = os.environ.get('OUT_DIR', 'v2val_out')  # scratch output dir
EXE = f'{WT}/target/release/helios-bench.exe'
CFG = f'{WT}/apps/desktop/src-tauri/resources/cfd/configs'
RPMS = [4000.0 + 250 * i for i in range(39)]  # 4000..13500


def shipped(eng):
    return json.load(open(f'{CFG}/{eng}.json'))


V2_FLAGS = {
    "intake_junction_directional_loss": True,
    "intake_runner_entry_k": 0.04,
    "restrictor_venturi_model": True,
    "intake_runner_end_correction": True,
    "exhaust_collector_end_correction": True,
    "exhaust_collector_open_end_physical": True,
    "fuel_mass_from_trapped_air": True,
    "heat_release_o2_limited": True,
    "enable_residual_tracking": True,
}
# Fudges superseded by the physical models (removed from the v2 block).
V2_DROP = [
    "exhaust_collector_reflection_coef",   # -> physical open end
    "restrictor_cd_mach_k",                # -> venturi model
    "restrictor_loss_from_diffuser_geometry",
    "intake_junction_borda_carnot",        # -> directional junction
]


def geometric_collector(d):
    d['exhaust_collector']['length'] = 0.100
    d['exhaust_collector']['length_note'] = (
        "geometric length; the 0.6133*r Levine-Schwinger end correction is "
        "added by physics.exhaust_collector_end_correction")


def v2(d):
    geometric_collector(d)
    for k in V2_DROP:
        d['physics'].pop(k, None)
    d['physics'].update(V2_FLAGS)


def real_cam(d):
    # Honda CBR600RR (PC40) service manual: timing at 1 mm lift.
    d['intake_valve']['open_angle'] = 339.0    # 21 deg BTDC
    d['intake_valve']['close_angle'] = 584.0   # 44 deg ABDC
    d['exhaust_valve']['open_angle'] = 140.0   # 40 deg BBDC
    d['exhaust_valve']['close_angle'] = 365.0  # 5 deg ATDC
    d['physics']['valve_events_at_reference_lift'] = True
    d['physics']['valve_event_reference_lift'] = 0.001
    d['physics']['valve_lift_shape_exponent'] = 1.3
    d['physics'].pop('intake_lift_flat_top_ramp', None)
    d['physics'].pop('exhaust_lift_flat_top_ramp', None)


def v2cam(d):
    v2(d)
    real_cam(d)


def single(flags, drop=(), extra=None):
    def f(d):
        for k in drop:
            d['physics'].pop(k, None)
        d['physics'].update(flags)
        if extra:
            extra(d)
    return f


VARIANTS = {
    'shipped': lambda d: None,
    'v2': v2,
    'v2cam': v2cam,
}
DECOMP = {
    'f1_dir': single({"intake_junction_directional_loss": True}, ["intake_junction_borda_carnot"]),
    'f2_venturi': single({"restrictor_venturi_model": True}, ["restrictor_cd_mach_k", "restrictor_loss_from_diffuser_geometry"]),
    'f4_runner_ec': single({"intake_runner_end_correction": True}),
    'f4_collector_ec': single({"exhaust_collector_end_correction": True}, extra=geometric_collector),
    'f5_open_end': single({"exhaust_collector_open_end_physical": True}, ["exhaust_collector_reflection_coef"]),
    'f7_fuel': single({"fuel_mass_from_trapped_air": True, "heat_release_o2_limited": True, "enable_residual_tracking": True}),
    'cam_only': real_cam,
}


def jobs_for(eng, name, fn, chunk=3):
    d = copy.deepcopy(shipped(eng))
    fn(d)
    os.makedirs(f'{S}/cfg', exist_ok=True)
    p = f'{S}/cfg/{eng}_{name}.json'
    json.dump(d, open(p, 'w'), indent=2)
    return [(eng, name, p, RPMS[i:i + chunk]) for i in range(0, len(RPMS), chunk)]


def run(job):
    eng, name, p, rpms = job
    tag = f'{eng}_{name}_{int(rpms[0])}'
    os.makedirs(f'{S}/tmp', exist_ok=True)
    os.makedirs(f'{S}/out', exist_ok=True)
    t = f'{S}/tmp/{tag}.toml'
    open(t, 'w').write(f'''[run]
config = "{p}"
rpm = {json.dumps(rpms)}
cycles = 30
recorded = false
seed = 1
junction = "characteristic"
[environment]
target_triple = "x86_64-pc-windows-msvc"
rustc_version = "x"
rayon_threads = 1
libm_source = "system"
[sweep]
sampler = "lhs"
n_trials = 1
parameters = []
''')
    r = subprocess.run([EXE, 'sweep', t, '--out', f'{S}/out/{tag}.ndjson', '--commit', 'v2val'],
                       capture_output=True, text=True)
    if r.returncode:
        print('FAIL', tag, r.stderr[-800:], flush=True)
    elif r.stderr.strip():
        print('STDERR', tag, r.stderr.strip()[:300], flush=True)
    return tag


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'main'
    jobs = []
    if which in ('main', 'all'):
        for eng in ('sdm26', 'sdm25'):
            for n, f in VARIANTS.items():
                jobs += jobs_for(eng, n, f)
    if which in ('decomp', 'all'):
        for n, f in DECOMP.items():
            jobs += jobs_for('sdm26', n, f)
    print(len(jobs), 'jobs', flush=True)
    with ThreadPoolExecutor(int(os.environ.get('NPAR', '20'))) as ex:
        for tag in ex.map(run, jobs):
            print('done', tag, flush=True)


def v2cam_noventuri(d):
    v2cam(d)
    d['physics'].pop('restrictor_venturi_model', None)
    d['physics']['restrictor_cd_mach_k'] = 0.1
    d['physics']['restrictor_loss_from_diffuser_geometry'] = True


EXTRA = {'f1_dir': DECOMP['f1_dir'], 'cam_only': real_cam, 'v2cam_noventuri': v2cam_noventuri}
if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'extra':
    jobs = []
    for n, f in EXTRA.items():
        jobs += jobs_for('sdm25', n, f)
    jobs += jobs_for('sdm26', 'v2cam_noventuri', v2cam_noventuri)
    with ThreadPoolExecutor(22) as ex:
        for tag in ex.map(run, jobs):
            print('done', tag, flush=True)
