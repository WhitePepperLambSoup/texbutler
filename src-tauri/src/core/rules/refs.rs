//! Rule 10: dangling references — `\ref{key}` without a matching `\label`
//! and `\cite{key}` without a matching `.bib` entry. This is the single
//! most painful LaTeX authoring bug, and it is checked project-wide
//! (`check_project`) in addition to the per-file `check`.

use crate::core::rules::{comment_start, is_in_comment, ProjectCtx};
use crate::core::{Issue, IssueKind, Severity};

/// Commands whose argument is a `\label` key.
const REF_COMMANDS: &[&str] = &["ref", "pageref", "eqref", "autoref", "nameref", "cref"];
/// Commands whose argument is a `.bib` key.
const CITE_COMMANDS: &[&str] = &["cite", "citep", "citet", "parencite", "textcite", "citealp", "citeauthor", "citenum", "nocite"];

pub struct RefsRule;

impl super::Rule for RefsRule {
    fn id(&self) -> &'static str {
        "refs"
    }

    fn name(&self) -> &'static str {
        "悬空引用（\\ref/\\cite 匹配检查）"
    }

    /// Per-file check: `\ref` family vs labels defined in this file.
    /// `\cite` needs the whole project's bib files, so it is done in
    /// `check_project` instead.
    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        let labels = collect_labels(src);
        for (cmd, key, line, col) in collect_cmd_args(src, REF_COMMANDS) {
            if !labels.iter().any(|l| l == &key) {
                issues.push(
                    Issue::new(
                        Severity::Warning,
                        IssueKind::RuleCheck,
                        format!("`\\{cmd}{{{key}}}` 在本文件未找到对应 `\\label{{{key}}}`（可能在其它文件，项目级检查会确认）。"),
                    )
                    .with_file(file)
                    .with_line(line)
                    .with_col(col)
                    .with_rule("refs", format!("补一个 `\\label{{{key}}}`，或确认引用键名拼写。")),
                );
            }
        }
    }

    /// Project-wide check: every `\ref`/`\cite` vs all labels and bib keys,
    /// duplicate `\label` keys, and user macros that are never used.
    fn check_project(&self, ctx: &ProjectCtx, issues: &mut Vec<Issue>) {
        let mut labels: Vec<String> = Vec::new();
        for (_, content) in &ctx.files {
            labels.extend(collect_labels(content));
        }
        // duplicate labels: the same key defined twice breaks cross-refs
        let mut seen: Vec<(String, String, usize)> = Vec::new();
        for (file, content) in &ctx.files {
            for (_cmd, key, line, _col) in collect_cmd_args(content, &["label"]) {
                if let Some((_prev_key, prev_file, prev_line)) = seen.iter().find(|(k, _, _)| *k == key) {
                    issues.push(
                        Issue::new(
                            Severity::Warning,
                            IssueKind::RuleCheck,
                            format!("`\\label{{{key}}}` 重复定义（{prev_file}:{prev_line} 已有同名 label），`\\ref{{{key}}}` 会指向不确定目标。"),
                        )
                        .with_file(file.clone())
                        .with_line(line)
                        .with_rule("refs", format!("重命名其中一个 `\\label{{{key}}}` 并同步所有引用。")),
                    );
                } else {
                    seen.push((key, file.clone(), line));
                }
            }
        }
        // user macros defined but never used anywhere in the project
        let mut defs: Vec<(String, String, usize)> = Vec::new();
        for (file, content) in &ctx.files {
            for (idx, l) in content.lines().enumerate() {
                let trimmed = l.trim_start();
                let Some(rest) = trimmed
                    .strip_prefix("\\newcommand{\\")
                    .or_else(|| trimmed.strip_prefix("\\renewcommand{\\"))
                    .or_else(|| trimmed.strip_prefix("\\providecommand{\\"))
                else {
                    continue;
                };
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '@')
                    .collect();
                if !name.is_empty() {
                    defs.push((file.clone(), name, idx + 1));
                }
            }
        }
        let all_sources: String = ctx
            .files
            .iter()
            .map(|(_, c)| c.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        for (file, name, line) in &defs {
            let usage = format!("\\{name}");
            // the definition line itself contains the name once
            if all_sources.matches(&usage).count() <= 1 {
                issues.push(
                    Issue::new(
                        Severity::Warning,
                        IssueKind::RuleCheck,
                        format!("自定义宏 `\\{name}` 定义了但从未在项目中使用，建议删除或补上用途。"),
                    )
                    .with_file(file.clone())
                    .with_line(*line)
                    .with_rule("refs", format!("删除 `\\newcommand{{\\{name}}}` 或在正文中使用 `\\{name}`。")),
                );
            }
        }
        for (file, content) in &ctx.files {
            for (cmd, key, line, col) in collect_cmd_args(content, REF_COMMANDS) {
                if !labels.iter().any(|l| *l == key) {
                    issues.push(
                        Issue::new(
                            Severity::Error,
                            IssueKind::RuleCheck,
                            format!("`\\{cmd}{{{key}}}` 悬空：项目中没有任何 `\\label{{{key}}}`（编译会报 undefined reference）。"),
                        )
                        .with_file(file.clone())
                        .with_line(line)
                        .with_col(col)
                        .with_rule("refs", format!("补一个 `\\label{{{key}}}`，或修正引用键名。")),
                    );
                }
            }
            for (cmd, key, line, col) in collect_cmd_args(content, CITE_COMMANDS) {
                if !ctx.bib_keys.iter().any(|k| k == &key) {
                    issues.push(
                        Issue::new(
                            Severity::Warning,
                            IssueKind::RuleCheck,
                            format!("`\\{cmd}{{{key}}}` 悬空：bib 文件中没有条目 `{key}`（编译会警告 undefined citation）。"),
                        )
                        .with_file(file.clone())
                        .with_line(line)
                        .with_col(col)
                        .with_rule("refs", format!("在 .bib 中补一个 `{key}` 条目，或修正引用键名。")),
                    );
                }
            }
        }
    }
}

