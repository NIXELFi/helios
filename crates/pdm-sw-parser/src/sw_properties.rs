//! Extract SolidWorks custom properties from a modern (post-CFB) `.sldprt` /
//! `.sldasm` / `.slddrw` file.
//!
//! Modern SolidWorks files are an UnQLite container whose records are raw-
//! DEFLATE compressed. Among those records are standard Office Open XML
//! property parts (`docProps/custom.xml`, `core.xml`, `app.xml`) plus a
//! SolidWorks `config-properties` part — the same `<property name="…">` shape
//! used by .docx. We scan the file for deflate streams, decompress them, and
//! pull the `name → value` pairs out of the property XML.
//!
//! Best-effort and forgiving: a file in any other format (or a parse miss)
//! yields an empty list rather than erroring.

extern crate alloc;
use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;
use std::io::Read;

/// A custom property name/value pair read from a SolidWorks file.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SwProperty {
    pub name: String,
    pub value: String,
}

/// Top-level entry: extract data-card properties from the bytes of a SolidWorks
/// file. Returns the computed physical properties (Mass / Volume / Surface Area)
/// first — the most useful at-a-glance facts — followed by the modeler's custom
/// properties (de-duplicated by name).
pub fn parse_properties(bytes: &[u8]) -> Vec<SwProperty> {
    // For large files we first scan only the two edges (fast path), because the
    // bulk of the middle is geometry. If the fast path finds no properties — which
    // can happen for unusual assemblies where SolidWorks placed the property block
    // outside the expected front/back windows — we fall back to a full scan so
    // nothing is silently dropped.
    parse_properties_windowed(
        bytes,
        24 * 1024 * 1024, // SCAN_ALL_MAX
        8 * 1024 * 1024,  // HEAD_WINDOW
        12 * 1024 * 1024, // TAIL_WINDOW
    )
}

/// Inner implementation that accepts window sizes so the windowing logic can be
/// tested at small scale without allocating multi-MB fixtures.
///
/// For files ≤ `scan_all_max` bytes the entire file is scanned. For larger
/// files we first scan the HEAD (`[0, head_window)`) and TAIL
/// (`[n - tail_window, n)`); if no properties are found in those two windows we
/// fall back to a full scan. The fallback handles the rare case where SolidWorks
/// placed a property block in the middle of the container (e.g. an assembly that
/// was re-saved after property editing), preventing silent data loss at the cost
/// of a slower parse for that unusual file.
fn parse_properties_windowed(
    bytes: &[u8],
    scan_all_max: usize,
    head_window: usize,
    tail_window: usize,
) -> Vec<SwProperty> {
    let mut physical: Vec<SwProperty> = Vec::new();
    let mut custom: Vec<SwProperty> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut have_physical = false;
    let n = bytes.len();

    // Adversarial-input guard: a maliciously crafted file can present a deflate
    // stream at (nearly) every byte offset, each of which expands hugely (a
    // "zip bomb"). `try_inflate` decompresses each candidate fully just to learn
    // its input length, so without a global ceiling the worst case is
    // O(file_len) attempts × tens of MB each. We cap BOTH the total number of
    // inflate attempts and the total number of decompressed bytes for the whole
    // parse; once either is exhausted the scan stops early and returns whatever
    // legitimate properties it already found.
    let mut budget = DecodeBudget::new();

    if n <= scan_all_max {
        scan_region(bytes, 0, n, &mut physical, &mut custom, &mut seen, &mut have_physical, &mut budget);
    } else {
        // Fast path: scan the two edges where property blocks almost always live.
        scan_region(bytes, 0, head_window, &mut physical, &mut custom, &mut seen, &mut have_physical, &mut budget);
        scan_region(bytes, n - tail_window, n, &mut physical, &mut custom, &mut seen, &mut have_physical, &mut budget);

        // Fallback: if nothing was found in either edge window, the property
        // block must be in the skipped middle region. Scan the full file so the
        // caller never silently gets an empty result from a large but valid file.
        if physical.is_empty() && custom.is_empty() {
            scan_region(bytes, head_window, n - tail_window, &mut physical, &mut custom, &mut seen, &mut have_physical, &mut budget);
        }
    }
    physical.into_iter().chain(custom).collect()
}

