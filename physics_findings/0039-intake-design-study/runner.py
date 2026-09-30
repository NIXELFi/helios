"""Crash-safe driver for finding 0039: grid -> tip-in -> charts, with periodic git checkpoints.

Runs detached from Claude (so a session/memory reaper can't kill it) and is relaunched at logon by
`resume_0039.cmd` in the Startup folder until DONE exists. Every stage is resumable (NDJSON caches).
Checkpoints commit ONLY this folder's result files and push, so a dead laptop loses at most ~15 min.
"""
import os, subprocess, sys, threading, time, datetime

H = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(H, "..", ".."))
DONE = os.path.join(H, "DONE")
LOG = os.path.join(H, "runner.log")
TRACK = ["results_c160.ndjson", "tipin_c160.ndjson", "diag", "charts", "cfg", "progress.txt"]
stop = threading.Event()


def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")


def progress():
    n = sum(1 for _ in open(os.path.join(H, "results_c160.ndjson"))) if os.path.exists(os.path.join(H, "results_c160.ndjson")) else 0
    t = sum(1 for _ in open(os.path.join(H, "tipin_c160.ndjson"))) if os.path.exists(os.path.join(H, "tipin_c160.ndjson")) else 0
    s = f"{datetime.datetime.now():%Y-%m-%d %H:%M} grid rows {n} (of 3168), tip-in rows {t}/92\n"
    open(os.path.join(H, "progress.txt"), "w").write(s)
    return s.strip()


def checkpoint(tag):
    p = progress()
    paths = [os.path.join(H, x) for x in TRACK if os.path.exists(os.path.join(H, x))]
    g = lambda *a: subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True)
    g("add", "--", *paths)
    r = g("commit", "-m", f"wip(0039): intake study checkpoint ({tag}) - {p}", "--", *paths)
    if r.returncode == 0:
        pr = g("push", "-q")
        log(f"checkpoint {tag}: committed, push rc={pr.returncode} {pr.stderr.strip()[:200]}")
    else:
        log(f"checkpoint {tag}: nothing new")


def ticker():
    while not stop.wait(900):
        try: checkpoint("15 min")
        except Exception as e: log(f"checkpoint error {e!r}")


def stage(name, script):
    log(f"start {name}")
    with open(os.path.join(H, f"{name}.log"), "a") as f:
        rc = subprocess.run([sys.executable, "-u", os.path.join(H, script)], cwd=H, stdout=f, stderr=subprocess.STDOUT).returncode
    log(f"end {name} rc={rc}")
    return rc


if __name__ == "__main__":
    if os.path.exists(DONE):
        sys.exit(0)
    pidf = os.path.join(H, "runner.pid")
    if os.path.exists(pidf):
        old = open(pidf).read().strip()
        alive = subprocess.run(["tasklist", "/FI", f"PID eq {old}", "/NH"], capture_output=True, text=True).stdout
        if "python" in alive.lower():
            sys.exit(0)
    open(pidf, "w").write(str(os.getpid()))
    log(f"runner up, pid {os.getpid()}")
    threading.Thread(target=ticker, daemon=True).start()
    # study.py retries errored points on each pass; two passes clear transient failures
    ok = stage("study", "study.py") == 0 and stage("study", "study.py") == 0
    ok = ok and stage("tipin", "tipin_study.py") == 0
    ok = ok and stage("charts", "charts.py") == 0
    stop.set()
    checkpoint("final" if ok else "stage failed")
    if ok:
        open(DONE, "w").write(datetime.datetime.now().isoformat())
        log("ALL DONE")
