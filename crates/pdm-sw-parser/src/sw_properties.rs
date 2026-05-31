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

/// Top-level entry: extract custom properties (de-duplicated by name) from the
/// bytes of a SolidWorks file.
pub fn parse_properties(bytes: &[u8]) -> Vec<SwProperty> {
    let mut out: Vec<SwProperty> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let n = bytes.len();
    let mut i = 0usize;
    while i + 2 < n {
        match try_inflate(&bytes[i..]) {
            Some((text, consumed)) => {
                if text.contains("<property name=") || text.contains("Material=") {
                    extract_props(&text, &mut out, &mut seen);
                }
                i += consumed.max(1);
            }
            None => i += 1,
        }
    }
    out
}

/// Try to raw-inflate a deflate stream starting at `input[0]`. Returns the
/// decompressed text (lossy UTF-8) and the number of input bytes consumed, or
/// None if this offset isn't the start of a usable stream. We only care about
/// streams that decompress to a meaningful amount of data.
fn try_inflate(input: &[u8]) -> Option<(String, usize)> {
    let mut dec = flate2::read::DeflateDecoder::new(input);
    let mut collected: Vec<u8> = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        match dec.read(&mut buf) {
            Ok(0) => break,
            Ok(k) => {
                collected.extend_from_slice(&buf[..k]);
                // Cap: property XML parts are small; geometry sections can be
                // large but we still need full consume to advance. Bail very
                // large sections early (they're geometry, never properties) to
                // keep check-in-time parsing fast — we lose exact `consumed`
                // but advance by what we read, which is enough to make progress.
                if collected.len() > 8 * 1024 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let consumed = dec.total_in() as usize;
    if collected.len() < 32 || consumed == 0 {
        return None;
    }
    Some((String::from_utf8_lossy(&collected).into_owned(), consumed))
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
        if name.is_empty() || is_system_prop(name) {
            // Skip pid placeholders (<property name="" …>) and SolidWorks'
            // auto-generated system properties — the data card should show only
            // the user-defined fields the modeler actually typed.
            continue;
        }
        // Value: the first <vt:TYPE>…</vt:TYPE> after the name attribute.
        let rest = &text[search..];
        if let Some(vt) = rest.find("<vt:") {
            let after_tag = &rest[vt + 4..];
            if let (Some(gt), ()) = (after_tag.find('>'), ()) {
                let val_start = vt + 4 + gt + 1;
                if let Some(close) = rest[val_start..].find("</vt:") {
                    let value = rest[val_start..val_start + close].trim();
                    if !value.is_empty() {
                        push(out, seen, name, value);
                    }
                }
            }
        }
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
}
