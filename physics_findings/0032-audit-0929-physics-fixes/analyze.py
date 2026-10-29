import glob, json, os, collections
import numpy as np, pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

S = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(os.path.join(S, '..', '..'))
DY = f'{WT}/physics_findings/references/dyno/'
ECU = os.path.join(S, 'ecu_ve_proxy.csv')

rows = collections.defaultdict(dict)
for f in glob.glob(f'{S}/results/*.ndjson'):
    tag = os.path.basename(f)[:-7]
    eng, name = tag.split('_', 1)
    for l in open(f):
        d = json.loads(l)
        if d.get('kind') == 'trial':
            rows[(eng, name)][d['rpm']] = d
res = {k: pd.DataFrame(list(v.values())).set_index('rpm').sort_index() for k, v in rows.items()}

ecu = pd.read_csv(ECU)
ecu = ecu[ecu.dead == 1.0].set_index('bin')


def extrema(x, y):
    pk, tr = [], []
    for i in range(1, len(y) - 1):
        a, b, c = y[i - 1], y[i], y[i + 1]
        if (b > a and b >= c) or (b < a and b <= c):
            den = a - 2 * b + c
            dx = 0.5 * (a - c) / den if den else 0.0
            r = x[i] + dx * (x[1] - x[0])
            (pk if b > a else tr).append(int(round(r, -1)))
    return pk, tr


BANDS = [('WOT 6-13.5k', 6000, 13500), ('peak 7-11.5k', 7000, 11500),
         ('high 10.5k+', 10500, 13500), ('6-8.5k', 6000, 8500)]
out = []
for (eng, name), m in sorted(res.items()):
    dy = pd.read_csv(DY + f'{eng}-team-dyno.csv').set_index('rpm')
    j = dy.join(m[['brake_power_kW', 'brake_torque_Nm', 've_atm']], rsuffix='_sim', how='inner')
    j['dP'] = j.brake_power_kW_sim * 0.85 - j.brake_power_kW
    r = {'engine': eng, 'variant': name}
    for lab, lo, hi in BANDS:
        s = j.loc[lo:hi]
        r[f'RMSE {lab}'] = np.sqrt((s.dP ** 2).mean())
        r[f'bias {lab}'] = s.dP.mean()
    c = ecu.join(m[['ve_atm']], how='inner').loc[4000:10750]
    r['ECU VE corr'] = np.corrcoef(c.ve / c.ve.mean(), c.ve_atm / c.ve_atm.mean())[0, 1]
    pk, tr = extrema(m.index.values, m.ve_atm.values)
    r['VE peaks'] = pk
    r['VE troughs'] = tr
    r['VE mean'] = m.ve_atm.mean()
    r['P peak kW(wheel)'] = m.brake_power_kW.max() * 0.85
    r['max |nonc|/cyc g'] = m.nonconservation.abs().max() * 1e3
    r['min conv'] = int(m.cycles.min())
    out.append(r)
df = pd.DataFrame(out)
pd.set_option('display.width', 250)
pd.set_option('display.max_columns', 30)
cols = ['engine', 'variant', 'RMSE WOT 6-13.5k', 'bias WOT 6-13.5k', 'RMSE peak 7-11.5k', 'RMSE high 10.5k+', 'RMSE 6-8.5k', 'ECU VE corr', 'VE mean', 'P peak kW(wheel)', 'max |nonc|/cyc g']
print(df[cols].round(3).to_string())
for _, r in df.iterrows():
    print(r.engine, r.variant, 'VE peaks', r['VE peaks'], 'troughs', r['VE troughs'])
ep, et = extrema(ecu.loc[4000:10750].index.values, ecu.loc[4000:10750].ve.values)
print('ECU proxy peaks', ep, 'troughs', et)
for eng in ('sdm26', 'sdm25'):
    dy = pd.read_csv(DY + f'{eng}-team-dyno.csv').set_index('rpm')
    print(eng, 'dyno torque peaks/troughs', extrema(dy.index.values, dy.brake_torque_Nm.values))
df.to_csv(f'{S}/summary.csv', index=False)

