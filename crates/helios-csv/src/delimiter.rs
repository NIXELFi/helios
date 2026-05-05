/// Detects the most likely delimiter from the first line of a CSV.
/// Tries `,` `;` `\t` in order and picks the one with the most occurrences (>= 1).
pub fn detect_delimiter(first_line: &str) -> u8 {
    let candidates = [b',', b';', b'\t'];
    let mut best = b',';
    let mut best_count = 0;
    for &d in &candidates {
        let count = first_line.bytes().filter(|&b| b == d).count();
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
}
