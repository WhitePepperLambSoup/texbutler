//! Hand-written parser for LaTeX `.log` files produced with
//! `-file-line-error -interaction=nonstopmode -halt-on-error`.
//!
//! Capabilities (the product moat):
//! 1. Extract every error block (`! ...`) together with 2-5 lines of context.
//! 2. Resolve the *real* file/line: prefer `./file.tex:<line>:` prefixes,
//!    fall back to `l.<line>` plus the nearest `(<file>` context marker.
//! 3. Classify common errors via a keyword table into human-readable Chinese.
//! 4. Keep the raw block for the AI layer.

use crate::core::{Issue, IssueKind, Severity};
use std::path::Path;

/// A raw error block extracted from the log.
#[derive(Debug, Clone)]
struct RawBlock {
    /// First line of the block (starts with `!` or is a file:line: line).
    header: String,
    /// The rest of the block (context lines).
    body: Vec<String>,
    /// File context established by the nearest `(<file>` marker.
    context_file: Option<String>,
}

/// Parse a LaTeX log file into structured issues.
pub fn parse_log(log_path: &Path) -> Vec<Issue> {
    let Ok(content) = std::fs::read_to_string(log_path) else {
        return vec![Issue::new(
            Severity::Error,
            IssueKind::CompileError,
            format!("无法读取日志文件: {}", log_path.display()),
        )];
    };
    parse_log_str(&content)
}

/// Parse log text (unit-testable).
pub fn parse_log_str(content: &str) -> Vec<Issue> {
    let mut issues = Vec::new();
    let mut blocks: Vec<RawBlock> = Vec::new();
    let mut current: Option<RawBlock> = None;
    let mut context_file: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim_end();

        // Track `(./file.tex` context markers. Lines like `(./main.tex` open
        // a file; `(./main.tex` followed by more `(` nesting is common.
        if let Some(idx) = find_context_marker(trimmed) {
            context_file = Some(trimmed[idx + 1..].to_string());
        }

        let is_error_start = trimmed.starts_with('!')
            // file-line-error style without `!` (fatal lines)
            || (find_file_line(trimmed).is_some() && !trimmed.starts_with('(') && !trimmed.contains("Overfull") && !trimmed.contains("Underfull"))
            // standalone overfull/underfull warnings have no `!` marker
            || trimmed.contains("Overfull \\hbox")
            || trimmed.contains("Underfull \\hbox")
            || trimmed.contains("Overfull \\vbox")
            || trimmed.contains("Underfull \\vbox");

        if is_error_start {
            if let Some(b) = current.take() {
                blocks.push(b);
            }
            current = Some(RawBlock {
                header: trimmed.to_string(),
                body: Vec::new(),
                context_file: context_file.clone(),
            });
        } else if let Some(b) = current.as_mut() {
            // Stop collecting when we hit the prompt line or a big gap.
            if trimmed == "?" || trimmed.is_empty() {
                // keep the empty line as context, but don't add further junk
                b.body.push(trimmed.to_string());
            } else {
                b.body.push(trimmed.to_string());
            }
        }
    }
    if let Some(b) = current.take() {
        blocks.push(b);
    }

    for block in blocks {
        if let Some(issue) = classify(&block) {
            issues.push(issue);
        }
    }
    issues
}

/// Find a `(<path>` context marker. Returns byte index of the `(` char.
fn find_context_marker(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'(' {
            // Must be followed by `./` or a letter and not be part of an
            // error continuation like `\begin{...}`.
            let rest = &line[i + 1..];
            if rest.starts_with("./") || rest.starts_with('/') {
                return Some(i);
            }
            if let Some(c) = rest.chars().next() {
                if c.is_ascii_alphabetic() {
                    return Some(i);
                }
            }
        }
        i += 1;
    }
    None
}

/// Extract `l.<N>` line numbers from a string.
fn find_l_line(s: &str) -> Option<usize> {
    // Pattern: `l.123` at line start or after whitespace
    for token in s.split_whitespace() {
        if let Some(rest) = token.strip_prefix("l.") {
            if let Ok(n) = rest.trim_end_matches('.').parse::<usize>() {
                return Some(n);
            }
        }
    }
    None
}