/// Whole-parse work budget for the deflate scanner. Bounds both how many
/// candidate streams we attempt to inflate and the total decompressed volume,
/// so a crafted file cannot turn the byte-by-byte scan into a decompression
/// bomb. Generously sized so any real SolidWorks file finishes well within it.
struct DecodeBudget {
    attempts_remaining: usize,
    bytes_remaining: usize,
}

impl DecodeBudget {
    /// ~256k inflate attempts and ~512 MB of total decompressed output across the
    /// entire parse — orders of magnitude above what any genuine file needs,
    /// while still bounding worst-case adversarial work.
    const MAX_ATTEMPTS: usize = 256 * 1024;
    const MAX_TOTAL_DECODED_BYTES: usize = 512 * 1024 * 1024;

    fn new() -> Self {
        Self {
            attempts_remaining: Self::MAX_ATTEMPTS,
            bytes_remaining: Self::MAX_TOTAL_DECODED_BYTES,
        }
    }

    fn exhausted(&self) -> bool {
        self.attempts_remaining == 0 || self.bytes_remaining == 0
    }
}

/// Scan deflate streams whose start offset falls in `[start, end)`, extracting
/// the mass vector + custom properties. A stream may legitimately extend past
/// `end`; we just don't *start* new attempts there.
#[allow(clippy::too_many_arguments)]
fn scan_region(
    bytes: &[u8],
    start: usize,
    end: usize,
    physical: &mut Vec<SwProperty>,
    custom: &mut Vec<SwProperty>,
    seen: &mut BTreeSet<String>,
    have_physical: &mut bool,
    budget: &mut DecodeBudget,
) {
    let mut i = start;
    while i + 2 < end {
        if budget.exhausted() {
            // Adversarial work cap hit: stop scanning rather than risk a
            // decompression-bomb hang. Properties found so far are returned.
            break;
        }
        match try_inflate(&bytes[i..], budget) {
            Some((head, consumed)) => {
                // Cheap byte-level marker check on the (capped) head; only the
                // small property streams pay for UTF-8 conversion + parsing, so
                // we never stringify or rescan multi-MB geometry streams.
                let want_mass = !*have_physical && contains_sub(&head, b"SW-MassProp-Config");
                let want_props =
                    contains_sub(&head, b"<property name=") || contains_sub(&head, b"Material=");
                if want_mass || want_props {
                    let text = String::from_utf8_lossy(&head);
                    // Physical properties: parse the first SW-MassProp-Config
                    // vector we see (single-config parts have one; for multi-
                    // config we take the first — best-effort).
                    if want_mass {
                        if let Some(rows) = mass_rows(&text) {
                            *physical = rows;
                            *have_physical = true;
                        }
                    }
                    if want_props {
                        extract_props(&text, custom, seen);
                    }
                }
                i += consumed.max(1);
            }
            None => i += 1,
        }
    }
}

/// Parse the `SW-MassProp-Config-*` vector and build the user-facing physical
/// rows. The vector is comma-separated SI doubles:
/// `[CoM_x, CoM_y, CoM_z, Volume(m³), Area(m²), Mass(kg), …moments…]`.
/// Mass is shown only when > 0 (a 0 means no material is assigned — common for
/// reference / surface bodies); Volume and Surface Area are always shown when
/// present.
fn mass_rows(text: &str) -> Option<Vec<SwProperty>> {
    let key = text.find("SW-MassProp-Config")?;
    let rest = &text[key..];
    let vt = rest.find("<vt:")?;
    let after = &rest[vt + 4..];
    let gt = after.find('>')?;
    let val_start = vt + 4 + gt + 1;
    let close = rest[val_start..].find("</vt:")?;
    let raw = &rest[val_start..val_start + close];

    let nums: Vec<f64> = raw
        .split(',')
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .collect();
    if nums.len() < 6 {
        return None;
    }
    let (com, volume_m3, area_m2, mass_kg) = ((nums[0], nums[1], nums[2]), nums[3], nums[4], nums[5]);

    // The vector is parsed positionally, so a misaligned / malformed stream can
    // yield garbage (NaN/Inf or negative volume/area, which are physically
    // impossible). Reject those rather than render nonsense on the card.
    let all_finite = com.0.is_finite()
        && com.1.is_finite()
        && com.2.is_finite()
        && volume_m3.is_finite()
        && area_m2.is_finite()
        && mass_kg.is_finite();
    if !all_finite || volume_m3 < 0.0 || area_m2 < 0.0 {
        return None;
    }

    let mut rows = Vec::new();
    if mass_kg > 0.0 {
        rows.push(SwProperty { name: "Mass".into(), value: fmt_mass(mass_kg) });
    }
    if volume_m3 > 0.0 {
        rows.push(SwProperty { name: "Volume".into(), value: fmt_volume(volume_m3) });
    }
    if area_m2 > 0.0 {
        rows.push(SwProperty { name: "Surface Area".into(), value: fmt_area(area_m2) });
    }
    // Center of mass is meaningful whenever the vector exists — it's the
    // geometric centroid, present even for a no-material (zero-mass) body.
    rows.push(SwProperty { name: "Center of Mass".into(), value: fmt_com(com.0, com.1, com.2) });
    Some(rows)
}

