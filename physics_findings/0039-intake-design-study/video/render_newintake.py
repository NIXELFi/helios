"""Finding 0039: the recommended intake (VRLI 198-298 mm, 2.75 L box, ~123 mm venturi) vs today's static intake,
overlaid on an fsae-sim autocross replay. Fork of 0037/replay/video/render2.py; torque from the direct 1D runs.

Run: python render2.py out.mp4            (full video)
     python render2.py still.png --still T  (one frame at replay time T over the matching video frame)
"""
import json, math, os, subprocess, sys
import numpy as np, pandas as pd, skia, imageio_ffmpeg
from vrli_control_new import Design, run_lap, torque, BASE, R_LO, R_HI
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import core
WHEEL = core.today()          # calibrated wheel torque of today's car vs rpm

HERE = os.path.dirname(os.path.abspath(__file__))
RUN = "20260928-224849-autocross-7hf6"
RUNDIR = os.path.expanduser(f"~/fsae-sim/sim/runs/{RUN}")
SRC = os.path.join(HERE, "sim_lap2.mp4")                 # last night's fsae-sim replay export (same run)
W, H, FPS = 1920, 1080, 60

man = json.load(open(os.path.join(RUNDIR, "run.json"))); lap = man["laps"][0]
T0 = max(0.0, lap["startedAtS"] - 1.0)
tel = pd.read_csv(os.path.join(RUNDIR, "telemetry.csv"), usecols=["time_s", "engine.rpm", "engine.tps", "engine.gear", "drivetrain.vehicle_speed"])
t = tel.time_s.values; rpm = tel["engine.rpm"].values; tps = tel["engine.tps"].values
gear = tel["engine.gear"].values; kph = tel["drivetrain.vehicle_speed"].values

D = Design(lo=198.1, hi=298.1)
sim = run_lap(t, rpm, tps, D)
LAP_GAIN = sim["mean"]; LAP_IDEAL = sim["mean_ideal"]
def at(a, x): return float(np.interp(x, t, a))
def at_step(a, x): return a[min(max(int(np.searchsorted(t, x)) - 1, 0), len(a) - 1)]

# ---------------- style ----------------
def C(h, a=1.0): h = h.lstrip("#"); return skia.Color(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(a * 255))
INK, MUTED, FAINT = C("EEF2F6"), C("A3B0BD"), C("6E7C8A")
BLUE, AMBER, GREEN, RED = C("56A8FF"), C("FFB547"), C("3DDC97"), C("FF6B6B")
TINT = C("0B1016", 0.60); EDGE = C("FFFFFF", 0.10)
def face(fam, weight=400): return skia.Typeface(fam, skia.FontStyle(weight, skia.FontStyle.kNormal_Width, skia.FontStyle.kUpright_Slant))
BAHN = face("Bahnschrift", 400); BAHN_B = face("Bahnschrift", 700); SEG = face("Segoe UI", 400); SEG_SB = face("Segoe UI", 600)
def font(tf, size): f = skia.Font(tf, size); f.setSubpixel(True); f.setEdging(skia.Font.Edging.kSubpixelAntiAlias); return f
def text(c, s, x, y, f, col, align="left"):
    p = skia.Paint(AntiAlias=True, Color=col)
    w = f.measureText(s)
    if align == "right": x -= w
    elif align == "center": x -= w / 2
    c.drawString(s, x, y, f, p); return w
def paint(col, stroke=None, cap=skia.Paint.kRound_Cap):
    p = skia.Paint(AntiAlias=True, Color=col)
    if stroke: p.setStyle(skia.Paint.kStroke_Style); p.setStrokeWidth(stroke); p.setStrokeCap(cap)
    return p

def glass(c, img, x, y, w, h, r=18):
    rr = skia.RRect.MakeRectXY(skia.Rect.MakeXYWH(x, y, w, h), r, r)
    c.save(); c.clipRRect(rr, doAntiAlias=True)
    c.drawImage(img, 0, 0, skia.SamplingOptions(), skia.Paint(ImageFilter=skia.ImageFilters.Blur(22, 22)))
    c.drawRRect(rr, skia.Paint(AntiAlias=True, Color=TINT)); c.restore()
    c.drawRRect(rr, paint(EDGE, 1.2))

def lin(x0, y0, x1, y1, cols, pos=None):
    return skia.GradientShader.MakeLinear([skia.Point(x0, y0), skia.Point(x1, y1)], cols, pos)

