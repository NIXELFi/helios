/// Detects the most likely delimiter from the first line of a CSV.
/// Tries `,` `;` `\t` in order and picks the one with the most occurrences (>= 1).
///
/// Counting is quote-aware: separators inside a double-quoted cell are ignored.
/// This matters for vendor preamble lines like `"Name","ECU ... 13;33;03"`,
/// whose quoted timestamp would otherwise make a comma-delimited file look
/// semicolon-delimited.
pub fn detect_delimiter(first_line: &str) -> u8 {
    let candidates = [b',', b';', b'\t'];
    let mut best = b',';
    let mut best_count = 0;
    for &d in &candidates {
        let mut in_quotes = false;
        let mut count = 0usize;
        for &b in first_line.as_bytes() {
            if b == b'"' {
                in_quotes = !in_quotes;
            } else if b == d && !in_quotes {
                count += 1;
            }
        }
        if count > best_count {
            best = d;
            best_count = count;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comma() {
        assert_eq!(detect_delimiter("a,b,c"), b',');
    }
    #[test]
    fn semi() {
        assert_eq!(detect_delimiter("a;b;c"), b';');
    }
    #[test]
    fn tab() {
        assert_eq!(detect_delimiter("a\tb\tc"), b'\t');
    }
    #[test]
    fn comma_wins_tie_with_no_others() {
        assert_eq!(detect_delimiter("only_one_column"), b',');
    }
    #[test]
    fn ignores_separators_inside_quotes() {
        // Link preamble: the semicolons live inside the quoted timestamp, so the
        // real delimiter is the comma between the two quoted cells.
        assert_eq!(
            detect_delimiter("\"Name\",\"ECU Internal Datalog - 2026-05-03 13;33;03\""),
            b',',
        );
    }
}
