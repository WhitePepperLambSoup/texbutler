//! Rule `italic`: `\textit{...}` / `\emph{...}` wrapping CJK text.
//! Most Chinese fonts have no real italic face — the text renders upright
//! or fake-slanted. Recommend `\textbf` / `{\bfseries ...}` instead.

use super::{Rule, contains_cjk};
use crate::core::{Issue, IssueKind, Severity};

pub struct ItalicRule;

impl Rule for ItalicRule {
    fn id(&self) -> &'static str {
        "italic"
    }
    fn name(&self) -> &'static str {
        "\\textit/\\emph 包含中文"
    }

    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>) {
        for (idx, line) in src.lines().enumerate() {
            let mut pos = 0;
            while pos < line.len() {
                let Some(rel) = find_command(line, pos, &["textit", "emph"]) else {
                    break;
                };
                // find the opening `{`
                let brace = line[rel.end..].find('{').map(|b| rel.end + b);
                let Some(brace) = brace else {
                    pos = rel.end;
                    continue;
                };
                // simple scan to the first unescaped `}` (nested braces rare)
                let mut depth = 1usize;
                let mut end = brace + 1;
                let mut content_end = end;
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
                            content_end = end;
                            break;
                        }
                    }
                    end += 1;
                }
                let content = &line[brace + 1..content_end];
                if contains_cjk(content) {
                    issues.push(
                        Issue::new(
                            Severity::Warning,
                            IssueKind::RuleCheck,
                            "中文字体没有真正的斜体：`\\textit`/`\\emph` 包中文在多数中文字体下不生效或显示为假倾斜。建议改用 `\\textbf` 或 `{\\bfseries ...}`。",
                        )
                        .with_file(file)
                        .with_line(idx + 1)
                        .with_col(brace + 1)
                        .with_rule("italic", format!("将 `\\{}` 替换为 `\\textbf` 或 `{{\\bfseries {}}}`", rel.name, content)),
                    );
                }
                pos = end.max(content_end + 1);
            }
        }
    }
}

struct Found {
    name: &'static str,
    end: usize,
}

/// Find the next `\textit` or `\emph` (not `\textitext` style false hits:
/// require a `{` or whitespace right after the command name).
fn find_command(line: &str, from: usize, names: &[&'static str]) -> Option<Found> {
    let mut best: Option<Found> = None;
    for name in names {
        let pat = format!("\\{}", name);
        let mut search = from;
        while let Some(rel) = line[search..].find(&pat) {
            let start = search + rel;
            let end = start + pat.len();
            // boundary check: next char must be `{` or whitespace
            if let Some(next) = line[end..].chars().next() {
                if next == '{' || next.is_whitespace() {
                    let cand = Found { name, end };
                    best = match best {
                        Some(b) if b.end <= cand.end => Some(cand),
                        Some(b) => Some(b),
                        None => Some(cand),
                    };
                    break;
                }
            }
            search = end;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(src: &str) -> Vec<Issue> {
        let mut issues = Vec::new();
        ItalicRule.check(src, "t.tex", &mut issues);
        issues
    }

    #[test]
    fn flags_chinese_textit() {
        let issues = check("这是\\textit{重要结论}的测试\n");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].line, Some(1));
    }

    #[test]
    fn flags_emph_with_cjk() {
        let issues = check("\\emph{中文强调}\n");
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn does_not_flag_ascii_italic() {
        let issues = check("\\textit{hello world}\n");
        assert!(issues.is_empty());
    }

    #[test]
    fn flags_multiple_on_line() {
        let issues = check("\\textit{甲} 和 \\textit{乙}\n");
        assert_eq!(issues.len(), 2);
    }
}
