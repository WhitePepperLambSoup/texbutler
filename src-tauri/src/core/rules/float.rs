//! Rule `float`: `\begin{figure/table}[ht]` — floats with placement
//! specifiers other than `[H]` drift to other chapters or interrupt text
//! mid-paragraph in Chinese documents (LaTeX's float algorithm is
//! language-agnostic but CJK line breaking makes displacement very visible).
//! Recommend `\usepackage{float}` + `[H]` for "keep it exactly here".

use super::Rule;
use crate::core::{Issue, IssueKind, Severity};

pub struct FloatRule;

impl Rule for FloatRule {
    fn id(&self) -> &'static str {
        "float"
    }
    fn name(&self) -> &'static str {
        "浮动体 [ht] 可能错位"
    }

    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        for (idx, line) in src.lines().enumerate() {
            // match \begin{figure} / \begin{table} / starred variants
            let mut pos = 0;
            while pos < line.len() {
                let Some(rel) = line[pos..].find("\\begin{") else {
                    break;
                };
                let start = pos + rel;
                let rest = &line[start + 7..];
                let env_end = rest.find('}').map(|e| start + 7 + e);
                let Some(env_end) = env_end else {
                    break;
                };
                let env = &line[start + 7..env_end];
                let is_float = env == "figure" || env == "table" || env == "figure*" || env == "table*";
                if !is_float {
                    pos = env_end + 1;
                    continue;
                }
                // look for the optional placement argument
                let after = &line[env_end + 1..];
                if let Some(br) = after.find('[') {
                    let close = after[br..].find(']').map(|c| br + c);
                    if let Some(close) = close {
                        let spec = &after[br + 1..close];
                        let has_h = spec.contains('H');
                        let only_safe = spec == "H" || spec == "H!" || spec == "!H";
                        if !has_h && !only_safe && !spec.is_empty() {
                            let col = env_end + 1 + br + 1;
                            issues.push(
                                Issue::new(
                                    Severity::Info,
                                    IssueKind::RuleCheck,
                                    format!(
                                        "浮动体 `\\begin{{{env}}}[{spec}]` 可能浮动到其他章节或插进段落中间。若希望图表固定在本位置，建议 `\\usepackage{{float}}` 并改用 `[H]`。"
                                    ),
                                )
                                .with_file(file)
                                .with_line(idx + 1)
                                .with_col(col)
                                .with_rule("float", format!("将 `[{spec}]` 改为 `[H]`，并在导言区加 `\\usepackage{{float}}`。")),
                            );
                        }
                        pos = env_end + 1 + close + 1;
                        continue;
                    }
                }
                pos = env_end + 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        FloatRule.check(src, "t.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_ht() {
        let issues = check("\\begin{figure}[ht]\n\\end{figure}\n");
        assert_eq!(issues.len(), 1);
        assert!(issues[0].fix_hint.as_deref().unwrap().contains("[H]"));
    }

    #[test]
    fn flags_t() {
        let issues = check("\\begin{table}[t]\n\\end{table}\n");
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn does_not_flag_h() {
        let issues = check("\\begin{figure}[H]\n\\end{figure}\n");
        assert!(issues.is_empty());
    }

    #[test]
    fn does_not_flag_other_environments() {
        let issues = check("\\begin{tabular}{cc}\na & b \\\\\n\\end{tabular}\n");
        assert!(issues.is_empty());
    }
}