# ---------------- intake section ----------------
SX, SY, SW, SH = 1452, 36, 432, 720             # card
PL, PR = SX + 58, SX + SW - 74                  # plenum inner x
ROOF, FLOOR = SY + 140, SY + 460
HEAD = FLOOR + 80
XS = [PL + 44 + i * ((PR - PL - 88) / 3) for i in range(4)]
OD, BELL = 30, 15                                # trumpet OD (px), bell radius
MM = 2.0                                        # px per mm of travel
def mouth_y(ext): return FLOOR - 40 - (ext - D.lo) * MM

def trumpet(c, cx, ym, ghost=False):
    y0 = ym + BELL                               # where the straight tube starts
    xl, xr = cx - OD / 2, cx + OD / 2
    path = skia.Path()
    path.moveTo(xl, FLOOR + 60); path.lineTo(xl, y0)
    path.quadTo(xl, ym, xl - BELL, ym)           # flare out to the lip
    path.lineTo(xl - BELL, ym - 5); path.lineTo(xr + BELL, ym - 5); path.lineTo(xr + BELL, ym)
    path.quadTo(xr, ym, xr, y0); path.lineTo(xr, FLOOR + 60); path.close()
    if ghost:
        c.drawPath(path, paint(C("FFB547", 0.85), 1.6)); return
    sh = lin(xl - BELL, 0, xr + BELL, 0, [C("7E8B98"), C("E3EAF0"), C("B9C4CE"), C("6D7A87")], [0.0, 0.35, 0.6, 1.0])
    c.drawPath(path, skia.Paint(AntiAlias=True, Shader=sh))
    c.drawPath(path, paint(C("2A333D", 0.9), 1.0))
    # dark bore visible at the mouth
    c.drawOval(skia.Rect.MakeLTRB(xl - BELL + 3, ym - 8, xr + BELL - 3, ym - 1), skia.Paint(AntiAlias=True, Color=C("10151B")))

def particles(c, phase, r_now, ym):
    if r_now < 2500: return
    speed = 0.35 + 0.9 * min(r_now, 13000) / 13000
    inlet = (PL - 6, ROOF + 92)
    def pos_at(u, i):
        cx = XS[i % 4]; spread = ((i * 37) % 9 - 4) * 1.4
        if u < 0.55:
            s_ = u / 0.55; p0 = inlet; p1 = (cx + spread * 2, ROOF + 36); p2 = (cx + spread * 0.5, ym - 34)
            return ((1 - s_) ** 2 * p0[0] + 2 * (1 - s_) * s_ * p1[0] + s_ * s_ * p2[0],
                    (1 - s_) ** 2 * p0[1] + 2 * (1 - s_) * s_ * p1[1] + s_ * s_ * p2[1])
        s_ = (u - 0.55) / 0.45
        return (cx + spread * 0.5 * (1 - s_), (ym - 34) + s_ * (HEAD - 8 - (ym - 34)))
    N = 72
    for i in range(N):
        u = (phase * speed + i / N + (i % 5) * 0.011) % 1.0
        fade = math.sin(math.pi * u) ** 0.6
        for j, (du, rad, al) in enumerate(((0.0, 2.3, 0.9), (0.012, 1.8, 0.45), (0.024, 1.4, 0.22))):
            uu = u - du
            if uu < 0: continue
            x, y = pos_at(uu, i)
            c.drawCircle(x, y, rad, skia.Paint(AntiAlias=True, Color=C("A8D8FF", al * fade)))

