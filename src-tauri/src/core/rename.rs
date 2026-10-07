//! Project-wide key rename: a `\label` key together with every `\ref`-family
//! use, or a citation key together with every `\cite`-family use and its
//! `.bib` entry. Comments are left untouched; multi-key arguments
//! (`\cref{a,b}`, `\cite{x,y}`) are handled key by key.

use crate::core::rules::comment_start;
use serde::{Deserialize, Serialize};

/// `\label` plus every command whose argument is a label key.
pub const LABEL_CMDS: &[&str] = &[
    "label", "ref", "eqref", "pageref", "autoref", "Autoref", "cref", "Cref", "nameref", "vref", "Vref", "vpageref",
    "labelcref", "subref", "cpageref", "Cpageref",
];
/// Every command whose argument is a citation key.
pub const CITE_CMDS: &[&str] = &[
    "cite", "Cite", "citep", "citet", "Citep", "Citet", "citealp", "citealt", "citeauthor", "Citeauthor", "citeyear",
    "citeyearpar", "citenum", "nocite", "parencite", "Parencite", "textcite", "Textcite", "autocite", "Autocite",
    "footcite", "supercite", "fullcite", "smartcite", "Smartcite",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyKind {
    Label,
    Cite,
}

impl KeyKind {
    pub fn commands(self) -> &'static [&'static str] {
        match self {
            KeyKind::Label => LABEL_CMDS,
            KeyKind::Cite => CITE_CMDS,
        }
    }
}

/// A key occurrence: byte range inside the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeySpan {
    /// 0-based line index.
    pub line: usize,
    /// Byte offsets into the whole source.
    pub start: usize,
    pub end: usize,
}

/// A key may not contain characters that end or break the argument.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().count() <= 200
        && !key.chars().any(|c| c.is_whitespace() || matches!(c, '{' | '}' | ',' | '%' | '#' | '\\' | '~' | '"' | '\''))
}

/// Every occurrence of `key` as an argument of one of `cmds` (comments skipped).
pub fn find_key_spans(src: &str, cmds: &[&str], key: &str) -> Vec<KeySpan> {
    let mut out = Vec::new();
    let mut offset = 0;
    for (line_idx, raw_line) in src.split_inclusive('\n').enumerate() {
        let line = raw_line.trim_end_matches(['\n', '\r']);
        let code = match comment_start(line) {
            Some(at) => &line[..at],
            None => line,
        };
        scan_line(code, cmds, key, line_idx, offset, &mut out);
        offset += raw_line.len();
    }
    out
}

fn scan_line(line: &str, cmds: &[&str], key: &str, line_idx: usize, base: usize, out: &mut Vec<KeySpan>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
            j += 1;
        }
        let cmd = &line[i + 1..j];
        if j == i + 1 || !cmds.contains(&cmd) {
            i = j.max(i + 1);
            continue;
        }
        let mut k = j;
        if k < bytes.len() && bytes[k] == b'*' {
            k += 1;
        }
        // up to two optional arguments: \cite[see][p. 5]{key}
        for _ in 0..2 {
            while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                k += 1;
            }
            if k < bytes.len() && bytes[k] == b'[' {
                let mut depth = 1;
                k += 1;
                while k < bytes.len() && depth > 0 {
                    match bytes[k] {
                        b'[' => depth += 1,
                        b']' => depth -= 1,
                        _ => {}
                    }
                    k += 1;
                }
            }
        }
        while k < bytes.len() && bytes[k].is_ascii_whitespace() {
            k += 1;
        }
        if k < bytes.len() && bytes[k] == b'{' {
            let arg_start = k + 1;
            let mut depth = 1;
            let mut m = arg_start;
            while m < bytes.len() && depth > 0 {
                match bytes[m] {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    _ => {}
                }
                m += 1;
            }
            if depth == 0 {
                let arg_end = m - 1;
                // split on commas, keeping offsets
                let mut piece_start = arg_start;
                for p in arg_start..=arg_end {
                    if p == arg_end || bytes[p] == b',' {
                        let piece = &line[piece_start..p];
                        let lead = piece.len() - piece.trim_start().len();
                        let trimmed = piece.trim();
                        if trimmed == key {
                            let s = piece_start + lead;
                            out.push(KeySpan { line: line_idx, start: base + s, end: base + s + trimmed.len() });
                        }
                        piece_start = p + 1;
                    }
                }
            }
            i = m.max(j);
        } else {
            i = j;
        }
    }
}

