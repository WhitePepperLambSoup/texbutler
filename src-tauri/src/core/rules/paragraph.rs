//! Rule `paragraph`: two consecutive non-empty source text lines with NO
//! blank line between them get merged into one paragraph by LaTeX — a
//! common cause of "text that should be two paragraphs looking glued".
//!
//! To keep false positives low we only flag pairs of *plain prose lines*:
//! both lines contain CJK or latin letters/digits, and neither looks like
//! a table row (`&`), a list item, a command-only line, or a comment.

use super::{Rule, contains_cjk};
use crate::core::{Issue, IssueKind, Severity};

pub struct ParagraphRule;

impl Rule for ParagraphRule {
    fn id(&self) -> &'static str {
        "paragraph"
    }
    fn name(&self) -> &'static str {
        "相邻正文行未空行"
    }

    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        let lines: Vec<&str> = src.lines().collect();
        let mut prev_text: Option<(usize, &str)> = None; // (line_no, text)
        // Contiguous gluing pairs merge into chains (start, end): a
        // document written one-sentence-per-line with no blank lines
        // produces HUNDREDS of identical warnings — consolidate each
        // continuous run into a single issue (user request).
        let mut chains: Vec<(usize, usize)> = Vec::new();
        for (idx, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            let line_no = idx + 1;

            if trimmed.is_empty() {
                prev_text = None;
                continue;
            }
            // skip comments (whole-line) and pure LaTeX command lines
            if trimmed.starts_with('%') {
                prev_text = None;
                continue;
            }
            let is_prose = is_prose_line(trimmed);
            if !is_prose {
                prev_text = None;
                continue;
            }
            if let Some((prev_no, prev)) = prev_text {
                // adjacent prose lines -> possible paragraph gluing
                // heuristic: a blank line was probably intended between two
                // "sentence-like" lines; only report if neither is short
                if prev.chars().count() >= 4 && trimmed.chars().count() >= 4 {
                    if let Some((_, last_end)) = chains.last_mut() {
                        if *last_end == prev_no {
                            *last_end = line_no; // extend the chain
                            prev_text = Some((line_no, trimmed));
                            continue;
                        }
                    }
                    chains.push((prev_no, line_no));
                }
            }
            prev_text = Some((line_no, trimmed));
        }
    for (start, end) in chains {
        let mut msg = format!(
            "第 {start} 至 {end} 行之间存在段落粘连（{} 处相邻正文行缺少空行），LaTeX 会把它们合并为同一段落。若需分段，请在每对相邻行之间补一个空行。",
            end - start
        );
        if end == start + 1 {
            msg = format!(
                "第 {start} 行与第 {end} 行之间没有空行：LaTeX 会把它们合并为同一段落（段落粘连）。若这是两段，请在中间补一个空行。"
            );
        }
        issues.push(
                Issue::new(Severity::Info, IssueKind::RuleCheck, msg)
                    .with_file(file)
                    .with_line(start)
                    .with_rule("paragraph", "在相邻正文行之间插入空行（一键修复可批量处理）。"),
            );
        }
    }
}

/// Heuristic: is this line "prose" (not a command-only / table / list line)?
/// `pub` so the deterministic paragraph fix (fix_loop) can reuse the exact
/// same definition — the fixer and the rule must agree on what a prose
/// line is.
pub fn is_prose_line(line: &str) -> bool {
    if line.starts_with("\\item") {
        return false; // list item
    }
    if line.starts_with('\\') {
        // structural command lines like \section{..} / \label{..} are not
        // prose: strip the command name, then balanced `{...}` groups, and
        // see what remains (e.g. `\textbf{中文}后面文字` IS prose).
        let body = &line[1..];
        let cmd_end = body
            .find(|c: char| !c.is_ascii_alphabetic() && c != '@')
            .unwrap_or(body.len());
        let mut rest = &body[cmd_end..];
        loop {
            let trimmed = rest.trim_start();
            if trimmed.starts_with('[') {
                // optional argument group, e.g. \includegraphics[width=..]{..}
                match trimmed.find(']') {
                    Some(idx) => rest = &trimmed[idx + 1..],
                    None => return false,
                }
            } else if trimmed.starts_with('{') {
                match trimmed.find('}') {
                    Some(idx) => rest = &trimmed[idx + 1..],
                    None => return false,
                }
            } else {
                break;
            }
        }
        let rem = rest.trim();
        if rem.is_empty() || rem.starts_with('\\') || rem.starts_with("item") {
            return false;
        }
        return contains_cjk(rem) || rem.chars().any(|c| c.is_ascii_alphanumeric());
    }
    if line.contains('&') {
        return false; // table row
    }
    contains_cjk(line) || line.chars().any(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        ParagraphRule.check(src, "t.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_glued_prose() {
        let issues = check("第一段文字内容。\n第二段文字内容。\n");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].line, Some(1));
        assert!(issues[0].message.contains("空行"));
    }

    #[test]
    fn consolidates_long_runs_into_one_chain() {
        // ten adjacent prose lines with no blank lines must produce ONE
        // consolidated issue (previously: nine identical warnings)
        let src = (1..=10).map(|i| format!("第 {i} 句正文文字内容。")).collect::<Vec<_>>().join("\n");
        let issues = check(&format!("{src}\n"));
        assert_eq!(issues.len(), 1, "run must consolidate: {issues:?}");
        assert_eq!(issues[0].line, Some(1));
        assert!(issues[0].message.contains("至 10 行"), "chain range: {}", issues[0].message);
        assert!(issues[0].message.contains("9 处"), "count: {}", issues[0].message);
    }

    #[test]
    fn separate_chains_stay_separate() {
        // two independent gluing spots separated by a blank line -> 2 issues
        let issues = check("第一段文字内容。\n第二段文字内容。\n\n第三段文字内容。\n第四段文字内容。\n");
        assert_eq!(issues.len(), 2, "{issues:?}");
        assert_eq!(issues[0].line, Some(1));
        assert_eq!(issues[1].line, Some(4));
    }

    #[test]
    fn does_not_flag_proper_paragraphs() {
        let issues = check("第一段文字内容。\n\n第二段文字内容。\n");
        assert!(issues.is_empty());
    }

    #[test]
    fn does_not_flag_table_rows() {
        let issues = check("a & b \\\\\nc & d \\\\\n");
        assert!(issues.is_empty());
    }

    #[test]
    fn does_not_flag_command_lines() {
        let issues = check("\\section{标题}\n\\label{sec:x}\n");
        assert!(issues.is_empty());
    }

    #[test]
    fn does_not_flag_includegraphics_with_optional_args() {
        let issues = check("\\includegraphics[width=0.8\\linewidth]{fig.png}\n\\caption{图注}\n");
        assert!(issues.is_empty(), "command + optional args are not prose: {:?}", issues);
    }
}