def section(c, img, tt, phase):
    glass(c, img, SX, SY, SW, SH)
    text(c, "INTAKE  ·  SECTION VIEW", SX + 24, SY + 36, font(BAHN, 15), MUTED)
    text(c, f"{BASE + D.lo:.0f}–{BASE + D.hi:.0f} mm runners", SX + 24, SY + 68, font(BAHN_B, 27), INK)
    text(c, "2.75 L box · 100 mm stroke · 200 mm/s · 123 mm venturi", SX + 24, SY + 94, font(SEG, 15), MUTED)
    a_ = at(sim["act"], tt); c_ = at(sim["cmd"], tt); r_ = at(rpm, tt); ym = mouth_y(a_)
    # plenum body
    body = skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(PL, ROOF, PR, FLOOR), 22, 22)
    c.drawRRect(body, skia.Paint(AntiAlias=True, Shader=lin(0, ROOF, 0, FLOOR, [C("243140", 0.92), C("141C25", 0.92)])))
    c.drawRRect(body, paint(C("5B6B7B"), 2.0))
    # restrictor venturi into the left wall
    v = skia.Path(); cy = ROOF + 92
    v.moveTo(SX + 10, cy - 20); v.quadTo(SX + 30, cy - 5, PL - 2, cy - 12); v.lineTo(PL - 2, cy + 12); v.quadTo(SX + 30, cy + 5, SX + 10, cy + 20); v.close()
    c.drawPath(v, skia.Paint(AntiAlias=True, Shader=lin(0, cy - 20, 0, cy + 20, [C("8795A3"), C("C9D3DC"), C("7B8997")])))
    text(c, "Ø20", SX + 8, cy + 42, font(BAHN, 14), FAINT)
    # guide rods + lead screw + servo
    for gx in (PL + 18, PR - 18): c.drawLine(gx, ROOF + 6, gx, FLOOR - 4, paint(C("7F8C99"), 3))
    sx = (PL + PR) / 2
    for yy in np.arange(ROOF + 4, ym + 18, 5.0): c.drawLine(sx - 4, yy, sx + 4, yy + 2.5, paint(C("9AA7B4"), 1.4))
    servo = skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(sx - 34, ROOF - 42, sx + 34, ROOF - 4), 7, 7)
    c.drawRRect(servo, skia.Paint(AntiAlias=True, Shader=lin(0, ROOF - 42, 0, ROOF - 4, [C("3A4652"), C("222A33")]))); c.drawRRect(servo, paint(C("6C7A88"), 1.2))
    text(c, "servo", sx, ROOF - 18, font(BAHN, 14), MUTED, "center")
    # head flange, stubs, head
    c.drawRect(skia.Rect.MakeLTRB(PL - 8, FLOOR - 2, PR + 8, FLOOR + 8), skia.Paint(AntiAlias=True, Color=C("8C99A6")))
    for cx in XS:
        c.drawRect(skia.Rect.MakeLTRB(cx - OD / 2 + 4, FLOOR + 8, cx + OD / 2 - 4, HEAD), skia.Paint(AntiAlias=True, Shader=lin(cx - 15, 0, cx + 15, 0, [C("46515C"), C("6B7784"), C("3C4650")])))
    c.drawRRect(skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(PL - 8, HEAD, PR + 8, HEAD + 16), 4, 4), skia.Paint(AntiAlias=True, Color=C("5C6875")))
    text(c, "cylinder head", PR + 8, HEAD + 34, font(SEG, 14), FAINT, "right")
    # commanded ghost (only when it differs) + trumpets + plate
    gm = mouth_y(c_)
    if abs(gm - ym) > 2:
        for cx in XS: trumpet(c, cx, gm, ghost=True)
    particles(c, phase, r_, ym)
    for cx in XS: trumpet(c, cx, ym)
    plate = skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(PL + 10, ym + 26, PR - 10, ym + 38), 4, 4)
    c.drawRRect(plate, skia.Paint(AntiAlias=True, Shader=lin(0, ym + 26, 0, ym + 38, [C("5A7FA8"), C("24364A")])))
    # travel ruler with target / actual markers
    rx = PR + 30; y_hi, y_lo = mouth_y(D.hi), mouth_y(D.lo)
    c.drawLine(rx, y_hi, rx, y_lo, paint(C("6E7C8A"), 2))
    for mm in np.arange(D.lo, D.hi + 0.1, 10.0):
        L = 10 if int(round(mm - D.lo)) % 50 == 0 else 5
        c.drawLine(rx, mouth_y(mm), rx + L, mouth_y(mm), paint(C("6E7C8A"), 1.4))
    for mm in (D.lo, (D.lo + D.hi) / 2, D.hi): text(c, f"{BASE + mm:.0f}", rx + 14, mouth_y(mm) + 5, font(BAHN, 14), MUTED)
    def marker(y, col, left=True):
        p = skia.Path(); x0 = rx - 3
        p.moveTo(x0, y); p.lineTo(x0 - 11, y - 7); p.lineTo(x0 - 11, y + 7); p.close(); c.drawPath(p, skia.Paint(AntiAlias=True, Color=col))
    marker(gm, AMBER); marker(ym, BLUE)
    # readout row
    ry = SY + SH - 110
    text(c, "RUNNER", SX + 24, ry, font(BAHN, 14), MUTED)
    text(c, f"{BASE + a_:.0f}", SX + 22, ry + 48, font(BAHN_B, 50), BLUE); text(c, "mm", SX + 124, ry + 48, font(BAHN, 20), MUTED)
    text(c, f"target {BASE + c_:.0f} mm", SX + 24, ry + 76, font(SEG, 16), AMBER)
    # gain chip
    on = tps_now(tt) >= 60; gn = at_step(sim["gain"], tt)
    if on and np.isfinite(gn):
        tn, to = at_step(sim["t_new"], tt), at_step(sim["t_old"], tt); wk = float(WHEEL(np.array([r_]))[0]) / to
        col = GREEN if gn >= 0 else RED; label = f"{gn * 100:+.1f}%"; sub = f"{to * wk:.1f} -> {tn * wk:.1f} N·m at wheel"
    elif on:
        col = FAINT; label = "—"; sub = "outside the 4-12.5k runs"
    else:
        col = FAINT; label = "lift"; sub = "pre-positioning for exit"
    text(c, "VS TODAY'S INTAKE", SX + 232, ry, font(BAHN, 14), MUTED)
    text(c, label, SX + 230, ry + 48, font(BAHN_B, 50), col); text(c, sub, SX + 232, ry + 76, font(SEG, 16), MUTED)

