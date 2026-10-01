"""Render the 0039 new-intake overlay video, then phone-sized 1080p and 720p cuts (<= ~25 MB)."""
import os, subprocess, sys, imageio_ffmpeg
H = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(H))
FF = imageio_ffmpeg.get_ffmpeg_exe(); full = os.path.join(H, "newintake_ax.mp4")
if not os.path.exists(full):
    subprocess.run([sys.executable, os.path.join(H, "render_newintake.py"), full], check=True)
dur = 60.0
for name, scale, br in [("newintake_ax_1080p.mp4", "1920:1080", "4200k"), ("newintake_ax_720p.mp4", "1280:720", "2600k")]:
    subprocess.run([FF, "-y", "-loglevel", "error", "-i", full, "-vf", f"scale={scale}:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-b:v", br,
                    "-maxrate", br, "-bufsize", "8M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", os.path.join(H, name)], check=True)
print("done", flush=True)
