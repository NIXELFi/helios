use std::io::{Cursor, Write};
use pdm_sw_parser::cfb_reader::{open_cfb, list_streams, list_refs};

fn empty_cfb_bytes() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let cursor = Cursor::new(&mut buf);
        let mut comp = cfb::CompoundFile::create(cursor).unwrap();
        comp.create_stream("\x05DocumentSummaryInformation").unwrap()
            .write_all(b"placeholder").unwrap();
        comp.flush().unwrap();
    }
    buf
}

#[test]
fn open_cfb_succeeds_on_valid_container() {
    let bytes = empty_cfb_bytes();
    let cursor = Cursor::new(bytes);
    let comp = open_cfb(cursor).unwrap();
    let names = list_streams(&comp);
    assert!(names.iter().any(|n| n.contains("DocumentSummaryInformation")));
}

#[test]
fn list_refs_on_garbage_returns_none() {
    let result = list_refs(b"this is not a CFB container");
    assert!(result.is_none(), "non-CFB input must return None, not panic");
}

#[test]
fn list_refs_on_empty_cfb_returns_empty_vec() {
    let bytes = empty_cfb_bytes();
    let result = list_refs(&bytes).unwrap();
    assert!(result.is_empty());
}
