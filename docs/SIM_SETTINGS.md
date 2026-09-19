# Where a setting lives: Helios or the simulator

There are two programs and they both have settings screens, so there has to be
a rule for which one owns what. This is it:

> **Helios owns the run. The simulator owns the rig.**

Everything else follows from that one line.

## The rule, stated properly

A setting belongs to **the simulator** if you can only set it correctly with
the hardware in front of you and the car moving. Wheel rotation, force-feedback
gain, pedal calibration, the throttle map, the camera height — you set these by
turning the wheel and watching what happens, and the number that is right is
the one that feels right. Helios cannot read your wheel, cannot drive the
motor, and cannot show you a cockpit. It has no business holding those numbers.

A setting belongs to **Helios** if it describes *what this particular run is*:
who is driving, which course, which driver aids, whether it is logged, and
which lap to chase. These are not properties of the rig — they change every run
and they are what a leaderboard is made of. Helios is the launcher and the
archive, so it is the thing that says "Nick is about to drive autocross with no
aids, chasing his best".

## The split

| | Owner | Where it is kept |
|---|---|---|
| Control profile mapping, deadzones, steering servo | **Sim** | `fsae-sim.controls.v1` (localStorage, per rig) |
| Force-feedback gain, curves, effects | **Sim** | same |
| Pedal calibration | **Sim** | same |
| Throttle (ETC) map | **Sim** | `fsae-sim.etc` |
| Audio mix | **Sim** | `fsae-sim.audio.v1` |
| Camera FOV, eye height, vibration | **Sim** | `fsae-sim.params` |
| Live vehicle parameters | **Sim** (live) | `fsae-sim.params`, and stamped into every run manifest |
| Driver name | **Helios** when it launches, **sim** otherwise | `fsae-sim.driver` is the rig's default |
| Session label | same | `fsae-sim.session` |
| Course | **Helios** when it launches | — |
| Driver aids (TC / ABS / auto gearbox) | **Helios** when it launches | not persisted by the sim at all |
| Recording on/off | **Helios** when it launches | `fsae-sim.record` is the rig's default |
| Reference lap to chase | **Helios** only | — |
| Where runs are filed | **Shared constant** | `%LOCALAPPDATA%\Helios\sim-runs`, `FSAE_SIM_RUNS_DIR` overrides |
| Where the simulator is installed | **Helios** only | `%LOCALAPPDATA%\Helios\sim.json` |

## Precedence, and why it is not "last writer wins"

When Helios launches the simulator it passes the run settings on the command
line. Those apply **to that session only**. They are deliberately NOT written
into the rig's saved settings.

That is not fussiness. Both of these were real:

- Launching with `--driver "Nick Murray"` used to call the same save the text
  box does, so the next person to open the simulator on that rig found their
  runs filed under Nick's name.
- Launching with `--profile wheel` used to go through `setProfile`, which
  **pins** the profile and switches off device auto-detection. One launch from
  Helios left the rig stuck on the wheel profile for whoever sat down next with
  a controller.

So: a launcher describes a run, it does not reconfigure somebody's rig. The
session card on the launch screen says *"set by the launcher, this session
only"* whenever that is what happened, so a name that is not yours is explained
rather than mysterious. Typing in the box takes the run back and does stick —
that is the driver at the rig, which is the one case where it should.

## Vehicle setup: the one genuinely shared thing

The car's parameters are the awkward case. They have to be editable in the
simulator, live, on the d-pad, because that is how you find out what a stiffer
bar does. But a *setup* — a named, agreed set of numbers the team runs — is
engineering data, and Helios is where the team's engineering data lives.

The resolution: **the simulator owns the live values; Helios owns the named
setups.** Every run's manifest carries the full 27-parameter set the run was
actually driven with, so a lap time is never separated from the car that set
it, and Helios's run detail shows it. Pushing a named setup from Helios into a
launch is the natural next step and is not built yet.

## If you are adding a setting

Ask: *could I set this correctly from a laptop with no wheel attached?*

- **No** → it goes in the simulator.
- **Yes, and it changes every run** → it goes in Helios, passed on the command
  line, applied for the session only.
- **Yes, and it is the same every run** → it is probably not a setting, it is a
  constant. Put it in the code with a comment saying why.
