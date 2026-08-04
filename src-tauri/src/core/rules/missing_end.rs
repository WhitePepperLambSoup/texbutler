//! Rule `missing_end`: the document has `\begin{document}` but no matching
//! `\end{document}`. The PDF is silently truncated or TeX errors out with
//! "File ended while scanning" style messages.

use super::{Rule, is_in_comment};
use crate::core::{Issue, IssueKind, Severity};

pub struct MissingEndRule;

impl Rule for MissingEndRule {
    fn id(&self) -> &'static str {
        "missing_end"
    }
    fn name(&self) -> &'static str {
        "缺 \\end{document}"
    }

    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        // only count \begin/\end{document} occurrences outside `%` comments
        let in_code = |l: &str, needle: &str| -> bool {
            l.find(needle).map(|i| !is_in_comment(l, i)).unwrap_or(false)
        };
        let has_begin = src.lines().any(|l| in_code(l, "\\begin{document}"));
        let has_end = src.lines().any(|l| in_code(l, "\\end{document}"));
        if has_begin && !has_end {
            issues.push(
                Issue::new(
                    Severity::Error,
                    IssueKind::RuleCheck,
                    "文档有 `\\begin{document}` 但没有 `\\end{document}`：PDF 会在中途被截断或编译报错。",
                )
                .with_file(file)
                .with_rule("missing_end", "在文件末尾补上 `\\end{document}`。"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        MissingEndRule.check(src, "t.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_missing_end() {
        let issues = check("\\begin{document}\n内容\n");
        assert_eq!(issues.len(), 1);
        assert!(issues[0].message.contains("\\end{document}"));
    }

    #[test]
    fn no_flag_when_closed() {
        let issues = check("\\begin{document}\n内容\n\\end{document}\n");
        assert!(issues.is_empty());
    }

    #[test]
    fn no_flag_without_document_env() {
        let issues = check("\\section{裸章节}\n");
        assert!(issues.is_empty());
    }

    #[test]
    fn commented_out_end_document_does_not_count() {
        // a commented `\end{document}` must NOT satisfy the check
        let issues = check("\\begin{document}\n内容\n% \\end{document}\n");
        assert_eq!(issues.len(), 1, "missing real \\end{{document}}: {:?}", issues);
    }
}
