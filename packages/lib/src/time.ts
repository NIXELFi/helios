export function usToS(us: number): number { return us / 1_000_000; }

export function formatLapTime(us: number): string {
  // Capture the sign and work on the magnitude — Math.floor/% on a negative
  // value produced garbage (e.g. negative seconds/millis components).
  const sign = us < 0 ? "-" : "";
  const ms = Math.round(Math.abs(us) / 1000);
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${sign}${min}:${String(sec).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

export function formatClock(us: number): string {
  const sign = us < 0 ? "-" : "";
  const ms = Math.round(Math.abs(us) / 1000);
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${sign}${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}