# ---------------- plot ----------------
INK, INK2, GRID, SURF = '#0b0b0b', '#52514e', '#e4e3df', '#fcfcfb'
COL = {'shipped': '#2a78d6', 'v2': '#eb6834', 'v2cam': '#1baf7a'}
LAB = {'shipped': 'shipped (0028 calibration)', 'v2': 'physics v2 (seat-to-seat cam)', 'v2cam': 'physics v2 + real cam @1 mm'}
plt.rcParams.update({'font.size': 9, 'axes.edgecolor': INK2, 'axes.labelcolor': INK2,
                     'xtick.color': INK2, 'ytick.color': INK2, 'axes.facecolor': SURF,
                     'figure.facecolor': SURF, 'axes.grid': True, 'grid.color': GRID,
                     'grid.linewidth': 0.6, 'axes.spines.top': False, 'axes.spines.right': False})
fig, ax = plt.subplots(2, 2, figsize=(13, 8.5))
for col, eng in enumerate(('sdm26', 'sdm25')):
    dy = pd.read_csv(DY + f'{eng}-team-dyno.csv').set_index('rpm')
    a = ax[0][col]
    a.plot(dy.index / 1000, dy.brake_power_kW, color=INK, lw=2, marker='o', ms=4, label='team dyno (wheel)')
    for v in ('shipped', 'v2', 'v2cam'):
        m = res[(eng, v)]
        rm = df[(df.engine == eng) & (df.variant == v)]['RMSE WOT 6-13.5k'].iloc[0]
        a.plot(m.index / 1000, m.brake_power_kW * 0.85, color=COL[v], lw=2, label=f'{LAB[v]}  RMSE {rm:.2f} kW')
    a.axvspan(4, 6, color=GRID, alpha=0.5, lw=0)
    a.text(4.1, a.get_ylim()[0] + 1, 'outside RMSE band', color=INK2, fontsize=8)
    a.set_title(f'{eng.upper()} wheel power (sim × 0.85) vs team dyno', color=INK, loc='left')
    a.set_xlabel('engine speed (krpm)'); a.set_ylabel('wheel power (kW)')
    a.legend(frameon=False, fontsize=8, loc='lower right')
    b = ax[1][col]
    if eng == 'sdm26':
        e = ecu.loc[4000:10750]
        b.plot(e.index / 1000, e.ve / e.ve.mean(), color=INK, lw=2, marker='o', ms=4, label='ECU VE proxy (PW×λ, WOT log)')
        for v in ('shipped', 'v2', 'v2cam'):
            m = res[(eng, v)].loc[4000:10750]
            rr = df[(df.engine == eng) & (df.variant == v)]['ECU VE corr'].iloc[0]
            b.plot(m.index / 1000, m.ve_atm / m.ve_atm.mean(), color=COL[v], lw=2, label=f'{LAB[v]}  r = {rr:+.2f}')
        b.set_title('SDM26 VE shape: model vs ECU proxy (each normalised to its mean, 4-10.75k)', color=INK, loc='left')
        b.set_ylabel('VE / mean VE')
    else:
        dy = pd.read_csv(DY + f'{eng}-team-dyno.csv').set_index('rpm')
        for v in ('shipped', 'v2', 'v2cam'):
            m = res[(eng, v)]
            b.plot(m.index / 1000, m.ve_atm, color=COL[v], lw=2, label=LAB[v])
        b.set_title('SDM25 model VE (no ECU log available for SDM25)', color=INK, loc='left')
        b.set_ylabel('VE (vs ambient density)')
    b.set_xlabel('engine speed (krpm)')
    b.legend(frameon=False, fontsize=8, loc='lower right')
fig.suptitle('Finding 0032 — engine-sim physics fixes: shipped vs physics-v2 (no re-fit)', x=0.01, ha='left', color=INK, fontsize=12)
fig.tight_layout(rect=(0, 0, 1, 0.96))
fig.savefig(f'{S}/fig_v2_vs_shipped.png', dpi=130)
print('plot saved')

# decomposition (SDM26 single fixes)
dec = df[(df.engine == 'sdm26')][['variant', 'RMSE WOT 6-13.5k', 'bias WOT 6-13.5k', 'ECU VE corr', 'VE mean', 'VE peaks', 'VE troughs']]
print(dec.round(3).to_string())