/// Mass: kg at/above 1 kg (3 decimals, trailing zeros trimmed), else grams.
fn fmt_mass(kg: f64) -> String {
    if kg >= 1.0 {
        alloc::format!("{} kg", trim_decimals(kg, 3))
    } else {
        alloc::format!("{} g", grouped(kg * 1_000.0, 1))
    }
}

/// Volume: cm³, dropping to mm³ for sub-10-cm³ parts.
fn fmt_volume(m3: f64) -> String {
    let cm3 = m3 * 1.0e6;
    if cm3 < 10.0 {
        alloc::format!("{} mm³", grouped(m3 * 1.0e9, 1))
    } else {
        alloc::format!("{} cm³", grouped(cm3, 1))
    }
}

/// Surface area: cm², dropping to mm² for sub-10-cm² parts.
fn fmt_area(m2: f64) -> String {
    let cm2 = m2 * 1.0e4;
    if cm2 < 10.0 {
        alloc::format!("{} mm²", grouped(m2 * 1.0e6, 1))
    } else {
        alloc::format!("{} cm²", grouped(cm2, 1))
    }
}

/// Center of mass: (x, y, z) offset of the centroid from the model origin, in
/// millimetres (the natural unit for part-scale coordinates).
fn fmt_com(x: f64, y: f64, z: f64) -> String {
    alloc::format!(
        "({}, {}, {}) mm",
        grouped(x * 1000.0, 1),
        grouped(y * 1000.0, 1),
        grouped(z * 1000.0, 1)
    )
}

/// Format with a fixed number of decimals and thousands separators, e.g.
/// `43676.0 → "43,676.0"`.
fn grouped(x: f64, decimals: usize) -> String {
    let s = alloc::format!("{:.*}", decimals, x);
    let (int_part, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s.as_str(), None),
    };
    let neg = int_part.starts_with('-');
    let digits = int_part.trim_start_matches('-');
    let len = digits.len();
    let mut grouped = String::new();
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (len - idx) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(&grouped);
    if let Some(f) = frac {
        out.push('.');
        out.push_str(f);
    }
    out
}

