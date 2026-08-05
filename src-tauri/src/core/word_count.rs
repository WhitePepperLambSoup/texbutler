//! Chinese-writing word count: strip comments and command names, keep the
//! arguments (section titles, textbf contents, ...) as body text. Counts:
//! total non-whitespace chars, CJK chars, Latin words and lines.

use crate::core::rules::comment_start;

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct WordCount {
    /// Non-whitespace characters (CJK + Latin + punctuation).
    pub chars: usize,
    /// CJK ideographs + CJK punctuation.
    pub cjk_chars: usize,
    /// Latin word tokens ([A-Za-z]+ sequences).
    pub words: usize,
    /// Number of non-empty lines.
    pub lines: usize,
}

/// Count a single `.tex` source (comments and command names excluded).
pub fn count_source(src: &str) -> WordCount {
    let mut chars = 0usize;
    let mut cjk_chars = 0usize;
    let mut words = 0usize;
    let mut lines = 0usize;

    for raw_line in src.lines() {
        // strip the comment part
        let line = match comment_start(raw_line) {
            Some(at) => &raw_line[..at],
            None => raw_line,
        };
        let line = strip_command_names(line);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        lines += 1;
        let mut in_word = false;
        for c in trimmed.chars() {
            if c.is_whitespace() || c == '{' || c == '}' {
                in_word = false;
                continue;
            }
            chars += 1;
            if is_cjk_char(c) {
                cjk_chars += 1;
                in_word = false;
            } else if c.is_ascii_alphabetic() {
                if !in_word {
                    words += 1;
                    in_word = true;
                }
            } else {
                in_word = false;
            }
        }
    }
    WordCount { chars, cjk_chars, words, lines }
}

/// Remove `\command` / `\command*` names (keep `{arguments}`), and collapse
/// `\` escapes that are not commands (e.g. `\%`, `\&`) — the escaped char
/// itself stays. Iterates by char so multibyte CJK text is preserved.
fn strip_command_names(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '\\' {
            // peek: is this a letter command?
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_alphabetic() || chars[j] == '@') {
                j += 1;
            }
            if j > i + 1 {
                // command name found; keep an optional trailing `*`
                let mut k = j;
                if k < chars.len() && chars[k] == '*' {
                    k += 1;
                }
                // skip a following space (TeX eats it after a control word)
                i = k;
                if i < chars.len() && chars[i] == ' ' {
                    i += 1;
                }
                continue;
            }
            // `\X` escape: keep the next char (or the backslash itself)
            if j < chars.len() {
                out.push(chars[j]);
                i = j + 1;
                continue;
            }
            out.push('\\');
            i = j + 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn is_cjk_char(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{3000}'..='\u{303F}'
        | '\u{FF00}'..='\u{FFEF}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_chinese_prose() {
        let src = "这是第一段。\n\n这是第二段，包含中文。\n";
        let w = count_source(src);
        assert_eq!(w.chars, 17);
        assert_eq!(w.cjk_chars, 17);
        assert_eq!(w.lines, 2);
    }

    #[test]
    fn excludes_comments_and_command_names() {
        let src = "\\section{引言} % 这是注释\n正文 \\textbf{加粗} 内容。\n";
        let w = count_source(src);
        assert_eq!(w.cjk_chars, 9); // 引言2 + 正文2 + 加粗2 + 内容2 + 。1
        assert_eq!(w.chars, 9);
    }

    #[test]
    fn counts_latin_words() {
        let src = "Hello \\LaTeX{} world, from Tectonic.\n";
        let w = count_source(src);
        assert_eq!(w.words, 4); // Hello, world, from, Tectonic
        assert_eq!(w.chars, 24);
    }

    #[test]
    fn escaped_percent_is_not_a_comment() {
        let src = "71\\% 的用户\n";
        let w = count_source(src);
        assert_eq!(w.chars, 6); // 7 1 % 的 用 户
        assert_eq!(w.cjk_chars, 3); // 的 用 户
    }

    #[test]
    fn empty_and_comment_only_lines_count_zero() {
        assert_eq!(count_source(""), WordCount { chars: 0, cjk_chars: 0, words: 0, lines: 0 });
        assert_eq!(count_source("% 全部注释\n\n"), WordCount { chars: 0, cjk_chars: 0, words: 0, lines: 0 });
    }
}
