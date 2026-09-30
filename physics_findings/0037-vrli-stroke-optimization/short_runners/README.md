Shorter-runner addendum (2026-09-29). Surface extended to extension -190..+160 mm (runner 138-488 mm), study
`studies/E_short.toml` (cache-shared). `short_study.py`: fixed-length sweep (dyno-style 6-12k and 7-10.5k averages)
and lap-based designs with the rate-feasible controller (`vrli_control.py`) over the 10 fastest clean shared
fsae-sim autocross laps from the Helios `sim-telemetry` bucket.

Key point: the best length depends on the on-throttle rpm duty cycle. Sim AX laps (median 10.8k on throttle) favour
SHORTER runners (fixed 268 mm +4.2 %, shorten-only VRLI 228-328 mm +5.5 %); the real car's Log 7.5 (median 6.4k)
favours LONGER (VRLI 343-443 mm +4.1 %). A wide-stroke design 268-443 mm is best under both (+5.5 % / +4.7 %),
at ~1.5 kg (the C2 limit). Get an autocross-pace ECU log before freezing the range.
