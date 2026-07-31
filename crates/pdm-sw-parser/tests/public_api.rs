use std::io::{Cursor, Write};
use pdm_sw_parser::{parse_refs, RefHint};

fn cfb_with_streams(streams: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let cursor = Cursor::new(&mut buf);
        let mut comp = cfb::CompoundFile::create(cursor).unwrap();
        for (name, payload) in streams {
            comp.create_stream(*name).unwrap().write_all(payload).unwrap();
        }
        comp.flush().unwrap();
    }
    buf
}

/// Garbage in must NOT look like "this assembly has no references" — the ref
/// recorder replaces a version's whole ref set with what it's given, so an
/// empty Vec here would wipe a real where-used graph. It must be an Err.
#[test]
fn parse_refs_on_garbage_input_does_not_panic_and_errors() {
    let err = parse_refs(b"\x00\x01\x02 not a cfb at all").unwrap_err();
    assert!(matches!(err, pdm_sw_parser::ParseError::NotCfb(_)), "got: {err:?}");
}

/// A real CFB with no reference streams IS legitimately zero references —
/// that stays `Ok(vec![])`, distinguishable from the garbage case above.
#[test]
fn parse_refs_on_cfb_without_reference_streams_returns_empty() {
    let cfb = cfb_with_streams(&[("Properties", b"hello")]);
    let refs = parse_refs(&cfb).unwrap();
    assert!(refs.is_empty());
}

#[test]
fn parse_refs_aggregates_hints_across_multiple_reference_streams() {
    let cfb = cfb_with_streams(&[
        ("External References", b"..\\parts\\a.sldprt\x00..\\parts\\b.sldprt\x00"),
        ("Component References", b"..\\hardware\\bolt.sldprt\x00"),
    ]);
    let refs = parse_refs(&cfb).unwrap();
    let basenames: Vec<&str> = refs.iter().map(RefHint::basename).collect();
    assert!(basenames.contains(&"a.sldprt"));
    assert!(basenames.contains(&"b.sldprt"));
    assert!(basenames.contains(&"bolt.sldprt"));
}

/// SolidWorks stream names vary in casing across versions (`References`,
/// `REFERENCES`, `reference data`, etc.). The audit (2026-05-11) flagged
/// the prior case-sensitive `contains("Reference")` filter as silently
/// skipping anything not capitalized the One True Way. Verify the
/// case-insensitive filter catches lower- and upper-case variants.
#[test]
fn parse_refs_matches_stream_names_case_insensitively() {
    let cfb = cfb_with_streams(&[
        ("reference data", b"..\\parts\\lower.sldprt\x00"),
        ("REFERENCES", b"..\\parts\\upper.sldprt\x00"),
    ]);
    let refs = parse_refs(&cfb).unwrap();
    let basenames: Vec<&str> = refs.iter().map(RefHint::basename).collect();
    assert!(basenames.contains(&"lower.sldprt"), "got: {basenames:?}");
    assert!(basenames.contains(&"upper.sldprt"), "got: {basenames:?}");
}
