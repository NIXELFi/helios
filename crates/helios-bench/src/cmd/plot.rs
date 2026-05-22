//! `helios-bench plot` — render SVG plots from an NDJSON result file.
//!
//! Three plots are produced under `--out-dir`:
//! - `power_curve.svg`: brake_power_kW vs RPM
//! - `pv_loop.svg`: requires per-cycle pressure/volume traces
//!   (Phase 0: CycleStats has no trace fields yet, so a placeholder
//!   SVG is emitted with an HTML comment explaining the gap)
//! - `bsfc_curve.svg`: bsfc_g_per_kWh vs RPM if available, else placeholder
//!
//! Uses the `svg` crate's tag builders to keep the markup simple and
//! deterministic. The viewBox is sized to the data extents; coordinate
//! flipping (y up vs SVG y-down) is handled in `points_to_svg_coords`.

use anyhow::{Context, Result};
use clap::Args as ClapArgs;
use serde_json::Value;
use std::path::{Path, PathBuf};
use svg::node::element::{Polyline, Rectangle, Text as SvgText};
use svg::Document;

#[derive(ClapArgs)]
pub struct Args {
    /// NDJSON result file
    pub results: PathBuf,
    /// Directory to write SVG files into (created if missing)
    #[arg(long)]
    pub out_dir: PathBuf,
}

const WIDTH: f64 = 800.0;
const HEIGHT: f64 = 480.0;
const MARGIN: f64 = 60.0;

pub fn execute(args: Args) -> Result<()> {
    let trials = load_trials(&args.results)?;
    std::fs::create_dir_all(&args.out_dir)
        .with_context(|| format!("create --out-dir {}", args.out_dir.display()))?;

    // power_curve.svg
    let power_points: Vec<(f64, f64)> = trials
        .iter()
        .filter_map(|t| {
            let rpm = t.get("rpm").and_then(Value::as_f64)?;
            let p = t.get("brake_power_kW").and_then(Value::as_f64)?;
            Some((rpm, p))
        })
        .collect();
    let power_svg = if power_points.is_empty() {
        placeholder_svg(
            "Power Curve",
            "no brake_power_kW data; placeholder",
            "needs trace data; placeholder",
        )
    } else {
        line_plot(
            "Power Curve",
            "RPM",
            "brake_power_kW",
            &power_points,
        )
    };
    write_svg(&args.out_dir.join("power_curve.svg"), &power_svg)?;

    // pv_loop.svg — always a placeholder in Phase 0 (no trace fields).
    let pv_svg = placeholder_svg(
        "P-V Loop",
        "needs per-cycle pressure/volume traces (Phase 0: CycleStats has no trace data; placeholder)",
        "needs trace data; placeholder",
    );
    write_svg(&args.out_dir.join("pv_loop.svg"), &pv_svg)?;

    // bsfc_curve.svg
    let bsfc_points: Vec<(f64, f64)> = trials
        .iter()
        .filter_map(|t| {
            let rpm = t.get("rpm").and_then(Value::as_f64)?;
            let b = t.get("bsfc_g_per_kWh").and_then(Value::as_f64)?;
            Some((rpm, b))
        })
        .collect();
    let bsfc_svg = if bsfc_points.is_empty() {
        placeholder_svg(
            "BSFC Curve",
            "bsfc_g_per_kWh not present in any trial; placeholder",
            "bsfc_g_per_kWh not present in any trial; placeholder",
        )
    } else {
        line_plot(
            "BSFC Curve",
            "RPM",
            "bsfc_g_per_kWh",
            &bsfc_points,
        )
    };
    write_svg(&args.out_dir.join("bsfc_curve.svg"), &bsfc_svg)?;

    Ok(())
}

fn load_trials(path: &Path) -> Result<Vec<Value>> {
    let body = std::fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    let mut out = Vec::new();
    for line in body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .with_context(|| format!("parse line: {line}"))?;
        if v.get("kind").and_then(Value::as_str) == Some("trial") {
            out.push(v);
        }
    }
    Ok(out)
}