/// Collect every `\label{key}` in a source file.
fn collect_labels(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (_cmd, key, _line, _col) in collect_cmd_args(src, &["label"]) {
        if !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// Public label index for autocompletion: `(key, 1-based line)` pairs.
pub fn scan_labels(src: &str) -> Vec<(String, usize)> {
    collect_cmd_args(src, &["label"])
        .into_iter()
        .map(|(_cmd, key, line, _col)| (key, line))
        .collect()
}

/// Scan a source file for `\cmd{...}` occurrences (single-line only, like
/// the other rules), skipping comments. Returns (command, first-argument,
/// 1-based line, 1-based column).
fn collect_cmd_args(src: &str, cmds: &[&str]) -> Vec<(String, String, usize, usize)> {
    let mut out = Vec::new();
    for (line_idx, line) in src.lines().enumerate() {
        let Some(comment_at) = comment_start(line) else {
            scan_line(line, cmds, line_idx + 1, &mut out);
            continue;
        };
        scan_line(&line[..comment_at], cmds, line_idx + 1, &mut out);
        let _ = is_in_comment; // keep the import used for future multi-line handling
    }
    out
}

fn scan_line(line: &str, cmds: &[&str], line_no: usize, out: &mut Vec<(String, String, usize, usize)>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        let cmd_start = i + 1;
        let mut j = cmd_start;
        while j < bytes.len() && (bytes[j].is_ascii_alphabetic() || bytes[j] == b'@') {
            j += 1;
        }
        let cmd = &line[cmd_start..j];
        if cmds.contains(&cmd) {
            // skip whitespace and optional args like \cite[p. 5]{key}
            let mut k = j;
            while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                k += 1;
            }
            if k < bytes.len() && bytes[k] == b'[' {
                // skip balanced optional argument
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
                while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                    k += 1;
                }
            }
            if k < bytes.len() && bytes[k] == b'{' {
                let mut depth = 1;
                let mut m = k + 1;
                while m < bytes.len() && depth > 0 {
                    match bytes[m] {
                        b'{' => depth += 1,
                        b'}' => depth -= 1,
                        _ => {}
                    }
                    m += 1;
                }
                let raw = line.get(k + 1..m.saturating_sub(1)).unwrap_or("");
                // multi-key cites: \cite{a,b} — check each key
                for key in raw.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    out.push((cmd.to_string(), key.to_string(), line_no, k + 1));
                }
            }
        }
        i = j.max(i + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::rules::Rule;

    fn run(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        RefsRule.check(src, "main.tex", &mut issues);
        issues
    }

    fn run_project(files: &[(&str, &str)], bib: &[&str]) -> Vec<Issue> {
        let mut issues = Vec::new();
        let files: Vec<(String, String)> = files.iter().map(|(p, c)| (p.to_string(), c.to_string())).collect();
        let bib_keys: Vec<String> = bib.iter().map(|s| s.to_string()).collect();
        let ctx = ProjectCtx { files, bib_keys };
        RefsRule.check_project(&ctx, &mut issues);
        issues
    }

    #[test]
    fn flags_duplicate_labels_project_wide() {
        let files = [
            ("a.tex", "\\label{sec:dup}\n正文"),
            ("b.tex", "\\label{sec:dup}\n另一个文件同样 label"),
        ];
        let bib: [&str; 0] = [];
        let issues = run_project(&files, &bib);
        assert!(issues.iter().any(|i| i.message.contains("重复定义")), "got: {:?}", issues.iter().map(|i| &i.message).collect::<Vec<_>>());
        // the report must name the FIRST file that defined the label
        let dup = issues.iter().find(|i| i.message.contains("重复定义")).expect("dup issue");
        assert!(dup.message.contains("a.tex"), "must name first file: {}", dup.message);
    }

    #[test]
    fn flags_unused_macro_but_allows_used() {
        let files = [
            ("a.tex", "\\newcommand{\\unusedmacro}{x}\n\\newcommand{\\usedmacro}{y}\n\\usedmacro 正文"),
        ];
        let bib: [&str; 0] = [];
        let issues = run_project(&files, &bib);
        assert!(issues.iter().any(|i| i.message.contains("unusedmacro")), "got: {:?}", issues.iter().map(|i| &i.message).collect::<Vec<_>>());
        assert!(!issues.iter().any(|i| i.message.contains("\\usedmacro`")), "used macro must not be flagged: {:?}", issues.iter().map(|i| &i.message).collect::<Vec<_>>());
    }

    #[test]
    fn unclosed_ref_with_cjk_does_not_panic() {
        // \ref{ never closed, followed by CJK: byte-slicing must not panic
        let src = "见 \\ref{中文未闭合\n下一行正文。\n";
        assert!(run(src).len() <= 1, "unclosed ref must not panic (0 or 1 issue)");
    }

    #[test]
    fn flags_dangling_ref_in_file() {
        let src = "见 \\ref{sec:intro}。\n\\label{sec:intro}\n";
        assert!(run(src).is_empty(), "ref matches label in the same file");
        let src2 = "见 \\ref{sec:missing}。\n";
        assert_eq!(run(src2).len(), 1);
    }

    #[test]
    fn flags_dangling_ref_project_wide() {
        // label lives in another file: single-file check flags it,
        // project check must not.
        let issues = run_project(&[("a.tex", "\\ref{sec:x}\n"), ("b.tex", "\\label{sec:x}\n")], &[]);
        assert!(issues.is_empty(), "project-wide label resolves across files");
        let issues2 = run_project(&[("a.tex", "\\ref{sec:gone}\n")], &[]);
        assert_eq!(issues2.len(), 1);
        assert_eq!(issues2[0].severity, Severity::Error);
    }

    #[test]
    fn flags_dangling_cite_against_bib() {
        let issues = run_project(&[("a.tex", "\\cite{knuth84}\n")], &["knuth84"]);
        assert!(issues.is_empty());
        let issues2 = run_project(&[("a.tex", "\\cite{ghost}\n")], &["knuth84"]);
        assert_eq!(issues2.len(), 1);
        assert_eq!(issues2[0].severity, Severity::Warning);
    }

    #[test]
    fn handles_multi_key_cites_and_optional_args() {
        let issues = run_project(&[("a.tex", "\\cite[p.~5]{a,b}\n\\citep{c}\n")], &["a", "b", "c"]);
        assert!(issues.is_empty());
        let issues2 = run_project(&[("a.tex", "\\cite{a,ghost}\n")], &["a"]);
        assert_eq!(issues2.len(), 1);
        assert_eq!(issues2[0].message.contains("ghost"), true);
    }

    #[test]
    fn ignores_refs_inside_comments() {
        let src = "% 参见 \\ref{sec:note}\n\\ref{sec:real}\n\\label{sec:real}\n";
        assert!(run(src).is_empty(), "commented ref must not be flagged");
    }

    #[test]
    fn eqref_and_cref_are_checked() {
        let src = "\\eqref{eq:1} \\cref{fig:2}\n\\label{eq:1}\n\\label{fig:2}\n";
        assert!(run(src).is_empty());
    }
}
