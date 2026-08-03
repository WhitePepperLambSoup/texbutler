//! Rule `bom`: the file starts with a UTF-8 BOM (`\u{FEFF}`). Windows
//! editors save BOMs by default; LaTeX may mis-parse the first line
//! (`\documentclass` becomes garbage) or emit "Missing character" warnings.

use super::Rule;
use crate::core::{Issue, IssueKind, Severity};

pub struct BomRule;

impl Rule for BomRule {
    fn id(&self) -> &'static str {
        "bom"
    }
    fn name(&self) -> &'static str {
        "UTF-8 BOM 头"
    }

    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        if src.starts_with('\u{FEFF}') {
            issues.push(
                Issue::new(
                    Severity::Warning,
                    IssueKind::RuleCheck,
                    "文件以 UTF-8 BOM 开头：可能导致 `\\documentclass` 解析异常（如 `Missing character` 警告）。",
                )
                .with_file(file)
                .with_line(1)
                .with_col(1)
                .with_rule("bom", "保存为无 BOM 的 UTF-8（编辑器选择 UTF-8 without BOM）。"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        BomRule.check(src, "t.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_bom() {
        let issues = check("\u{FEFF}\\documentclass{article}\n");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].line, Some(1));
    }

    #[test]
    fn no_flag_without_bom() {
        let issues = check("\\documentclass{article}\n");
        assert!(issues.is_empty());
    }
}