def tps_now(tt): return at(tps, tt)

# ---------------- instrument card ----------------
IX, IY, IW, IH = 36, 868, 820, 176
def instruments(c, img, tt):
    glass(c, img, IX, IY, IW, IH)
    r_ = at(rpm, tt); g_ = int(at_step(gear, tt)); v_ = at(kph, tt); p_ = at(tps, tt)
    text(c, f"{r_:,.0f}", IX + 24, IY + 72, font(BAHN_B, 64), INK); text(c, "rpm", IX + 196, IY + 72, font(BAHN, 20), MUTED)
    # rpm bar 0-14k, model range band
    bx0, bx1, by = IX + 24, IX + 300, IY + 96
    c.drawRRect(skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(bx0, by, bx1, by + 8), 4, 4), skia.Paint(AntiAlias=True, Color=C("FFFFFF", 0.10)))
    xr = lambda v: bx0 + (bx1 - bx0) * min(v, 14000) / 14000
    c.drawRRect(skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(xr(4000), by, xr(12500), by + 8), 4, 4), skia.Paint(AntiAlias=True, Color=C("56A8FF", 0.22)))
    c.drawRRect(skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(bx0, by, xr(r_), by + 8), 4, 4), skia.Paint(AntiAlias=True, Color=INK))
    text(c, "4k–12.5k simulated", xr(4000), by + 28, font(SEG, 13), FAINT)
    # gear + speed + throttle
    text(c, "GEAR", IX + 330, IY + 34, font(BAHN, 14), MUTED); text(c, f"{g_}", IX + 330, IY + 84, font(BAHN_B, 50), INK)
    text(c, f"{v_:.0f} km/h", IX + 330, IY + 116, font(SEG, 16), MUTED)
    text(c, "THROTTLE", IX + 24, IY + 158, font(BAHN, 13), MUTED)
    tx0, tx1, ty = IX + 100, IX + 300, IY + 148
    c.drawRRect(skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(tx0, ty, tx1, ty + 10), 5, 5), skia.Paint(AntiAlias=True, Color=C("FFFFFF", 0.10)))
    c.drawRRect(skia.RRect.MakeRectXY(skia.Rect.MakeLTRB(tx0, ty, tx0 + (tx1 - tx0) * p_ / 100, ty + 10), 5, 5), skia.Paint(AntiAlias=True, Color=GREEN if p_ >= 60 else FAINT))
    # 6 s trace: target vs actual runner length
    gx0, gx1, gy0, gy1 = IX + 430, IX + IW - 24, IY + 40, IY + IH - 26
    text(c, "RUNNER LENGTH · LAST 6 s", gx0, IY + 28, font(BAHN, 13), MUTED)
    yv = lambda e: gy1 - (e - D.lo) / (D.hi - D.lo) * (gy1 - gy0)
    for mm in (D.lo, (D.lo + D.hi) / 2, D.hi):
        c.drawLine(gx0, yv(mm), gx1, yv(mm), paint(C("FFFFFF", 0.08), 1))
        text(c, f"{BASE + mm:.0f}", gx1, yv(mm) - 4, font(BAHN, 12), FAINT, "right")
    ts = np.linspace(tt - 6, tt, 180); ts = ts[ts >= t[0]]
    if len(ts) > 2:
        def poly(arr, col, w):
            p = skia.Path(); first = True
            for x in ts:
                X = gx0 + (x - (tt - 6)) / 6 * (gx1 - gx0); Y = yv(at(arr, x))
                (p.moveTo if first else p.lineTo)(X, Y); first = False
            c.drawPath(p, paint(col, w))
        poly(sim["cmd"], C("FFB547", 0.9), 2.0); poly(sim["act"], BLUE, 3.2)
    text(c, "target", gx0, gy1 + 20, font(SEG, 13), AMBER); text(c, "actual", gx0 + 56, gy1 + 20, font(SEG, 13), BLUE)

