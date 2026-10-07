//! Text encoding detection for project files. Chinese LaTeX templates from
//! older toolchains (CCT, CJK package, Windows editors) are often saved as
//! GBK / GB18030; XeLaTeX and Tectonic read UTF-8 only. Such files are
//! decoded for the editor and can be converted to UTF-8 in place.

use std::borrow::Cow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    /// GBK / GB18030 (GB18030 is a superset of GBK and GB2312).
    Gb18030,
}

impl TextEncoding {
    pub fn label(self) -> &'static str {
        match self {
            TextEncoding::Utf8 => "utf-8",
            TextEncoding::Gb18030 => "gbk",
        }
    }
}

/// Extensions of text files whose encoding matters for compilation.
pub const TEXT_EXTENSIONS: &[&str] = &["tex", "bib", "sty", "cls", "txt", "md", "bbx", "cbx", "cfg", "def"];

/// Decode file bytes: UTF-8 (BOM stripped) or plausible GB18030 text.
/// `None` when the bytes are neither (binary or an unknown legacy encoding).
pub fn decode(bytes: &[u8]) -> Option<(String, TextEncoding)> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Some((s.to_string(), TextEncoding::Utf8));
    }
    decode_gb18030(bytes).map(|s| (s, TextEncoding::Gb18030))
}

/// Strict GB18030 decode plus a plausibility check: the non-ASCII text must
/// be mostly CJK, so Latin-1 / Windows-1252 files are not misread as Chinese.
pub fn decode_gb18030(bytes: &[u8]) -> Option<String> {
    let text: Cow<str> = encoding_rs::GB18030.decode_without_bom_handling_and_without_replacement(bytes)?;
    let (mut non_ascii, mut cjk) = (0usize, 0usize);
    for c in text.chars() {
        if !c.is_ascii() {
            non_ascii += 1;
            if is_cjk_like(c) {
                cjk += 1;
            }
        }
    }
    if non_ascii == 0 || cjk * 10 >= non_ascii * 6 {
        Some(text.into_owned())
    } else {
        None
    }
}

/// Characters a GBK document is made of: ideographs, CJK punctuation,
/// full-width forms, kana and the Greek/Cyrillic/box symbols of GB2312.
fn is_cjk_like(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{3000}'..='\u{30FF}'
        | '\u{FF00}'..='\u{FFEF}'
        | '\u{2000}'..='\u{2BFF}'
        | '\u{0391}'..='\u{03C9}'
        | '\u{0401}'..='\u{0451}'
        | '\u{00B7}' | '\u{00D7}' | '\u{00F7}' | '\u{00B0}' | '\u{00A7}'
    )
}

/// True for file names whose encoding is checked.
pub fn is_text_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    TEXT_EXTENSIONS.iter().any(|e| lower.ends_with(&format!(".{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gbk(s: &str) -> Vec<u8> {
        encoding_rs::GB18030.encode(s).0.into_owned()
    }

    #[test]
    fn utf8_with_and_without_bom() {
        assert_eq!(decode("中文 abc".as_bytes()).unwrap(), ("中文 abc".to_string(), TextEncoding::Utf8));
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("x".as_bytes());
        assert_eq!(decode(&bom).unwrap().0, "x");
    }

    #[test]
    fn detects_gbk_chinese() {
        let src = "\\documentclass{ctexart}\n\\begin{document}\n你好，世界！这是 GBK 编码的文档。\n\\end{document}\n";
        let bytes = gbk(src);
        assert!(std::str::from_utf8(&bytes).is_err());
        let (text, enc) = decode(&bytes).unwrap();
        assert_eq!(enc, TextEncoding::Gb18030);
        assert_eq!(text, src);
    }

    #[test]
    fn latin1_is_not_mistaken_for_gbk() {
        // "café résumé naïve" in ISO-8859-1
        let latin1: Vec<u8> = b"caf\xe9 r\xe9sum\xe9 na\xefve fa\xe7ade".to_vec();
        assert!(decode(&latin1).is_none());
    }

    #[test]
    fn text_file_extensions() {
        assert!(is_text_file("ch/intro.TEX"));
        assert!(is_text_file("refs.bib"));
        assert!(!is_text_file("fig.png"));
    }
}
