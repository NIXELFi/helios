Animated VRLI lap replay (0037 addendum). `vrli-lap-replay.html` = `template.html` with `__DATA__` replaced by
the model torque surface (`out/A_neutral_disp/surface.csv`, converged rows) and a 50 Hz resample of fsae-sim run
`20260927-184646-autocross-755r` (engine.rpm, engine.tps, engine.gear, drivetrain.vehicle_speed) from
`%LOCALAPPDATA%\Helios\sim-runs`. Control strategy shown is a placeholder: follow the rpm table above a TPS threshold,
hold otherwise, with the plate rate-limited to the chosen actuator speed.
