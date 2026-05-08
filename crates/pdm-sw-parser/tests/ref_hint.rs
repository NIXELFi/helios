use pdm_sw_parser::RefHint;

#[test]
fn ref_hint_holds_a_path() {
    let r = RefHint { path: "..\\parts\\frame-rail.sldprt".to_string() };
    assert_eq!(r.path, "..\\parts\\frame-rail.sldprt");
}

#[test]
fn ref_hint_basename_extracts_filename_unix_or_windows_separators() {
    let r = RefHint { path: "..\\parts\\frame-rail.sldprt".to_string() };
    assert_eq!(r.basename(), "frame-rail.sldprt");

    let r = RefHint { path: "/Users/me/project/frame-rail.sldprt".to_string() };
    assert_eq!(r.basename(), "frame-rail.sldprt");

    let r = RefHint { path: "no-separators.sldprt".to_string() };
    assert_eq!(r.basename(), "no-separators.sldprt");
}

#[test]
fn ref_hint_serde_round_trip() {
    let r = RefHint { path: "x.sldprt".to_string() };
    let s = serde_json::to_string(&r).unwrap();
    let back: RefHint = serde_json::from_str(&s).unwrap();
    assert_eq!(back, r);
}
