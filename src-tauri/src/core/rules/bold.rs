//! Rule `bold`: `\textbf{...}` whose argument contains `&`.
//! `&` is the table column separator — putting it inside `\textbf` triggers
//! the infamous `File ended while scanning use of \textbf` error. Use
//! `{\bfseries ...}` inside cells instead.

use super::Rule;
use crate::core::{Issue, IssueKind, Severity};

pub struct BoldRule;

impl Rule for BoldRule {
    fn id(&self) -> &'static str {
        "bold"
    }
    fn name(&self) -> &'static str {
        "\\textbf 参数内含 &"
    }

    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        for (idx, line) in src.lines().enumerate() {
            let mut pos = 0;
            while pos < line.len() {
                let Some(rel) = line[pos..].find("\\textbf") else {
                    break;
                };
                let start = pos + rel;
                let cmd_end = start + "\\textbf".len();
                // boundary: next char must be `{`
                let Some(next) = line[cmd_end..].chars().next() else {
                    break;
                };
                if next != '{' {
                    pos = cmd_end;
                    continue;
                }
                let brace = cmd_end;
                // scan to matching `}` (nested brace aware)
                let mut depth = 1usize;
                let mut end = brace + 1;
                let mut amp_pos: Option<usize> = None;
                while end < line.len() && depth > 0 {
                    let c = line.as_bytes()[end] as char;
                    if c == '\\' {
                        end += 2;
                        continue;
                    }
                    if c == '{' {
                        depth += 1;
                    } else if c == '}' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    } else if c == '&' && amp_pos.is_none() {
                        amp_pos = Some(end);
                    }
                    end += 1;
                }
                if let Some(amp) = amp_pos {
                    issues.push(
                        Issue::new(
                            Severity::Warning,
                            IssueKind::RuleCheck,
                            "`\\textbf` 参数内含 `&`（表格列分隔符）：这会触发 `File ended while scanning use of \\textbf` 编译错误。表格单元格内请改用 `{\\bfseries ...}`。",
                        )
                        .with_file(file)
                        .with_line(idx + 1)
                        .with_col(amp + 1)
                        .with_rule("bold", "将 `\\textbf{...}` 改为 `{\\bfseries ...}`（不吞 `&`）。"),
                    );
                }
                pos = end.max(brace + 1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        BoldRule.check(src, "t.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_amp_in_textbf() {
        let issues = check("\\textbf{名称 & 数值}\n");
        assert_eq!(issues.len(), 1);
        assert!(issues[0].message.contains("File ended while scanning"));
    }

    #[test]
    fn does_not_flag_plain_textbf() {
        let issues = check("\\textbf{没有与符号的加粗}\n");
        assert!(issues.is_empty());
    }

    #[test]
    fn does_not_flag_textbf_without_brace() {
        let issues = check("\\textbf 加粗（旧语法）\n");
        assert!(issues.is_empty());
    }
}
