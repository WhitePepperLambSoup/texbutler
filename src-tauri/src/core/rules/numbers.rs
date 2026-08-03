//! Rule `numbers`: floating-point garbage like `87.30000000000001%` in
//! generated Chinese reports (Python/JS `%`-formatting artifacts).
//! Detection: `\d+\.\d{10,}` (10+ digits after the dot). Numbers are never
//! this precise in prose — always round first.

use super::{Rule, is_in_comment};
use crate::core::{Issue, IssueKind, Severity};

pub struct NumbersRule;

impl Rule for NumbersRule {
    fn id(&self) -> &'static str {
        "numbers"
    }
    fn name(&self) -> &'static str {
        "浮点垃圾数字"
    }

    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        for (idx, line) in src.lines().enumerate() {
            let bytes = line.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                // find a digit run
                if !bytes[i].is_ascii_digit() {
                    i += 1;
                    continue;
                }
                let start = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                // expect a dot followed by >=10 digits
                if i < bytes.len() && bytes[i] == b'.' {
                    let mut j = i + 1;
                    let mut frac_len = 0usize;
                    while j < bytes.len() && bytes[j].is_ascii_digit() {
                        frac_len += 1;
                        j += 1;
                    }
                    if frac_len >= 10 && !is_in_comment(line, start) {
                        let num = &line[start..j];
                        let rounded = round_display(num);
                        issues.push(
                            Issue::new(
                                Severity::Error,
                                IssueKind::RuleCheck,
                                format!("浮点垃圾数字 `{num}`：小数位多达 {frac_len} 位，几乎肯定是程序生成时未 round 造成的（如 `87.30000000000001%`）。"),
                            )
                            .with_file(file)
                            .with_line(idx + 1)
                            .with_col(start + 1)
                            .with_rule("numbers", format!("改为 `{rounded}`（保留 2 位小数）或先 round 再输出。")),
                        );
                        i = j;
                        continue;
                    }
                    i = j;
                    continue;
                }
            }
        }
    }
}

/// Round a decimal string like `87.30000000000001` to 2 decimals.
fn round_display(num: &str) -> String {
    let v: f64 = num.parse().unwrap_or(0.0);
    let r = (v * 100.0).round() / 100.0;
    // trim trailing zeros
    let mut s = format!("{r:.2}");
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        NumbersRule.check(src, "t.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_garbage() {
        let issues = check("正确率 87.30000000000001%");
        assert_eq!(issues.len(), 1);
        assert!(issues[0].fix_hint.as_deref().unwrap().contains("87.3"));
    }

    #[test]
    fn does_not_flag_normal_numbers() {
        let issues = check("分数 87.3，比例 0.5，日期 2026.06.18");
        assert!(issues.is_empty());
    }

    #[test]
    fn does_not_flag_comments() {
        let issues = check("% 87.30000000000001 在注释里\n正文 87.30000000000001");
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn rounding_works() {
        assert_eq!(round_display("87.30000000000001"), "87.3");
        assert_eq!(round_display("1.2345678901"), "1.23");
        assert_eq!(round_display("99.9999999999"), "100");
    }
}
