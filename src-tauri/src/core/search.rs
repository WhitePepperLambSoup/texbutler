//! Project-wide text search and replace over the project's text sources.

use crate::core::project::Project;
use serde::{Deserialize, Serialize};

/// Extensions searched (text sources only; binaries/PDFs are skipped).
const TEXT_EXTS: [&str; 10] = ["tex", "bib", "sty", "cls", "md", "txt", "bbx", "cbx", "def", "cfg"];
/// Files larger than this are skipped (generated data, not sources).
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Hard cap on returned hits so a one-letter query stays responsive.
pub const MAX_HITS: usize = 5000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchHit {
    pub file: String,
    /// 1-based line.
    pub line: usize,
    /// 1-based column in characters (UTF-16 safe for the editor: CJK
    /// characters are one UTF-16 unit, like Monaco columns).
    pub col: usize,
    /// Match length in characters.
    pub len: usize,
    /// The whole line (trimmed to 400 chars).
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub files_searched: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReplaceResult {
    pub files_changed: Vec<String>,
    pub replacements: usize,
}

pub fn build_regex(opts: &SearchOptions) -> Result<regex::Regex, String> {
    if opts.query.is_empty() {
        return Err("搜索内容为空".into());
    }
    let mut pattern = if opts.regex { opts.query.clone() } else { regex::escape(&opts.query) };
    if opts.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .multi_line(true)
        .size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|e| format!("正则表达式无效: {e}"))
}

/// Text files of the project (relative, forward slashes, sorted). Hidden
/// directories (`.texbutler`, `.git`, …) and build folders are skipped.
pub fn text_files(project: &Project) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![project.root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if !name.starts_with('.') && name != "node_modules" && name != "target" {
                    stack.push(path);
                }
                continue;
            }
            let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if !TEXT_EXTS.contains(&ext.as_str()) || meta.len() > MAX_FILE_BYTES {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(&project.root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out.sort();
    out
}

fn char_col(line: &str, byte_idx: usize) -> usize {
    line[..byte_idx].encode_utf16().count() + 1
}

/// Search the line-by-line content of one file.
pub fn search_text(file: &str, content: &str, re: &regex::Regex, out: &mut Vec<SearchHit>, cap: usize) -> bool {
    for (i, line) in content.lines().enumerate() {
        for m in re.find_iter(line) {
            if m.as_str().is_empty() {
                continue;
            }
            if out.len() >= cap {
                return true;
            }
            let text: String = line.chars().take(400).collect();
            out.push(SearchHit {
                file: file.to_string(),
                line: i + 1,
                col: char_col(line, m.start()),
                len: m.as_str().encode_utf16().count(),
                text,
            });
        }
    }
    false
}

pub fn search(project: &Project, opts: &SearchOptions) -> Result<SearchResult, String> {
    let re = build_regex(opts)?;
    let files = text_files(project);
    let mut hits = Vec::new();
    let mut truncated = false;
    for rel in &files {
        let Ok(content) = project.read_file(rel) else { continue };
        if search_text(rel, &content, &re, &mut hits, MAX_HITS) {
            truncated = true;
            break;
        }
    }
    Ok(SearchResult { hits, files_searched: files.len(), truncated })
}

/// Replace in `content`; returns (new content, number of replacements).
/// In plain-text mode `$` in the replacement is literal; in regex mode
/// `$1` / `${name}` refer to capture groups.
pub fn replace_text(content: &str, re: &regex::Regex, replacement: &str, regex_mode: bool) -> (String, usize) {
    let count = re.find_iter(content).filter(|m| !m.as_str().is_empty()).count();
    if count == 0 {
        return (content.to_string(), 0);
    }
    let out = if regex_mode {
        re.replace_all(content, replacement).into_owned()
    } else {
        re.replace_all(content, regex::NoExpand(replacement)).into_owned()
    };
    (out, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(q: &str) -> SearchOptions {
        SearchOptions { query: q.into(), regex: false, case_sensitive: false, whole_word: false }
    }

    #[test]
    fn plain_search_is_literal_and_case_insensitive_by_default() {
        let re = build_regex(&opts("a.b")).unwrap();
        let mut hits = Vec::new();
        search_text("x.tex", "A.B axb\na.b", &re, &mut hits, 100);
        assert_eq!(hits.len(), 2, "`.` must be literal: {hits:?}");
        assert_eq!((hits[0].line, hits[0].col, hits[0].len), (1, 1, 3));
        assert_eq!((hits[1].line, hits[1].col), (2, 1));
    }

    #[test]
    fn whole_word_and_case_sensitive() {
        let mut o = opts("sec");
        o.whole_word = true;
        o.case_sensitive = true;
        let re = build_regex(&o).unwrap();
        let mut hits = Vec::new();
        search_text("x.tex", "sec section Sec sec", &re, &mut hits, 100);
        assert_eq!(hits.iter().map(|h| h.col).collect::<Vec<_>>(), vec![1, 17]);
    }

    #[test]
    fn columns_count_cjk_as_single_units() {
        let re = build_regex(&opts("LaTeX")).unwrap();
        let mut hits = Vec::new();
        search_text("x.tex", "中文LaTeX", &re, &mut hits, 100);
        assert_eq!(hits[0].col, 3);
    }

    #[test]
    fn replace_plain_keeps_dollar_literal_and_regex_expands_groups() {
        let re = build_regex(&opts("x")).unwrap();
        assert_eq!(replace_text("x + x", &re, "$1", false), ("$1 + $1".to_string(), 2));
        let mut o = opts(r"\\ref\{(\w+)\}");
        o.regex = true;
        let re = build_regex(&o).unwrap();
        assert_eq!(
            replace_text(r"see \ref{a} and \ref{b}", &re, r"\cref{$1}", true),
            (r"see \cref{a} and \cref{b}".to_string(), 2)
        );
    }

    #[test]
    fn invalid_regex_is_reported() {
        let mut o = opts("(");
        o.regex = true;
        assert!(build_regex(&o).unwrap_err().contains("正则"));
        assert!(build_regex(&opts("")).is_err());
    }

    #[test]
    fn hit_cap_truncates() {
        let re = build_regex(&opts("a")).unwrap();
        let mut hits = Vec::new();
        assert!(search_text("x", "aaaa", &re, &mut hits, 3));
        assert_eq!(hits.len(), 3);
    }
}
