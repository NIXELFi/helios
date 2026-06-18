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
    let mut physical: Vec<SwProperty> = Vec::new();
    let mut custom: Vec<SwProperty> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut have_physical = false;
    let n = bytes.len();

    // The property parts sit near the FRONT of the container (most parts) or at
    // the very END (assemblies); the bulk in between is geometry. Decompressing
    // all of it just to reach the property block is what made a 139 MB assembly
    // take ~25 s. For large files we scan only the two edges and skip the middle
    // (which never holds the property block) — the same 139 MB file drops to a
    // few seconds. Small files are scanned whole (already fast).
    const SCAN_ALL_MAX: usize = 24 * 1024 * 1024;
    const HEAD_WINDOW: usize = 8 * 1024 * 1024;
    const TAIL_WINDOW: usize = 12 * 1024 * 1024;
    if n <= SCAN_ALL_MAX {
        scan_region(bytes, 0, n, &mut physical, &mut custom, &mut seen, &mut have_physical);
    } else {
        scan_region(bytes, 0, HEAD_WINDOW, &mut physical, &mut custom, &mut seen, &mut have_physical);
        scan_region(bytes, n - TAIL_WINDOW, n, &mut physical, &mut custom, &mut seen, &mut have_physical);
    }
    physical.into_iter().chain(custom).collect()
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
) {
    let mut i = start;
    while i + 2 < end {
        match try_inflate(&bytes[i..]) {
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
fn try_inflate(input: &[u8]) -> Option<(Vec<u8>, usize)> {
    let mut dec = flate2::read::DeflateDecoder::new(input);
    let mut head: Vec<u8> = Vec::new();
    let mut buf = [0u8; 65536];
    let mut total_out = 0usize;
    loop {
        match dec.read(&mut buf) {
            Ok(0) => break,
            Ok(k) => {
                total_out += k;
                if head.len() < INSPECT_CAP {
                    let take = (INSPECT_CAP - head.len()).min(k);
                    head.extend_from_slice(&buf[..take]);
                }
                if total_out > 64 * 1024 * 1024 {
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
        // Value: the first <vt:TYPE>…</vt:TYPE> after the name attribute.
        let rest = &text[search..];
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
}
