Shorter-runner addendum (2026-09-29). Surface extended to extension -190..+160 mm (runner 138-488 mm), study
`studies/E_short.toml` (cache-shared). `short_study.py`: fixed-length sweep (dyno-style 6-12k and 7-10.5k averages)
and lap-based designs with the rate-feasible controller (`vrli_control.py`) over the 10 fastest clean shared
fsae-sim autocross laps from the Helios `sim-telemetry` bucket.

Key point: the best length depends on the on-throttle rpm duty cycle. Sim AX laps (median 10.8k on throttle) favour
SHORTER runners (fixed 268 mm +4.2 %, shorten-only VRLI 228-328 mm +5.5 %); the real car's Log 7.5 (median 6.4k)
favours LONGER (VRLI 343-443 mm +4.1 %). A wide-stroke design 268-443 mm is best under both (+5.5 % / +4.7 %),
at ~1.5 kg (the C2 limit). Get an autocross-pace ECU log before freezing the range.

## Real autocross duty cycle (2026-09-30)

Source: `SDM26 Josh Autocross 4.26` (Link G4X CSV export, 4 sessions, 2026-04-26; not committed - team data).
On-throttle (APS >= 60 %, no fuel cut) rpm: median 7.4k; 30 % at 3-6k, 56 % at 6-10k, 14 % at 10-12.5k, 0 % above.
The sim drivers' laps (median 10.8k) are NOT representative of the car's real autocross use.

Designs driven by Josh's real rpm/APS traces with the rate-feasible controller (`josh_ax_designs.csv`):
shorten-only 228-328 mm +1.2 %, 268-368 +1.8 %, 343-443 +2.9 %, 268-443 +4.0 %, 388-488 +6.5 %.
Fixed runner weighted by real on-throttle time: 268 mm -0.9 %, 328 mm 0, 428 mm +1.7 %, 488 mm +5.3 %.
=> On the real duty cycle LONGER runners win; shorter only helped at sim-driver pace. Much of the long-runner gain
is at 4-6k (30 % of on-throttle time), where the dyno is unreliable, so confirm with a runner-length A/B.
