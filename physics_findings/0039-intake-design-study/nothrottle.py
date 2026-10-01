"""Opt processes out of Windows power throttling (EcoQoS / efficiency mode). No admin needed.
Windows 11 throttled the background engine processes to ~25 % of a core each on 2026-09-30."""
import ctypes, ctypes.wintypes as w, subprocess, sys
K = ctypes.WinDLL("kernel32", use_last_error=True)
class PPT(ctypes.Structure):
    _fields_ = [("Version", w.ULONG), ("ControlMask", w.ULONG), ("StateMask", w.ULONG)]
def unthrottle(pid):
    h = K.OpenProcess(0x0200 | 0x1000, False, pid)          # PROCESS_SET_INFORMATION | QUERY_LIMITED
    if not h: return False
    s = PPT(1, 0x1 | 0x4, 0)                                  # EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION, state off
    ok = K.SetProcessInformation(h, 4, ctypes.byref(s), ctypes.sizeof(s))   # ProcessPowerThrottling
    K.CloseHandle(h); return bool(ok)
def pids(name):
    o = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {name}", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    return [int(l.split('","')[1]) for l in o.splitlines() if l.startswith('"')]
NAMES = ["intakepoint.exe", "tipin.exe", "python3.11.exe"]
if __name__ == "__main__":
    if sys.argv[1:2] == ["--watch"]:          # keep new engine processes at full speed until the study writes DONE
        import os, time
        done = os.path.join(os.path.dirname(os.path.abspath(__file__)), "DONE"); seen = set()
        while not os.path.exists(done):
            for n in NAMES:
                for p in pids(n):
                    if p not in seen and unthrottle(p): seen.add(p)
            time.sleep(3)
    else:
        for n in NAMES:
            r = [unthrottle(p) for p in pids(n)]; print(n, f"{sum(r)}/{len(r)} unthrottled")
