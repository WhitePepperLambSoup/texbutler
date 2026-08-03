//! Rule `color`: mixed-color syntax like `blue!60` (requires the `xcolor`
//! package) used without loading xcolor. `color` (the base package) does
//! NOT support the `!` mixing syntax — documents silently degrade or error.

use super::{Rule, is_in_comment};
use crate::core::{Issue, IssueKind, Severity};

pub struct ColorRule;

impl Rule for ColorRule {
    fn id(&self) -> &'static str {
        "color"
    }
    fn name(&self) -> &'static str {
        "混色语法缺 xcolor"
    }

    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        let mut has_xcolor = false;
        let mut has_mixing = false;
        let mut first_mix: Option<(usize, usize)> = None; // (line, col)

        for (idx, line) in src.lines().enumerate() {
            // detect \usepackage[..]{xcolor}
            if !has_xcolor && line.contains("\\usepackage") && line.contains("xcolor") {
                has_xcolor = true;
            }
            // detect color mixing: `name!<number>` (e.g. blue!60)
            if !has_mixing {
                let bytes = line.as_bytes();
                let mut i = 0;
                while i + 1 < bytes.len() {
                    if bytes[i] == b'!' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                        // check previous char is a letter (color name)
                        if i > 0 && bytes[i - 1].is_ascii_alphabetic() {
                            if !is_in_comment(line, i) {
                                has_mixing = true;
                                first_mix = Some((idx + 1, i + 1));
                                break;
                            }
                        }
                    }
                    i += 1;
                }
            }
        }

        if has_mixing && !has_xcolor {
            let (line, col) = first_mix.unwrap_or((0, 0));
            issues.push(
                Issue::new(
                    Severity::Error,
                    IssueKind::RuleCheck,
                    "使用了 `颜色!比例` 混色语法（如 `blue!60`），但文档没有加载 `xcolor` 宏包——基础 `color` 宏包不支持混色，编译会失败或颜色不生效。",
                )
                .with_file(file)
                .with_line(line)
                .with_col(col)
                .with_rule("color", "在导言区添加 `\\usepackage{xcolor}`（需在 hyperref 之前加载）。"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        ColorRule.check(src, "t.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_mixing_without_xcolor() {
        let issues = check("\\documentclass{article}\n\\definecolor{myblue}{RGB}{0,0,255}\n\\color{myblue!60}文本\n");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].line, Some(3));
    }

    #[test]
    fn no_flag_when_xcolor_loaded() {
        let issues = check("\\usepackage{xcolor}\n\\color{blue!60}文本\n");
        assert!(issues.is_empty());
    }

    #[test]
    fn no_flag_on_plain_colors() {
        let issues = check("\\usepackage{color}\n\\color{red}文本\n");
        assert!(issues.is_empty());
    }
}