/// Replace `old` by `new` in the given spans (byte ranges of `src`).
pub fn apply_spans(src: &str, spans: &[KeySpan], new: &str) -> String {
    let mut out = src.to_string();
    let mut sorted = spans.to_vec();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.start));
    for s in sorted {
        out.replace_range(s.start..s.end, new);
    }
    out
}

/// Rename a key in a `.tex` source; returns the new source and the count.
pub fn rename_in_tex(src: &str, kind: KeyKind, old: &str, new: &str) -> (String, usize) {
    let spans = find_key_spans(src, kind.commands(), old);
    (apply_spans(src, &spans, new), spans.len())
}

/// Spans of a citation key in a `.bib` source: entry headers
/// (`@article{key,`) and `crossref = {key}` fields.
pub fn find_bib_key_spans(src: &str, key: &str) -> Vec<KeySpan> {
    let escaped = regex::escape(key);
    let header = regex::Regex::new(&format!(r"@\s*[A-Za-z]+\s*[{{(]\s*({escaped})\s*,")).expect("valid regex");
    let crossref = regex::Regex::new(&format!(r#"(?i)crossref\s*=\s*[{{"]\s*({escaped})\s*[}}"]"#)).expect("valid regex");
    let mut spans: Vec<KeySpan> = Vec::new();
    for re in [&header, &crossref] {
        for caps in re.captures_iter(src) {
            let m = caps.get(1).expect("group 1");
            let line = src[..m.start()].matches('\n').count();
            spans.push(KeySpan { line, start: m.start(), end: m.end() });
        }
    }
    spans.sort_by_key(|s| s.start);
    spans
}

/// Convert a span to a 1-based (line, start column, end column) in UTF-16
/// units — the editor's coordinate system.
pub fn span_to_utf16(src: &str, span: &KeySpan) -> (usize, usize, usize) {
    let line_start = src[..span.start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let col = |to: usize| src[line_start..to].encode_utf16().count() + 1;
    (span.line + 1, col(span.start), col(span.end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_labels_refs_and_multi_key_args_but_not_comments() {
        let src = "\\section{A}\\label{sec:a}\nSee \\ref{sec:a}, \\cref{sec:b, sec:a} and \\eqref{sec:ab}.\n% \\ref{sec:a} stays\n\\Cref*{sec:a}\n";
        let (out, n) = rename_in_tex(src, KeyKind::Label, "sec:a", "sec:intro");
        assert_eq!(n, 4);
        assert_eq!(
            out,
            "\\section{A}\\label{sec:intro}\nSee \\ref{sec:intro}, \\cref{sec:b, sec:intro} and \\eqref{sec:ab}.\n% \\ref{sec:a} stays\n\\Cref*{sec:intro}\n"
        );
    }

    #[test]
    fn renames_cite_keys_with_optional_arguments() {
        let src = "\\cite[see][p.~5]{knuth,lamport} and \\citet{knuth}\n\\label{knuth}\n";
        let (out, n) = rename_in_tex(src, KeyKind::Cite, "knuth", "knuth1984");
        assert_eq!(n, 2);
        assert!(out.contains("\\cite[see][p.~5]{knuth1984,lamport}"));
        assert!(out.contains("\\citet{knuth1984}"));
        assert!(out.contains("\\label{knuth}"), "labels are not citation keys");
    }

    #[test]
    fn renames_bib_entry_header_and_crossref() {
        let src = "@book{knuth,\n  title = {T},\n}\n@inbook{ch1,\n  crossref = {knuth},\n}\n@article{knuthx, title={X}}\n";
        let spans = find_bib_key_spans(src, "knuth");
        assert_eq!(spans.len(), 2);
        let out = apply_spans(src, &spans, "knuth84");
        assert!(out.starts_with("@book{knuth84,"));
        assert!(out.contains("crossref = {knuth84}"));
        assert!(out.contains("@article{knuthx,"));
    }

    #[test]
    fn utf16_columns_and_key_validation() {
        let src = "中文 \\ref{a}\n";
        let spans = find_key_spans(src, LABEL_CMDS, "a");
        assert_eq!(span_to_utf16(src, &spans[0]), (1, 9, 10));
        assert!(valid_key("fig:结果-1"));
        assert!(!valid_key("a b"));
        assert!(!valid_key("a,b"));
        assert!(!valid_key(""));
    }
}