fn write_svg(path: &Path, body: &str) -> Result<()> {
    std::fs::write(path, body).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

fn line_plot(title: &str, x_label: &str, y_label: &str, points: &[(f64, f64)]) -> String {
    let (x_min, x_max, y_min, y_max) = extents(points);
    let coords = points_to_svg_coords(points, x_min, x_max, y_min, y_max);
    let polyline = Polyline::new()
        .set("fill", "none")
        .set("stroke", "#1f77b4")
        .set("stroke-width", 2)
        .set("points", coords);

    let bg = Rectangle::new()
        .set("width", WIDTH)
        .set("height", HEIGHT)
        .set("fill", "#ffffff");

    let title_text = SvgText::new(title)
        .set("x", WIDTH / 2.0)
        .set("y", MARGIN / 2.0)
        .set("text-anchor", "middle")
        .set("font-family", "sans-serif")
        .set("font-size", 18);

    let x_label_text = SvgText::new(format!("{x_label}  [{:.0}, {:.0}]", x_min, x_max))
        .set("x", WIDTH / 2.0)
        .set("y", HEIGHT - 16.0)
        .set("text-anchor", "middle")
        .set("font-family", "sans-serif")
        .set("font-size", 12);

    let y_label_text = SvgText::new(format!("{y_label}  [{:.3}, {:.3}]", y_min, y_max))
        .set("x", 16.0)
        .set("y", HEIGHT / 2.0)
        .set("text-anchor", "start")
        .set("font-family", "sans-serif")
        .set("font-size", 12)
        .set(
            "transform",
            format!("rotate(-90, 16, {})", HEIGHT / 2.0),
        );

    let doc = Document::new()
        .set("viewBox", (0, 0, WIDTH as i64, HEIGHT as i64))
        .set("xmlns", "http://www.w3.org/2000/svg")
        .add(bg)
        .add(polyline)
        .add(title_text)
        .add(x_label_text)
        .add(y_label_text);

    doc.to_string()
}

fn placeholder_svg(title: &str, comment: &str, body_text: &str) -> String {
    let bg = Rectangle::new()
        .set("width", WIDTH)
        .set("height", HEIGHT)
        .set("fill", "#f5f5f5")
        .set("stroke", "#aaa");
    let title_node = SvgText::new(title)
        .set("x", WIDTH / 2.0)
        .set("y", HEIGHT / 2.0 - 12.0)
        .set("text-anchor", "middle")
        .set("font-family", "sans-serif")
        .set("font-size", 20);
    let body_node = SvgText::new(body_text)
        .set("x", WIDTH / 2.0)
        .set("y", HEIGHT / 2.0 + 16.0)
        .set("text-anchor", "middle")
        .set("font-family", "sans-serif")
        .set("font-size", 14)
        .set("fill", "#666");

    let doc = Document::new()
        .set("viewBox", (0, 0, WIDTH as i64, HEIGHT as i64))
        .set("xmlns", "http://www.w3.org/2000/svg")
        .add(bg)
        .add(title_node)
        .add(body_node);

    // The `svg` crate doesn't expose a simple "prepend an XML comment"
    // API, so we inject one manually after the opening `<svg ...>` tag.
    let mut s = doc.to_string();
    let comment_tag = format!("\n<!-- {} -->\n", comment);
    if let Some(idx) = s.find('>') {
        s.insert_str(idx + 1, &comment_tag);
    }
    s
}

fn extents(points: &[(f64, f64)]) -> (f64, f64, f64, f64) {
    let mut x_min = f64::INFINITY;
    let mut x_max = f64::NEG_INFINITY;
    let mut y_min = f64::INFINITY;
    let mut y_max = f64::NEG_INFINITY;
    for &(x, y) in points {
        if x.is_finite() {
            x_min = x_min.min(x);
            x_max = x_max.max(x);
        }
        if y.is_finite() {
            y_min = y_min.min(y);
            y_max = y_max.max(y);
        }
    }
    if (x_max - x_min).abs() < f64::EPSILON {
        x_max = x_min + 1.0;
    }
    if (y_max - y_min).abs() < f64::EPSILON {
        y_max = y_min + 1.0;
    }
    (x_min, x_max, y_min, y_max)
}

/// Map data points to the SVG drawable area, flipping y so larger
/// values render upward. Returns a `"x,y x,y x,y"` polyline-points
/// string ready to drop into a `<polyline points="…"/>`.
fn points_to_svg_coords(
    points: &[(f64, f64)],
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
) -> String {
    let w = WIDTH - 2.0 * MARGIN;
    let h = HEIGHT - 2.0 * MARGIN;
    let x_range = x_max - x_min;
    let y_range = y_max - y_min;
    let mut sorted = points.to_vec();
    // Sort by x so the polyline doesn't zig-zag if trials are out of order.
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    sorted
        .iter()
        .map(|&(x, y)| {
            let sx = MARGIN + (x - x_min) / x_range * w;
            let sy = HEIGHT - MARGIN - (y - y_min) / y_range * h;
            format!("{:.2},{:.2}", sx, sy)
        })
        .collect::<Vec<_>>()
        .join(" ")
}
