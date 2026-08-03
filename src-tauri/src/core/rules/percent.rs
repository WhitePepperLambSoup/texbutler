//! Rule `percent`: bare `%` that looks like a percentage (e.g. `71% `) is
//! almost certainly a *mistaken comment* in Chinese documents — `%` is the
//! LaTeX comment character, so the rest of the line silently disappears.
//!
//! Detection: a `%` whose previous non-space char is a digit and whose next
//! char is a letter / digit / space / CJK — report as Suggestion to escape
//! it as `\%`. Pure ASCII comments (`% this is a comment`) are NOT flagged.

use super::{Rule, contains_cjk};
use crate::core::{Issue, IssueKind, Severity};

pub struct PercentRule;

impl Rule for PercentRule {
    fn id(&self) -> &'static str {
        "percent"
    }
    fn name(&self) -> &'static str {
        "裸 % 疑似百分号误当注释"
    }

    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        for (idx, line) in src.lines().enumerate() {
            let bytes = line.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                let c = bytes[i] as char;
                if c == '\\' {
                    // skip the escaped char (covers \% and others)
                    i += 1;
                    if i < bytes.len() {
                        i += 1;
                    }
                    continue;
                }
                if c != '%' {
                    i += 1;
                    continue;
                }
                // previous char: must be a digit (allow a space between)
                let prev = if i > 0 { bytes[i - 1] as char } else { '\0' };
                let prev_is_digit = prev.is_ascii_digit()
                    || (prev == ' ' && i > 1 && (bytes[i - 2] as char).is_ascii_digit());
                if !prev_is_digit {
                    i += 1;
                    continue;
                }
                // next char: letter / digit / space / CJK punctuation
                let next = if i + 1 < bytes.len() { bytes[i + 1] as char } else { '\0' };
                let next_ok = next.is_ascii_alphanumeric() || next == ' ' || next == '（' || next == '(';
                // check CJK after the percent (multi-byte)
                let rest = &line[i + 1..];
                let next_cjk = rest.chars().next().map(contains_cjk_char).unwrap_or(false);
                if next_ok || next_cjk {
                    // character column (1-based), not byte index
                    let col = line[..i].chars().count() + 1;
                    issues.push(
                        Issue::new(
                            Severity::Suggestion,
                            IssueKind::RuleCheck,
                            "疑似百分号被当成注释：`%` 在 LaTeX 中是注释符，本行后半段会被静默吞掉。建议写成 `\\%`。",
                        )
                        .with_file(file)
                        .with_line(idx + 1)
                        .with_col(col)
                        .with_rule("percent", "将 `%` 转义为 `\\%`（如 `71\\%`）。"),
                    );
                    // continue scanning the rest of the line after this char
                    i += 1;
                    continue;
                }
                i += 1;
            }
        }
    }
}

fn contains_cjk_char(c: char) -> bool {
    contains_cjk(&c.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        PercentRule.check(src, "t.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_percentage_with_trailing_text() {
        let issues = check("正确率 71% 的用户\n");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].line, Some(1));
        assert_eq!(issues[0].col, Some(7));
        assert!(issues[0].fix_hint.as_deref().unwrap().contains("\\%"));
    }

    #[test]
    fn flags_digit_percent_digit() {
        let issues = check("增长 5%以上\n");
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn does_not_flag_real_comments() {
        let issues = check("% 这是整行注释\n\\section{标题} % 行尾注释\n");
        assert!(issues.is_empty(), "comments must not be flagged: {:?}", issues);
    }

    #[test]
    fn does_not_flag_escaped_percent() {
        let issues = check("进度 71\\% 完成\n");
        assert!(issues.is_empty());
    }
}