/// Format a value with up to `decimals` decimals, trimming trailing zeros (and a
/// trailing dot), with thousands separators on the integer part.
fn trim_decimals(x: f64, decimals: usize) -> String {
    let s = grouped(x, decimals);
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

/// Largest decompressed head we keep per stream. Property parts (custom props +
/// the mass vector) are a few KB; this is far above any real one, while keeping
/// us from buffering / stringifying multi-MB geometry sections.
const INSPECT_CAP: usize = 256 * 1024;

/// Try to raw-inflate a deflate stream starting at `input[0]`. Returns up to the
/// first `INSPECT_CAP` decompressed bytes (the head — enough to contain any
/// property part) plus the number of *input* bytes the whole stream consumed, or
/// None if this offset isn't the start of a usable stream. We keep decompressing
/// past the cap (discarding output) only to learn the full input length, so the
/// caller advances cleanly past the stream instead of crawling byte-by-byte —
/// but bail on absurdly large streams to bound worst-case work.
fn try_inflate(input: &[u8], budget: &mut DecodeBudget) -> Option<(Vec<u8>, usize)> {
    // Each call is one inflate attempt against the whole-parse budget.
    if budget.attempts_remaining == 0 {
        return None;
    }
    budget.attempts_remaining -= 1;

    let mut dec = flate2::read::DeflateDecoder::new(input);
    let mut head: Vec<u8> = Vec::new();
    let mut buf = [0u8; 65536];
    let mut total_out = 0usize;
    loop {
        match dec.read(&mut buf) {
            Ok(0) => break,
            Ok(k) => {
                total_out += k;
                // Charge decompressed output against the global byte budget so a
                // single highly-compressible stream can't expand without bound.
                budget.bytes_remaining = budget.bytes_remaining.saturating_sub(k);
                if head.len() < INSPECT_CAP {
                    let take = (INSPECT_CAP - head.len()).min(k);
                    head.extend_from_slice(&buf[..take]);
                }
                if total_out > 64 * 1024 * 1024 || budget.bytes_remaining == 0 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let consumed = dec.total_in() as usize;
    if total_out < 32 || consumed == 0 {
        return None;
    }
    Some((head, consumed))
}

/// Byte-substring search (no UTF-8 conversion). Used to cheaply gate which
/// streams are worth fully parsing.
fn contains_sub(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return false;
    }
    let first = needle[0];
    let last = hay.len() - needle.len();
    let mut i = 0;
    while i <= last {
        if hay[i] == first && &hay[i..i + needle.len()] == needle {
            return true;
        }
        i += 1;
    }
    false
}

/// Extract the user-facing data-card properties from a decompressed XML string:
/// the `<property name="NAME">…</property>` pairs inside a
/// `<propertySection name="UserDefinedProperties">` (the File→Properties→Custom
/// tab) plus any `Material="…"` config attribute. We deliberately scope to
/// UserDefinedProperties so SolidWorks' internal system properties (the
/// `DocumentSummaryInformation` section, `SW_Units*`, `SW-MassProp*`, etc.) are
/// excluded. First value for a given name wins.
fn extract_props(text: &str, out: &mut Vec<SwProperty>, seen: &mut BTreeSet<String>) {
    const SECTION: &str = "name=\"UserDefinedProperties\"";
    const SECTION_END: &str = "</propertySection>";
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(SECTION) {
        let sec_start = from + rel;
        let sec_end = text[sec_start..]
            .find(SECTION_END)
            .map(|e| sec_start + e)
            .unwrap_or(text.len());
        extract_props_in(&text[sec_start..sec_end], out, seen);
        from = sec_end;
    }

    // Config material attribute: <Configuration … Material="7075-T6 (SN)"/>.
    // Useful when the modeler set a material but no explicit custom property.
    const MAT: &str = "Material=\"";
    if let Some(rel) = text.find(MAT) {
        let s = rel + MAT.len();
        if let Some(q) = text[s..].find('"') {
            let v = &text[s..s + q];
            if !v.is_empty() && !v.contains("not specified") {
                push(out, seen, "Material", v);
            }
        }
    }
}

/// Pull `<property name="NAME" …><vt:TYPE>VALUE</vt:TYPE>` pairs from a single
/// UserDefinedProperties section.
fn extract_props_in(text: &str, out: &mut Vec<SwProperty>, seen: &mut BTreeSet<String>) {
    const OPEN: &str = "<property name=\"";
    let mut search = 0usize;
    while let Some(rel) = text[search..].find(OPEN) {
        let name_start = search + rel + OPEN.len();
        let Some(qrel) = text[name_start..].find('"') else { break };
        let name = &text[name_start..name_start + qrel];
        search = name_start + qrel;
        if name.is_empty() {
            // Skip pid placeholders (<property name="" …>).
            continue;
        }
        // A user-entered field keeps its name; a few SolidWorks system fields are
        // relabeled to friendly data-card fields (e.g. "SW-Last Saved By" →
        // "Last Saved By"); all other SW-/SW_ internals are dropped.
        let label: Option<&str> = if is_system_prop(name) {
            doc_prop_label(name)
        } else {
            Some(name)
        };
        let Some(label) = label else { continue };
        // Value: the first <vt:TYPE>…</vt:TYPE> after the name attribute, but
        // bounded to THIS property element. A property with no <vt:> value
        // (e.g. an empty `<property name="X"/>`) must not borrow the value of a
        // later sibling: without the bound, `rest.find("<vt:")` would scan to
        // the end of the section and mis-attribute another property's value to
        // this name. We cap the search slice at the element's closing
        // `</property>` (or the start of the next `<property`, whichever comes
        // first) so a value-less property yields nothing instead of stealing.
        let rest_full = &text[search..];
        let elem_end = {
            let close = rest_full.find("</property>");
            let next = rest_full.find("<property name=\"");
            match (close, next) {
                (Some(c), Some(n)) => c.min(n),
                (Some(c), None) => c,
                (None, Some(n)) => n,
                (None, None) => rest_full.len(),
            }
        };
        let rest = &rest_full[..elem_end];
        if let Some(vt) = rest.find("<vt:") {
            let after_tag = &rest[vt + 4..];
            if let (Some(gt), ()) = (after_tag.find('>'), ()) {
                let val_start = vt + 4 + gt + 1;
                if let Some(close) = rest[val_start..].find("</vt:") {
                    let value = rest[val_start..val_start + close].trim();
                    if value.is_empty() {
                        continue;
                    }
                    // A "Default" configuration is noise — nearly every part has
                    // one; only a meaningful named config is worth a card row.
                    if label == "Configuration" && unescape_xml(value) == "Default" {
                        continue;
                    }
                    push(out, seen, label, value);
                }
            }
        }
    }
}

/// A handful of SolidWorks system properties carry data worth showing on the
/// card. Map them to friendly labels; everything else `is_system_prop` filters
/// stays hidden.
fn doc_prop_label(name: &str) -> Option<&'static str> {
    match name {
        "SW-Last Saved By" => Some("Last Saved By"),
        "SW-Configuration Name" => Some("Configuration"),
        _ => None,
    }
}

/// SolidWorks auto-generates a large set of system/linked properties
/// (`SW-File Name`, `SW-Folder Name`, `SW-MassProp-*`, `SW_Units*`, …) and
/// stores them alongside user properties in UserDefinedProperties. They all
/// carry the `SW-` / `SW_` prefix; a couple of other internals are named
/// explicitly. Exclude them so the data card shows only modeler-entered fields.
fn is_system_prop(name: &str) -> bool {
    name.starts_with("SW-")
        || name.starts_with("SW_")
        || name == "Component Type"
        || name == "IsCPReArchEnabled"
        // Add-in / viewer artifacts that aren't user-entered data-card fields.
        || name == "V_WorldOrientation"
        || name == "Assembly type"
}

fn push(out: &mut Vec<SwProperty>, seen: &mut BTreeSet<String>, name: &str, value: &str) {
    if seen.insert(name.to_string()) {
        out.push(SwProperty { name: name.to_string(), value: unescape_xml(value) });
    }
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
        .replace("&apos;", "'").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::DeflateEncoder, Compression};
    use std::io::Write;

    fn deflate(data: &[u8]) -> Vec<u8> {
        let mut e = DeflateEncoder::new(Vec::new(), Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn extracts_custom_properties_from_a_deflate_section() {
        let xml = r#"<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="" pid="1"><vt:i2>65001</vt:i2></property><property name="PartNo" pid="2"><vt:lpstr>91268A260</vt:lpstr></property><property name="Description" pid="3"><vt:lpstr>Hex Head Screw</vt:lpstr></property><property name="Material" pid="4"><vt:lpstr>Steel</vt:lpstr></property></propertySection></Properties>"#;
        // Embed the deflate stream inside junk bytes (like the real container).
        let mut file = vec![0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x04];
        file.extend_from_slice(&deflate(xml.as_bytes()));
        file.extend_from_slice(&[0xff, 0xff, 0x12, 0x34]);

        let props = parse_properties(&file);
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        assert_eq!(get("PartNo"), Some("91268A260"));
        assert_eq!(get("Description"), Some("Hex Head Screw"));
        assert_eq!(get("Material"), Some("Steel"));
        // The empty-name pid placeholder must be skipped.
        assert!(props.iter().all(|p| !p.name.is_empty()));
    }

    /// A `<property>` element that has NO `<vt:>` value of its own must not
    /// borrow the value of a later sibling property. Before the per-element
    /// bound, the unbounded `find("<vt:")` would scan past this element's
    /// `</property>` and mis-attribute the next property's value to this name.
    #[test]
    fn valueless_property_does_not_steal_next_value() {
        let xml = r#"<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="Empty" pid="2"></property><property name="PartNo" pid="3"><vt:lpstr>ABC-123</vt:lpstr></property></propertySection></Properties>"#;
        let props = parse_properties(&deflate(xml.as_bytes()));
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        // The value-less "Empty" property must NOT have stolen PartNo's value.
        assert_eq!(get("Empty"), None, "value-less property must not borrow a sibling value: {props:?}");
        // PartNo must still be read correctly.
        assert_eq!(get("PartNo"), Some("ABC-123"));
    }

    /// A self-closed value-less property likewise must not reach forward into a
    /// later element for its value.
    #[test]
    fn self_closed_property_does_not_steal_next_value() {
        let xml = r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="Flag"/><property name="Description" pid="3"><vt:lpstr>Real Desc</vt:lpstr></property></propertySection></Properties>"#;
        let props = parse_properties(&deflate(xml.as_bytes()));
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        assert_eq!(get("Flag"), None);
        assert_eq!(get("Description"), Some("Real Desc"));
    }

    /// The whole-parse decode budget must bound worst-case work: once the
    /// inflate-attempt budget is exhausted `try_inflate` returns None without
    /// decompressing, and `exhausted()` halts the scan. We exercise the budget
    /// plumbing directly rather than constructing a multi-GB bomb fixture.
    #[test]
    fn decode_budget_caps_inflate_attempts() {
        let mut budget = DecodeBudget::new();
        budget.attempts_remaining = 0;
        assert!(budget.exhausted(), "zero attempts left must read as exhausted");
        // A real deflate stream is ignored once the attempt budget is spent.
        let stream = deflate(b"hello world hello world");
        assert!(
            try_inflate(&stream, &mut budget).is_none(),
            "try_inflate must refuse to decode once the attempt budget is spent"
        );
    }

    /// The byte budget halts the scan: with a tiny remaining byte budget, the
    /// scanner stops early instead of decompressing without bound.
    #[test]
    fn decode_budget_caps_total_bytes() {
        let mut budget = DecodeBudget::new();
        budget.bytes_remaining = 0;
        assert!(budget.exhausted(), "zero bytes left must read as exhausted");
    }

    #[test]
    fn extracts_config_material_attribute_and_unescapes() {
        let xml = r#"<Keywords id="1" Name="part"><Configuration id="0" Name="Default" Material="7075-T6 &lt;SN&gt;"/></Keywords>"#;
        let mut file = Vec::new();
        file.extend_from_slice(&deflate(xml.as_bytes()));
        let props = parse_properties(&file);
        assert_eq!(props.iter().find(|p| p.name == "Material").map(|p| p.value.as_str()), Some("7075-T6 <SN>"));
    }

    #[test]
    fn filters_out_solidworks_system_properties() {
        let xml = r#"<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-File Name" pid="2"><vt:lpstr>part</vt:lpstr></property><property name="SW_UnitSystem" pid="3"><vt:lpstr>3</vt:lpstr></property><property name="Component Type" pid="4"><vt:lpstr>0</vt:lpstr></property><property name="PartNo" pid="5"><vt:lpstr>ABC-123</vt:lpstr></property></propertySection></Properties>"#;
        let props = parse_properties(&deflate(xml.as_bytes()));
        let names: Vec<&str> = props.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["PartNo"]); // only the user field survives
    }

    #[test]
    fn non_solidworks_bytes_yield_no_properties() {
        let props = parse_properties(b"\xd0\xcf\x11\xe0 just some random non-deflate bytes here, no properties at all");
        assert!(props.is_empty());
    }

    // --- Physical (mass) properties from the SW-MassProp-Config vector --------
    // The vector is `[CoM_x, CoM_y, CoM_z, Volume(m³), Area(m²), Mass(kg), …]`
    // in SI base units (validated against the real CBR600RR engine — Mass[5] =
    // 60.0 kg — and the steel chassis — Volume[3]×7850 = Mass[5] = 27.569 kg).

    #[test]
    fn extracts_physical_mass_properties_from_si_vector() {
        // Real "SDM26 Chassis FINAL" Config-0 vector.
        let xml = r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-MassProp-Config-0" pid="9"><vt:lpstr>-0.4902829144421719, -0.0012712297887835, 0.3421738590032732, 0.0035119830630731, 4.3675970584841899, 27.5690670451234610, 2.96, 12.49, 12.08, 0.02, 0.0, 0.0, 0.0, 0.0</vt:lpstr></property></propertySection></Properties>"#;
        let props = parse_properties(&deflate(xml.as_bytes()));
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        assert_eq!(get("Mass"), Some("27.569 kg"));
        assert_eq!(get("Volume"), Some("3,512.0 cm³"));
        assert_eq!(get("Surface Area"), Some("43,676.0 cm²"));
        // Physical rows lead the card.
        assert_eq!(props[0].name, "Mass");
    }

    #[test]
    fn includes_center_of_mass_in_mm() {
        // Chassis vector: CG = (-0.4902829, -0.0012712, 0.3421739) m.
        let xml = r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-MassProp-Config-0"><vt:lpstr>-0.4902829144421719, -0.0012712297887835, 0.3421738590032732, 0.0035119830630731, 4.3675970584841899, 27.5690670451234610, 2.96, 12.49, 12.08, 0.02, 0.0, 0.0, 0.0, 0.0</vt:lpstr></property></propertySection></Properties>"#;
        let props = parse_properties(&deflate(xml.as_bytes()));
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        assert_eq!(get("Center of Mass"), Some("(-490.3, -1.3, 342.2) mm"));
    }

    #[test]
    fn small_part_uses_grams_and_mm3() {
        let v = "0.019, 0.0, 0.0, 0.0000006, 0.0003418, 0.006137, 0,0,0,0,0,0,0,0";
        let xml = format!(r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-MassProp-Config-0"><vt:lpstr>{v}</vt:lpstr></property></propertySection></Properties>"#);
        let props = parse_properties(&deflate(xml.as_bytes()));
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        assert_eq!(get("Mass"), Some("6.1 g"));
        assert_eq!(get("Volume"), Some("600.0 mm³"));
        assert_eq!(get("Surface Area"), Some("341.8 mm²"));
    }

    #[test]
    fn no_mass_row_when_no_material_but_volume_area_remain() {
        // Surface/template body: Mass = 0 (no material), but volume + area exist.
        let v = "0.31, 0.0, 0.0, 0.0609906320493882, 1.3384751178002108, 0.0, 0,0,0,0,0,0,0,0";
        let xml = format!(r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-MassProp-Config-0"><vt:lpstr>{v}</vt:lpstr></property></propertySection></Properties>"#);
        let props = parse_properties(&deflate(xml.as_bytes()));
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        assert!(get("Mass").is_none());
        assert_eq!(get("Volume"), Some("60,990.6 cm³"));
        assert_eq!(get("Surface Area"), Some("13,384.8 cm²"));
    }

    #[test]
    fn surfaces_curated_document_properties_relabeled() {
        let xml = r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-Last Saved By" pid="2"><vt:lpstr>danie</vt:lpstr></property><property name="SW-Configuration Name" pid="3"><vt:lpstr>Race Setup</vt:lpstr></property><property name="SW-Author" pid="4"><vt:lpstr>bob</vt:lpstr></property><property name="PartNo" pid="5"><vt:lpstr>X1</vt:lpstr></property></propertySection></Properties>"#;
        let props = parse_properties(&deflate(xml.as_bytes()));
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        assert_eq!(get("Last Saved By"), Some("danie"));
        assert_eq!(get("Configuration"), Some("Race Setup"));
        assert_eq!(get("PartNo"), Some("X1"));
        // SW-Author isn't on the curated whitelist → still hidden.
        assert!(get("Author").is_none());
        assert!(get("SW-Author").is_none());
    }

    #[test]
    fn hides_default_configuration_as_noise() {
        let xml = r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-Configuration Name" pid="3"><vt:lpstr>Default</vt:lpstr></property><property name="PartNo" pid="5"><vt:lpstr>X1</vt:lpstr></property></propertySection></Properties>"#;
        let props = parse_properties(&deflate(xml.as_bytes()));
        assert!(props.iter().all(|p| p.name != "Configuration"));
        assert!(props.iter().any(|p| p.name == "PartNo"));
    }

    #[test]
    fn rejects_mass_vector_with_negative_volume_or_area() {
        // A misaligned/garbage vector can parse positionally into impossible
        // values (negative volume/area); we must emit no physical rows.
        let v = "0.0, 0.0, 0.0, -1.0, -2.0, 5.0, 0,0,0,0,0,0,0,0";
        let xml = format!(r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-MassProp-Config-0"><vt:lpstr>{v}</vt:lpstr></property></propertySection></Properties>"#);
        let props = parse_properties(&deflate(xml.as_bytes()));
        assert!(props.iter().all(|p| p.name != "Mass"));
        assert!(props.iter().all(|p| p.name != "Volume"));
        assert!(props.iter().all(|p| p.name != "Surface Area"));
        assert!(props.iter().all(|p| p.name != "Center of Mass"));
    }

    #[test]
    fn rejects_mass_vector_with_non_finite_values() {
        let v = "0.0, 0.0, 0.0, 0.0001, NaN, 5.0, 0,0,0,0,0,0,0,0";
        let xml = format!(r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-MassProp-Config-0"><vt:lpstr>{v}</vt:lpstr></property></propertySection></Properties>"#);
        let props = parse_properties(&deflate(xml.as_bytes()));
        assert!(props.iter().all(|p| p.name != "Mass"));
        assert!(props.iter().all(|p| p.name != "Center of Mass"));
    }

    #[test]
    fn user_properties_still_extracted_alongside_physical() {
        let xml = r#"<Properties xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="SW-MassProp-Config-0"><vt:lpstr>0,0,0,0.0001,0.01,0.785,0,0,0,0,0,0,0,0</vt:lpstr></property><property name="PartNo" pid="2"><vt:lpstr>ABC-123</vt:lpstr></property></propertySection></Properties>"#;
        let props = parse_properties(&deflate(xml.as_bytes()));
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        assert_eq!(get("Mass"), Some("785.0 g"));
        assert_eq!(get("PartNo"), Some("ABC-123"));
    }

    /// A "large" file whose property deflate stream falls in the MIDDLE gap —
    /// past the HEAD window and more than TAIL_WINDOW from the end. The
    /// head+tail fast path must NOT silently drop these properties; the
    /// fallback full-middle scan must recover them.
    ///
    /// We use tiny window constants (scan_all_max=1000, head=200, tail=400)
    /// so the fixture is only a few kilobytes and the test runs in
    /// microseconds, while still exercising exactly the same code path as
    /// a real 139 MB assembly.
    ///
    /// Layout of the 1500-byte synthetic file:
    ///   [0..200)   — 0x01 filler  (HEAD window, no properties)
    ///   [200..250) — 0x01 filler  (middle gap begins here)
    ///   [300..300+stream) — property deflate stream  (inside middle gap)
    ///   [..1100)   — 0x01 filler  (TAIL window covers [1100..1500))
    #[test]
    fn windowed_scan_fallback_finds_properties_in_middle_gap() {
        let xml = r#"<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="x"><propertySection name="UserDefinedProperties"><property name="Description" pid="2"><vt:lpstr>Mid Assembly</vt:lpstr></property><property name="PartNo" pid="3"><vt:lpstr>ASM-MID-001</vt:lpstr></property></propertySection></Properties>"#;
        let stream = deflate(xml.as_bytes());

        // Small window constants that keep the fixture tiny.
        const SCAN_ALL_MAX: usize = 1_000;
        const HEAD: usize = 200;
        const TAIL: usize = 400;
        // Total = 1500 bytes (> SCAN_ALL_MAX=1000). TAIL window covers [1100..1500).
        // Property stream is injected at offset 300, which is in the middle gap
        // [HEAD=200 .. TOTAL-TAIL=1100). Neither edge window will find it.
        const TOTAL: usize = 1_500;
        const PROP_OFFSET: usize = 300;

        assert!(
            PROP_OFFSET >= HEAD,
            "stream must be outside the HEAD window"
        );
        assert!(
            PROP_OFFSET + stream.len() <= TOTAL - TAIL,
            "stream must be outside the TAIL window"
        );
        assert!(
            TOTAL > SCAN_ALL_MAX,
            "file must be above scan_all_max to trigger the windowed path"
        );

        let mut file = vec![0x01u8; TOTAL];
        file[PROP_OFFSET..PROP_OFFSET + stream.len()].copy_from_slice(&stream);

        // Call the internal windowed helper directly with the tiny constants.
        let props = parse_properties_windowed(&file, SCAN_ALL_MAX, HEAD, TAIL);
        let get = |k: &str| props.iter().find(|p| p.name == k).map(|p| p.value.as_str());
        assert_eq!(
            get("Description"),
            Some("Mid Assembly"),
            "properties in the middle gap must be recovered by the fallback scan; got: {props:?}"
        );
        assert_eq!(
            get("PartNo"),
            Some("ASM-MID-001"),
            "PartNo in middle gap must be recovered; got: {props:?}"
        );
    }
}
