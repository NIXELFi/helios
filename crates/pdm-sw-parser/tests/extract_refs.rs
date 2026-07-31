use std::io::{Cursor, Write};
use pdm_sw_parser::parse_refs;

fn build_cfb_with_refs_stream(payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let cursor = Cursor::new(&mut buf);
        let mut comp = cfb::CompoundFile::create(cursor).unwrap();
        comp.create_stream("External References").unwrap().write_all(payload).unwrap();
        comp.flush().unwrap();
    }
    buf
}

#[test]
fn extracts_path_strings_from_ref_stream() {
    let mut payload: Vec<u8> = Vec::new();
    payload.extend_from_slice(b"\x00\x00\x00\x00..\\parts\\frame-rail.sldprt\x00");
    payload.extend_from_slice(b"junk_bytes\xff\xff\xff\xff");
    payload.extend_from_slice(b"..\\hardware\\m6-bolt-25.sldprt\x00");

    let cfb = build_cfb_with_refs_stream(&payload);
    let refs = parse_refs(&cfb).unwrap();
    let paths: Vec<&str> = refs.iter().map(|r| r.path.as_str()).collect();
    assert!(paths.iter().any(|p| p.ends_with("frame-rail.sldprt")));
    assert!(paths.iter().any(|p| p.ends_with("m6-bolt-25.sldprt")));
}

#[test]
fn ignores_non_sw_extensions() {
    let payload = b"helper.txt\x00random.png\x00valid.sldasm\x00";
    let cfb = build_cfb_with_refs_stream(payload);
    let refs = parse_refs(&cfb).unwrap();
    let paths: Vec<&str> = refs.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(paths.len(), 1);
    assert!(paths[0].ends_with("valid.sldasm"));
}

#[test]
fn empty_ref_stream_returns_empty_vec() {
    let cfb = build_cfb_with_refs_stream(&[]);
    let refs = parse_refs(&cfb).unwrap();
    assert!(refs.is_empty());
}
