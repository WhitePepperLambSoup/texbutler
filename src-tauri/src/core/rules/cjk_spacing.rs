//! Rule `cjk_spacing`: Chinese typography — a space should sit between CJK
//! characters and adjacent ASCII letters (中文English → 中文 English).
//! Numbers are exempt (`第2章`, `图1` are normal usage) and math is not
//! touched (inside `$...$` the spacing is intentional).
//! The deterministic fix inserts the missing space.

use crate::core::{Issue, IssueKind, Severity};
use super::Rule;

pub struct CjkSpacingRule;

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
        | 0x20000..=0x2A6DF | 0x2F800..=0x2FA1F // CJK ext + compatibility
        | 0x3000..=0x303F | 0xFF00..=0xFFEF // CJK punctuation + fullwidth
    )
}

fn is_ascii_letter(c: char) -> bool {
    c.is_ascii_alphabetic()
}

fn is_math_region(line: &str, char_idx: usize) -> bool {
    // crude: count unescaped $ before idx — odd count means inside math
    let mut dollars = 0;
    for (i, c) in line.chars().enumerate() {
        if i >= char_idx {
            break;
        }
        if c == '$' {
            dollars += 1;
        }
    }
    dollars % 2 == 1
}

impl Rule for CjkSpacingRule {
    fn id(&self) -> &'static str {
        "cjk_spacing"
    }
    fn name(&self) -> &'static str {
        "中文排版（CJK 与英文间距）"
    }
    fn default_enabled(&self) -> bool {
        true
    }
    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        for (i, raw_line) in src.lines().enumerate() {
            let line_no = i + 1;
            let line = raw_line.trim_end();
            let chars: Vec<char> = line.chars().collect();
            for j in 1..chars.len() {
                let prev = chars[j - 1];
                let cur = chars[j];
                if is_math_region(line, j) {
                    continue;
                }
                let boundary = (is_cjk(prev) && is_ascii_letter(cur))
                    || (is_ascii_letter(prev) && is_cjk(cur));
                if !boundary {
                    continue;
                }
                // skip when a command/backslash follows or precedes
                if cur == '\\' || prev == '\\' {
                    continue;
                }
                issues.push(
                    Issue::new(
                        Severity::Info,
                        IssueKind::RuleCheck,
                        format!(
                            "中英文之间建议加空格（第 {line_no} 行：{} 与 {} 相邻）：中文排版规范要求 CJK 字符与 ASCII 字母之间留半角空格。",
                            prev, cur
                        ),
                    )
                    .with_file(file)
                    .with_line(line_no)
                    .with_rule("cjk_spacing", "在中文与英文之间插入一个空格"),
                );
            }
        }
    }
}

/// Deterministic fix: insert spaces between CJK and ASCII letters.
pub fn fix_cjk_spacing(src: &str) -> String {
    let mut out = String::with_capacity(src.len() + 32);
    for (i, line) in src.lines().enumerate() {
        let chars: Vec<char> = line.chars().collect();
        let mut result = String::with_capacity(line.len() + 8);
        for (j, &c) in chars.iter().enumerate() {
            result.push(c);
            if j + 1 < chars.len() {
                let next = chars[j + 1];
                let boundary = (is_cjk(c) && is_ascii_letter(next))
                    || (is_ascii_letter(c) && is_cjk(next));
                if boundary && !is_math_region(line, j) && c != '\\' && next != '\\' {
                    result.push(' ');
                }
            }
        }
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&result);
    }
    // preserve a trailing newline if the source had one
    if src.ends_with('\n') {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        CjkSpacingRule.check(src, "main.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_missing_space_between_cjk_and_ascii() {
        let issues = check("中文English混合\n");
        assert_eq!(issues.len(), 2, "{issues:?}"); // 文E and h混
        assert!(issues[0].message.contains("第 1 行"));
    }

    #[test]
    fn does_not_flag_cjk_number_mix() {
        let issues = check("第2章 图1 展示\n");
        assert_eq!(issues.len(), 0, "{issues:?}");
    }

    #[test]
    fn does_not_flag_math_region() {
        let issues = check("公式 $E_p = mc^2$ 结束\n");
        assert_eq!(issues.len(), 0, "{issues:?}");
    }

    #[test]
    fn does_not_flag_proper_spacing() {
        let issues = check("中文 English 正常\n");
        assert_eq!(issues.len(), 0, "{issues:?}");
    }

    #[test]
    fn fix_inserts_spaces() {
        let fixed = fix_cjk_spacing("中文English混合\n");
        assert_eq!(fixed, "中文 English 混合\n");
    }

    #[test]
    fn fix_skips_math_and_numbers() {
        let fixed = fix_cjk_spacing("第2章 公式 $E_p$ 与LaTeX\n");
        assert_eq!(fixed, "第2章 公式 $E_p$ 与 LaTeX\n");
    }
}
