use pdm_core::{CoreError, Sha256};

#[test]
fn parses_64_lowercase_hex_chars() {
    let raw = "a".repeat(64);
    let s: Sha256 = raw.parse().expect("must parse");
    assert_eq!(s.as_str(), raw);
}

#[test]
fn accepts_uppercase_hex_and_lowercases_canonically() {
    // Servers may return uppercase hex; round-trip should normalize.
    let upper = "A".repeat(64);
    let s: Sha256 = upper.parse().expect("uppercase hex must parse");
    assert_eq!(s.as_str(), "a".repeat(64));
    assert_eq!(s.to_string(), "a".repeat(64));
}

#[test]
fn accepts_mixed_case_hex() {
    let mixed = "AaBbCcDdEeFf0123456789".to_string() + &"0".repeat(42);
    let s: Sha256 = mixed.parse().expect("mixed case hex must parse");
    assert_eq!(s.as_str(), mixed.to_ascii_lowercase());
}

#[test]
fn rejects_wrong_length() {
    assert!(matches!(
        "a".repeat(63).parse::<Sha256>(),
        Err(CoreError::InvalidSha256(_))
    ));
    assert!(matches!(
        "a".repeat(65).parse::<Sha256>(),
        Err(CoreError::InvalidSha256(_))
    ));
}

#[test]
fn rejects_non_hex_chars() {
    let mut s = "a".repeat(63);
    s.push('z');
    assert!(matches!(s.parse::<Sha256>(), Err(CoreError::InvalidSha256(_))));
}

#[test]
fn display_is_identical_to_input() {
    let raw = "0123456789abcdef".repeat(4);
    let s: Sha256 = raw.parse().unwrap();
    assert_eq!(s.to_string(), raw);
}

#[test]
fn storage_path_returns_two_char_prefix_slash_full() {
    let raw = "abcdef".to_string() + &"0".repeat(58);
    let s: Sha256 = raw.parse().unwrap();
    assert_eq!(s.storage_path(), format!("ab/{raw}"));
}
