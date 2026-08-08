//! Chinese-LaTeX rule engine. Every rule scans raw `.tex` source and emits
//! `Issue`s. Rules are registered in a table so new ones can be added
//! without touching the engine (extensibility is a hard requirement).

pub mod bold;
pub mod bom;
pub mod cjk_spacing;
pub mod color;
pub mod float;
pub mod italic;
pub mod missing_end;
pub mod numbers;
pub mod paragraph;
pub mod percent;
pub mod refs;

use crate::core::{Issue, Severity};

/// Project-level context for cross-file rules (dangling refs/cites).
pub struct ProjectCtx {
    /// (relative path, content) for every `.tex` file in the project.
    pub files: Vec<(String, String)>,
    /// Every bib key found in the project's `.bib` files.
    pub bib_keys: Vec<String>,
}

/// A single check over one source file.
pub trait Rule: Send + Sync {
    /// Stable id used for rule toggles in settings (e.g. "percent").
    fn id(&self) -> &'static str;
    /// Human-readable name shown in the settings UI.
    fn name(&self) -> &'static str;
    /// Default enabled state.
    fn default_enabled(&self) -> bool {
        true
    }
    /// Run the check, appending findings to `issues`.
    fn check(&self, src: &str, file: &str, issues: &mut Vec<Issue>);
    /// Project-wide check (cross-file rules). Default: no-op.
    fn check_project(&self, _ctx: &ProjectCtx, _issues: &mut Vec<Issue>) {}
}

/// Build the registry of all rules. Add new rules here.
pub fn all_rules() -> Vec<Box<dyn Rule>> {
    vec![
        Box::new(percent::PercentRule),
        Box::new(italic::ItalicRule),
        Box::new(bold::BoldRule),
        Box::new(float::FloatRule),
        Box::new(color::ColorRule),
        Box::new(numbers::NumbersRule),
        Box::new(paragraph::ParagraphRule),
        Box::new(missing_end::MissingEndRule),
        Box::new(bom::BomRule),
        Box::new(refs::RefsRule),
        Box::new(cjk_spacing::CjkSpacingRule),
    ]
}

/// Get one rule by id.
pub fn rule_by_id(id: &str) -> Option<Box<dyn Rule>> {
    all_rules().into_iter().find(|r| r.id() == id)
}

/// Check a source file with the enabled rules.
///
/// * `enabled`: map of rule id -> enabled (missing = default).
/// * Files larger than 2 MiB are skipped chunk-wise per the perf rule
///   (the check is line-based so we can stream, but we keep it simple and
///   skip files that are unreasonably large).
pub fn check_source(
    src: &str,
    file: &str,
    enabled: &dyn Fn(&str) -> bool,
    issues: &mut Vec<Issue>,
) {
    if src.len() > 2 * 1024 * 1024 {
        issues.push(
            Issue::new(
                Severity::Info,
                crate::core::IssueKind::RuleCheck,
                "文件超过 2 MiB，已跳过规则检查（性能保护）。",
            )
            .with_file(file),
        );
        return;
    }
    for rule in all_rules() {
        if enabled(rule.id()) {
            rule.check(src, file, issues);
        }
    }
}

/// Run project-wide checks (cross-file rules like dangling refs/cites).
pub fn check_project(ctx: &ProjectCtx, enabled: &dyn Fn(&str) -> bool, issues: &mut Vec<Issue>) {
    for rule in all_rules() {
        if enabled(rule.id()) {
            rule.check_project(ctx, issues);
        }
    }
}

/// Helper: true if the character at `pos` in `line` is part of a `%` comment.
/// Returns (is_comment, comment_start_index).
pub fn comment_start(line: &str) -> Option<usize> {
    let mut escaped = false;
    for (i, c) in line.char_indices() {
        if c == '\\' {
            // skip escaped \% and doubled backslashes correctly enough
            let prev = line[..i].chars().last();
            if prev != Some('\\') {
                escaped = true;
                continue;
            }
            escaped = false;
            continue;
        }
        if c == '%' && !escaped {
            return Some(i);
        }
        escaped = false;
    }
    None
}

/// True when the char at byte index `idx` in `line` is inside a comment.
pub fn is_in_comment(line: &str, idx: usize) -> bool {
    match comment_start(line) {
        Some(c) => idx >= c,
        None => false,
    }
}

/// Check whether a string contains any CJK unified ideograph.
pub fn contains_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c,
            '\u{4E00}'..='\u{9FFF}'   // CJK Unified Ideographs
            | '\u{3400}'..='\u{4DBF}' // Extension A
            | '\u{F900}'..='\u{FAFF}' // Compatibility Ideographs
            | '\u{3000}'..='\u{303F}' // CJK punctuation
            | '\u{FF00}'..='\u{FFEF}' // Fullwidth forms
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comment_detection() {
        assert_eq!(comment_start("text % comment"), Some(5));
        assert_eq!(comment_start("100\\% done"), None);
        assert_eq!(comment_start("a \\% b % c"), Some(7));
        assert_eq!(comment_start("no comment here"), None);
    }

    #[test]
    fn registry_has_eleven_rules() {
        let rules = all_rules();
        assert_eq!(rules.len(), 11);
        let ids: Vec<_> = rules.iter().map(|r| r.id()).collect();
        for expected in [
            "percent",
            "italic",
            "bold",
            "float",
            "color",
            "numbers",
            "paragraph",
            "missing_end",
            "bom",
            "refs",
        ] {
            assert!(ids.contains(&expected), "missing rule {}", expected);
        }
    }

    #[test]
    fn check_source_respects_toggles() {
        let src = "71% 的用户喜欢这个产品\n";
        let mut issues = Vec::new();
        check_source(src, "a.tex", &|id| id != "percent", &mut issues);
        assert!(issues.is_empty(), "percent rule should be disabled");
        check_source(src, "a.tex", &|_| true, &mut issues);
        assert!(!issues.is_empty());
    }
}