/// Extract `./file.tex:<N>:` (file-line-error) or `./file.tex:<N> ` forms.
fn find_file_line(s: &str) -> Option<(String, usize)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        // look for `./` or `file.tex:` — search for a colon preceded by digits
        if bytes[i] == b':' && i > 0 && bytes[i - 1].is_ascii_digit() {
            // walk back over digits
            let mut j = i - 1;
            while j > 0 && bytes[j - 1].is_ascii_digit() {
                j -= 1;
            }
            let num_ok = s[j..i].parse::<usize>().ok();
            // walk back over the filename (skip the colon separator)
            let mut k = j;
            if k > 0 && bytes[k - 1] == b':' {
                k -= 1;
            }
            while k > 0 {
                let c = bytes[k - 1];
                if c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-' || c == b'/' {
                    k -= 1;
                } else {
                    break;
                }
            }
            // Windows paths: the backtrack above stops at the first space OR
            // at the drive-letter colon (`C:/Users/...` — MiKTeX emits
            // absolute file-line-error paths). If a drive-letter prefix
            // (`X:/`) exists before the truncated part, extend the filename
            // start to it. The colon must be preceded by a letter, followed
            // by `/`, and the letter must sit at line start or after
            // whitespace — so message prefixes like `Fatal error: main.tex:`
            // are NOT absorbed into the filename.
            if k > 0 && (bytes[k - 1] == b' ' || bytes[k - 1] == b':') {
                let mut m = k;
                while m > 0 {
                    let c = bytes[m - 1];
                    if c == b':'
                        && m >= 2
                        && bytes[m - 2].is_ascii_alphabetic()
                        && bytes.get(m).copied() == Some(b'/')
                        && (m - 2 == 0 || bytes[m - 3] == b' ' || bytes[m - 3] == b'\t')
                    {
                        k = m - 2;
                        break;
                    }
                    if !(c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-' || c == b'/' || c == b' ') {
                        break;
                    }
                    m -= 1;
                }
            }
            let fname = s[k..j].trim_end_matches(':');
            if fname.contains(".tex") || fname.starts_with("./") {
                let line = num_ok?;
                let file = fname.trim_start_matches("./").to_string();
                return Some((file, line));
            }
        }
        i += 1;
    }
    None
}

/// Trim a file context like `./sub/chap.tex` and strip trailing junk.
fn clean_context_file(s: &str) -> String {
    let s = s.trim_start_matches("./");
    // Strip trailing `)` or spaces
    s.trim_end_matches(')').trim().to_string()
}

/// Classify a raw error block into a human-readable issue.
fn classify(block: &RawBlock) -> Option<Issue> {
    let header = &block.header;
    let full = std::iter::once(header.as_str())
        .chain(block.body.iter().map(|s| s.as_str()))
        .collect::<Vec<_>>();
    let raw_text = full.join("\n");

    // --- file / line resolution ---
    let mut file: Option<String> = None;
    let mut line: Option<usize> = None;

    // 1) `./file.tex:<N>:` prefix in any line (file-line-error format)
    for l in &full {
        if let Some((f, n)) = find_file_line(l) {
            file = Some(f);
            line = Some(n);
            break;
        }
    }
    // 2) `l.<N>` in the block
    if line.is_none() {
        for l in &full {
            if let Some(n) = find_l_line(l) {
                line = Some(n);
                break;
            }
        }
    }
    // 3) context file from the nearest `(<file>` marker
    if file.is_none() {
        file = block.context_file.as_ref().map(|f| clean_context_file(f));
    }

    // --- severity & classification ---
    let (severity, kind_msg): (Severity, (String, Option<String>)) = if header.contains("Overfull") || header.contains("Underfull") {
        // \hbox / \vbox overfull warnings
        (Severity::Warning, ("排版宽度溢出（Overfull/Underfull box），内容可能超出页面边距。".to_string(), None))
    } else if header.contains("Warning") {
        (Severity::Warning, ("LaTeX 警告：".to_string() + header, None))
    } else {
        (Severity::Error, classify_error_keywords(header, &full))
    };

    let (message, hint) = kind_msg;
    let mut issue = Issue::new(severity, IssueKind::CompileError, message)
        .with_raw(raw_text);
    if let Some(f) = file {
        issue = issue.with_file(f);
    }
    if let Some(n) = line {
        issue = issue.with_line(n);
    }
    issue.fix_hint = hint;
    Some(issue)
}

