"""
Extract clean, RPM-grid-aligned dyno CSVs for SDM25 and SDM26 from the
team's chassis-dyno files (chassis dyno → WHEEL power).

Source files (provided by user 2026-05-23):
  ~/Downloads/RunFile_11.csv   → SDM25 (DWRT/Dynojet, RPM × 1000)
  ~/Downloads/SDM (1).CSV      → SDM26 (raw RPM)

Both files use HP for power, lbft for torque. Output CSVs use kW + Nm
and match the legacy column schema:
  rpm, brake_power_kW, brake_torque_Nm, bsfc_g_per_kWh, egt_K, source, notes
"""
from __future__ import annotations
import csv
from pathlib import Path

HP_TO_KW = 0.7457
LBFT_TO_NM = 1.35582

ROOT = Path(__file__).resolve().parents[2].parent
DOWNLOADS = Path.home() / "Downloads"
OUT_DIR = Path(__file__).resolve().parent


def parse_runfile_11(path: Path):
    """SDM25 — Dynojet, RPM in thousands, HP, lbft."""
    rows = []
    with open(path) as f:
        for i, line in enumerate(f):
            if i == 0:
                continue
            parts = [p.strip() for p in line.strip().rstrip(",").split(",")]
            if len(parts) < 3:
                continue
            try:
                rpm_k = float(parts[0])
                hp = float(parts[1])
                lbft = float(parts[2])
            except ValueError:
                continue
            rows.append((rpm_k * 1000.0, hp * HP_TO_KW, lbft * LBFT_TO_NM))
    return rows


def parse_sdm_csv(path: Path):
    """SDM26 — Dynojet-format, raw RPM, HP, lbft. Two header lines."""
    rows = []
    with open(path) as f:
        for i, line in enumerate(f):
            if i < 2:  # skip both header lines
                continue
            parts = [p.strip() for p in line.strip().rstrip(",").split(",")]
            if len(parts) < 3:
                continue
            try:
                rpm = float(parts[0])
                hp = float(parts[1])
                lbft = float(parts[2])
            except ValueError:
                continue
            rows.append((rpm, hp * HP_TO_KW, lbft * LBFT_TO_NM))
    return rows


def interpolate_to_grid(dense_rows, rpm_grid):
    """Linear interp dense (rpm, kW, Nm) to the sparse rpm_grid."""
    dense_rows = sorted(dense_rows, key=lambda r: r[0])
    rpms = [r[0] for r in dense_rows]
    kws  = [r[1] for r in dense_rows]
    nms  = [r[2] for r in dense_rows]
    out = []
    for r in rpm_grid:
        if r < rpms[0] or r > rpms[-1]:
            continue  # off range
        # Find bracket
        for j in range(len(rpms) - 1):
            if rpms[j] <= r <= rpms[j + 1]:
                frac = (r - rpms[j]) / (rpms[j + 1] - rpms[j])
                kw = kws[j] + frac * (kws[j + 1] - kws[j])
                nm = nms[j] + frac * (nms[j + 1] - nms[j])
                out.append((r, kw, nm))
                break
    return out


def write_csv(out_path: Path, rows, source: str, notes_per_rpm=None):
    notes_per_rpm = notes_per_rpm or {}
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["rpm", "brake_power_kW", "brake_torque_Nm",
                    "bsfc_g_per_kWh", "egt_K", "source", "notes"])
        for rpm, kw, nm in rows:
            w.writerow([
                int(rpm),
                f"{kw:.3f}",
                f"{nm:.3f}",
                "",
                "",
                source,
                notes_per_rpm.get(int(rpm), ""),
            ])


def main():
    grid = [4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500,
            9000, 9500, 10000, 10500, 11000, 11500, 12000, 12500, 13000, 13500]

    sdm25_raw = parse_runfile_11(DOWNLOADS / "RunFile_11.csv")
    sdm25 = interpolate_to_grid(sdm25_raw, grid)
    print(f"SDM25: parsed {len(sdm25_raw)} dense rows; interpolated {len(sdm25)} grid rows")
    write_csv(
        OUT_DIR / "sdm25-team-dyno.csv",
        sdm25,
        "Team chassis dyno run RunFile_11 (Dynojet/DWRT)",
        notes_per_rpm={
            4000: "Below stable operating range",
            6000: "Dyno shows low-RPM dip; ECU/tune artifact",
        },
    )

    sdm26_raw = parse_sdm_csv(DOWNLOADS / "SDM (1).CSV")
    sdm26 = interpolate_to_grid(sdm26_raw, grid)
    print(f"SDM26: parsed {len(sdm26_raw)} dense rows; interpolated {len(sdm26)} grid rows")
    write_csv(
        OUT_DIR / "sdm26-team-dyno.csv",
        sdm26,
        "Team chassis dyno run SDM(1) (Dynojet)",
        notes_per_rpm={
            13500: "Last datapoint in file",
        },
    )

    print()
    print("Wrote:")
    print(f"  {OUT_DIR / 'sdm25-team-dyno.csv'}")
    print(f"  {OUT_DIR / 'sdm26-team-dyno.csv'}")


if __name__ == "__main__":
    main()