# ---------------- title + footer ----------------
def title(c, img):
    glass(c, img, 36, 36, 700, 92, 16)
    text(c, "NEW INTAKE", 60, 78, font(BAHN_B, 30), BLUE)
    text(c, "vs today's static intake", 254, 78, font(BAHN, 28), INK)
    text(c, f"{man['driver']} · {lap['raw']:.2f} s clean · fsae-sim  ·  direct 1D runs: helios engine-sim (finding 0039)", 60, 108, font(SEG, 16), MUTED)
def footer(c, img):
    s = f"lap average on throttle {LAP_GAIN * 100:+.1f}% torque (instant actuator {LAP_IDEAL * 100:+.1f}%)  ·  fsae-sim lap bound: autocross -0.13 s"
    f = font(SEG, 15); w = f.measureText(s) + 36
    glass(c, img, W - 36 - w, H - 36 - 36, w, 36, 12)
    text(c, s, W - 36 - w + 18, H - 36 - 12, f, MUTED)

def compose(frame_rgba, tt, phase):
    img = skia.Image.fromarray(frame_rgba, colorType=skia.kRGBA_8888_ColorType)
    surf = skia.Surface(W, H); c = surf.getCanvas()
    c.drawImage(img, 0, 0)
    title(c, img); section(c, img, tt, phase); instruments(c, img, tt); footer(c, img)
    return surf.makeImageSnapshot().toarray(colorType=skia.kRGBA_8888_ColorType)

def frame_at(k):
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    raw = subprocess.run([ff, "-loglevel", "error", "-ss", f"{k / FPS:.3f}", "-i", SRC, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 4).copy()

def main(out):
    ff = imageio_ffmpeg.get_ffmpeg_exe(); tmp = out + ".video.mp4"
    rd = subprocess.Popen([ff, "-loglevel", "error", "-i", SRC, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], stdout=subprocess.PIPE)
    wr = subprocess.Popen([ff, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                           "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-profile:v", "high", tmp], stdin=subprocess.PIPE)
    from nothrottle import unthrottle                                   # Windows EcoQoS (see 0039 runner notes)
    for pid in (os.getpid(), rd.pid, wr.pid): unthrottle(pid)
    n = W * H * 4; k = 0; tend = t[-1]
    while True:
        raw = rd.stdout.read(n)
        if len(raw) < n: break
        fr = np.frombuffer(raw, np.uint8).reshape(H, W, 4).copy()
        wr.stdin.write(compose(fr, min(T0 + k / FPS, tend), k / FPS).tobytes())
        if k % 600 == 0: print("frame", k, flush=True)
        k += 1
    wr.stdin.close(); wr.wait(); rd.wait()
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", tmp, "-i", SRC, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", out], check=True)
    os.remove(tmp); print("wrote", out, k, "frames", os.path.getsize(out) // 1024, "KB", "lap gain", LAP_GAIN, "ideal", LAP_IDEAL, flush=True)

if __name__ == "__main__":
    out = sys.argv[1]
    if len(sys.argv) > 2 and sys.argv[2] == "--still":
        tt = float(sys.argv[3]); k = int(round((tt - T0) * FPS))
        arr = compose(frame_at(k), tt, k / FPS)
        skia.Image.fromarray(arr, colorType=skia.kRGBA_8888_ColorType).save(out, skia.kPNG)
    else:
        main(out)