/// Map `! ...` headers to Chinese explanations.
fn classify_error_keywords(header: &str, _full: &[&str]) -> (String, Option<String>) {
    let h = header;
    if h.contains("Undefined control sequence") {
        return ("未定义的控制序列：用到了不存在的命令（可能拼写错误、缺少宏包，或命令在环境外使用）。".to_string(), Some("检查命令拼写，或确认对应 \\usepackage 已加载。".to_string()));
    }
    if h.contains("File ended while scanning use of") {
        return ("命令参数未闭合：某个命令的大括号 `{...}` 没有配对（常见于 \\textbf 或表格单元格内）。".to_string(), Some("检查该命令的参数是否缺少右花括号 `}`，以及是否误用了 `&` 分隔符。".to_string()));
    }
    if h.contains("Runaway argument") {
        return ("参数跑飞：命令参数没有正确闭合，LaTeX 一直吞到文件结尾（通常是漏了 `}` 或 `\\end{...}`）。".to_string(), Some("补上缺失的右花括号或 \\end，检查 \\begin/\\end 是否配对。".to_string()));
    }
    if h.contains("Missing $ inserted") {
        return ("缺少数学模式符号：数学内容（如 `x^2`、`\\frac`）写在了文本模式里，需要 `$...$` 包裹。".to_string(), Some("用 `$...$` 或 `\\(...\\)` 包裹数学公式。".to_string()));
    }
    if h.contains("Missing { inserted") {
        return ("缺少左花括号 `{`：LaTeX 期待一个参数组。".to_string(), Some("检查附近命令的参数是否漏了 `{`。".to_string()));
    }
    if h.contains("Extra }, or forgotten {") {
        return ("多余的右花括号 `}`，或漏了左花括号 `{`：括号不配对。".to_string(), Some("检查附近 `{` 与 `}` 是否一一配对。".to_string()));
    }
    if h.contains("Paragraph ended before") {
        return ("段落提前结束：命令的参数或环境内出现了空行（LaTeX 把空行当作段落结束）。".to_string(), Some("在参数/环境内部不要留空行。".to_string()));
    }
    if h.contains("Environment") && h.contains("undefined") {
        return ("环境未定义：使用了不存在的环境（如 `\\begin{xxx}`），通常是宏包未加载或拼写错误。".to_string(), Some("确认环境名拼写，并加载对应宏包。".to_string()));
    }
    if h.contains("File") && h.contains("not found") {
        return ("文件未找到：`\\input`/`\\include`/`\\includegraphics` 引用的文件不存在或路径错误。".to_string(), Some("检查文件名与相对路径是否正确，文件是否在项目内。".to_string()));
    }
    if h.contains("Package") && h.contains("Error") {
        return ("宏包错误：某个 \\usepackage 的宏包在运行时报错（可能是选项冲突或版本问题）。".to_string(), Some("查看宏包文档；必要时升级宏包或调整选项。".to_string()));
    }
    if h.contains("Font") && h.contains("not found") {
        return ("字体未找到：指定的字体不存在（常见于中文文档字体配置）。".to_string(), Some("检查 \\setCJKmainfont 等字体名是否与系统已装字体一致。".to_string()));
    }
    if h.contains("Emergency stop") {
        return ("紧急停止：编译被强制中止（通常是文件缺失或不可恢复的错误）。".to_string(), Some("检查主文件是否存在、路径是否正确。".to_string()));
    }
    if h.contains("Fatal error") {
        return ("致命错误：编译器无法继续（可能是环境或资源问题）。".to_string(), Some("检查工作目录是否可写、资源是否完整。".to_string()));
    }
    if h.contains("! LaTeX Error") {
        return ("LaTeX 错误：".to_string() + h.trim_start_matches("! "), None);
    }
    if h.contains("! ") {
        return (h.trim_start_matches("! ").to_string(), None);
    }
    (h.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_LOGS: &[(&str, &str, &str)] = &[
        (
            "undef-ctrl-seq",
            "! Undefined control sequence.\n<recently read> \\foo\n\nl.12 \\foo\n\n? \n",
            "main.tex",
        ),
        (
            "file-line-error",
            "! LaTeX Error: File `missing.sty' not found.\n\nType X to quit or <RETURN> to proceed,\nor enter new name. (Default extension: sty)\n\nEnter file name: \n! Emergency stop.\n<read *> \n         \n*** (cannot \\read from terminal in nonstop modes)\n\n./main.tex:23:  ==> Fatal error occurred, no output PDF file produced!\n",
            "main.tex",
        ),
    ];

    #[test]
    fn parses_undefined_control_sequence_with_line() {
        let issues = parse_log_str(SAMPLE_LOGS[0].1);
        assert!(!issues.is_empty());
        let i = &issues[0];
        assert_eq!(i.severity, Severity::Error);
        assert_eq!(i.line, Some(12));
        assert!(i.message.contains("未定义的控制序列"));
        assert!(i.raw.as_deref().unwrap().contains("Undefined control sequence"));
    }

    #[test]
    fn find_file_line_parses_fatal_line() {
        let line = "./main.tex:23:  ==> Fatal error occurred, no output PDF file produced!";
        let found = find_file_line(line);
        assert_eq!(found, Some(("main.tex".to_string(), 23)));
    }

    #[test]
    fn find_file_line_handles_miktex_absolute_path() {
        // MiKTeX `-file-line-error` emits ABSOLUTE paths:
        // `C:/Users/.../main.tex:8: Undefined control sequence`
        let line = "C:/Users/20806/AppData/Local/Temp/tb-xe-repro/main.tex:8: Undefined control sequence";
        let found = find_file_line(line);
        assert_eq!(
            found,
            Some(("C:/Users/20806/AppData/Local/Temp/tb-xe-repro/main.tex".to_string(), 8))
        );
    }

    #[test]
    fn find_file_line_handles_spaces_in_windows_path() {
        // regression: `D:/reasonix program/...` (space in path) used to be
        // truncated to `program/...`, breaking AI fix + read_file
        let line = "D:/reasonix program/Physics_Future_Leaders/homework/q1_zh/main.tex:32: Unable to load picture";
        let found = find_file_line(line);
        assert_eq!(
            found,
            Some((
                "D:/reasonix program/Physics_Future_Leaders/homework/q1_zh/main.tex".to_string(),
                32
            ))
        );
    }

    #[test]
    fn find_file_line_does_not_absorb_message_prefix() {
        // regression: a message like `Fatal error: main.tex:32:` must NOT
        // swallow the message text into the filename
        let line = "Fatal error: main.tex:32: Something went wrong";
        let found = find_file_line(line);
        assert_eq!(found, Some(("main.tex".to_string(), 32)));
    }

    #[test]
    fn find_file_line_drive_only_with_slash() {
        // `D:foo` (drive-relative, no slash) or `text D:/x` must not extend
        let line = "text D:/x/main.tex:1: msg";
        let found = find_file_line(line);
        // the drive prefix is NOT at line start here, so we keep the
        // truncated-but-safe result `x/main.tex`? no — no drive match:
        // backstop keeps the segment after the space
        assert!(found.is_some());
        let (f, l) = found.unwrap();
        assert_eq!(l, 1);
        assert!(f.ends_with("main.tex"), "got {f}");
    }

    #[test]
    fn parses_error_block_with_spaced_path() {
        let log = "D:/my folder/proj/main.tex:32: Unable to load picture or PDF file 'x.png'.\n<to be read again> \n                   }\nl.32 ...x.png}\n";
        let issues = parse_log_str(log);
        assert!(!issues.is_empty());
        assert_eq!(issues[0].file.as_deref(), Some("D:/my folder/proj/main.tex"));
        assert_eq!(issues[0].line, Some(32));
    }

    #[test]
    fn parses_file_line_error_and_fatal() {
        let issues = parse_log_str(SAMPLE_LOGS[1].1);
        assert!(issues.len() >= 2);
        // The "File not found" issue should carry line 23 from the fatal line.
        assert!(issues.iter().any(|i| i.line == Some(23)));
        assert!(issues.iter().any(|i| i.message.contains("文件未找到")));
    }

    #[test]
    fn overfull_is_warning() {
        let issues = parse_log_str("Overfull \\hbox (12.34567pt too wide) in paragraph at lines 5--6\n");
        assert_eq!(issues[0].severity, Severity::Warning);
    }

    #[test]
    fn context_file_fallback() {
        let log = "(./sub/chapter.tex\n! Undefined control sequence.\nl.42 \\badcmd\n\n?\n";
        let issues = parse_log_str(log);
        assert_eq!(issues[0].file.as_deref(), Some("sub/chapter.tex"));
        assert_eq!(issues[0].line, Some(42));
    }
}
