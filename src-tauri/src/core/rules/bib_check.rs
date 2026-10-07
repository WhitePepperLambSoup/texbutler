//! Bibliography checks (GB/T 7714 aware). Two rules:
//!
//! * `bib_fields` — missing required fields per entry type, GB/T 7714
//!   requirements (publisher place, volume/issue, pages, access date of
//!   online resources), malformed years and duplicate keys. These need real
//!   bibliographic data, so they are reported only — never "fixed" by
//!   inventing publishers or dates.
//! * `bib_format` — mechanical mistakes with a safe deterministic fix:
//!   authors separated by `，` `、` `;` (or commas between Chinese names)
//!   instead of `and`, and DOI fields carrying a URL prefix.
//!
//! The GB/T-specific checks only run when the project uses a GB/T 7714
//! style (`gbt7714` package / bst, biblatex `gb7714-2015`).

use crate::core::rules::{contains_cjk, ProjectCtx};
use crate::core::{Issue, IssueKind, Severity};

/// One parsed `.bib` field with the byte range of its value (inside the
/// braces / quotes) and its 1-based line.
#[derive(Debug, Clone)]
pub struct BibField {
    pub name: String,
    pub value: String,
    pub value_start: usize,
    pub value_end: usize,
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct BibRecord {
    pub entry_type: String,
    pub key: String,
    pub line: usize,
    pub fields: Vec<BibField>,
}

impl BibRecord {
    pub fn field(&self, name: &str) -> Option<&BibField> {
        self.fields.iter().find(|f| f.name == name && !f.value.trim().is_empty())
    }
    fn has(&self, names: &[&str]) -> bool {
        names.iter().any(|n| self.field(n).is_some())
    }
}

fn line_of(src: &str, offset: usize) -> usize {
    src[..offset].matches('\n').count() + 1
}

/// Parse entries with positions. Tolerant: malformed entries are skipped.
pub fn parse_records(src: &str) -> Vec<BibRecord> {
    let bytes = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = src[i..].find('@') {
        let at = i + rel;
        let mut j = at + 1;
        while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
            j += 1;
        }
        let entry_type = src[at + 1..j].to_ascii_lowercase();
        let mut k = j;
        while k < bytes.len() && bytes[k].is_ascii_whitespace() {
            k += 1;
        }
        if entry_type.is_empty() || k >= bytes.len() || (bytes[k] != b'{' && bytes[k] != b'(') {
            i = at + 1;
            continue;
        }
        let (open, close) = if bytes[k] == b'{' { (b'{', b'}') } else { (b'(', b')') };
        // find the end of the entry (delimiter depth)
        let body_start = k + 1;
        let mut depth = 1;
        let mut e = body_start;
        while e < bytes.len() && depth > 0 {
            if bytes[e] == open {
                depth += 1;
            } else if bytes[e] == close {
                depth -= 1;
            }
            e += 1;
        }
        if depth != 0 {
            break;
        }
        let body_end = e - 1;
        if matches!(entry_type.as_str(), "comment" | "string" | "preamble") {
            i = e;
            continue;
        }
        let Some(comma) = src[body_start..body_end].find(',') else {
            i = e;
            continue;
        };
        let key = src[body_start..body_start + comma].trim().to_string();
        let fields = parse_fields(src, body_start + comma + 1, body_end);
        if !key.is_empty() {
            out.push(BibRecord { entry_type, key, line: line_of(src, at), fields });
        }
        i = e;
    }
    out
}

fn parse_fields(src: &str, start: usize, end: usize) -> Vec<BibField> {
    let bytes = src.as_bytes();
    let mut fields = Vec::new();
    let mut i = start;
    loop {
        while i < end && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
            i += 1;
        }
        if i >= end {
            break;
        }
        let name_start = i;
        while i < end && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'_' | b'-' | b':' | b'.')) {
            i += 1;
        }
        let name = src[name_start..i].to_ascii_lowercase();
        while i < end && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if name.is_empty() || i >= end || bytes[i] != b'=' {
            // not a field: skip to the next comma at depth 0
            while i < end && bytes[i] != b',' {
                i += 1;
            }
            continue;
        }
        i += 1;
        while i < end && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= end {
            break;
        }
        let line = line_of(src, name_start);
        let (vs, ve, next) = match bytes[i] {
            b'{' => {
                let mut depth = 1;
                let mut m = i + 1;
                while m < end && depth > 0 {
                    match bytes[m] {
                        b'{' => depth += 1,
                        b'}' => depth -= 1,
                        _ => {}
                    }
                    m += 1;
                }
                (i + 1, m.saturating_sub(1).max(i + 1), m)
            }
            b'"' => {
                let mut m = i + 1;
                let mut depth = 0;
                while m < end && !(bytes[m] == b'"' && depth == 0) {
                    match bytes[m] {
                        b'{' => depth += 1,
                        b'}' => depth -= 1,
                        _ => {}
                    }
                    m += 1;
                }
                (i + 1, m, (m + 1).min(end))
            }
            _ => {
                let mut m = i;
                while m < end && bytes[m] != b',' && bytes[m] != b'\n' {
                    m += 1;
                }
                (i, m, m)
            }
        };
        let ve = ve.min(end).max(vs);
        fields.push(BibField { name, value: src[vs..ve].to_string(), value_start: vs, value_end: ve, line });
        i = next;
        // skip string concatenation `# {...}` remnants up to the next comma
        while i < end && bytes[i] != b',' {
            i += 1;
        }
    }
    fields
}

/// Required fields per entry type: each inner slice is one requirement
/// satisfied by any of its alternatives.
fn required(entry_type: &str) -> &'static [&'static [&'static str]] {
    match entry_type {
        "article" => &[&["author"], &["title"], &["journal", "journaltitle"], &["year", "date"]],
        "book" | "inbook" => &[&["author", "editor"], &["title"], &["publisher"], &["year", "date"]],
        "incollection" => &[&["author"], &["title"], &["booktitle"], &["publisher"], &["year", "date"]],
        "inproceedings" | "conference" => &[&["author"], &["title"], &["booktitle"], &["year", "date"]],
        "proceedings" | "collection" => &[&["title"], &["year", "date"]],
        "phdthesis" | "mastersthesis" | "thesis" => &[&["author"], &["title"], &["school", "institution"], &["year", "date"]],
        "techreport" | "report" => &[&["author"], &["title"], &["institution"], &["year", "date"]],
        "patent" => &[&["author"], &["title"], &["number"], &["year", "date"]],
        "standard" => &[&["title"], &["year", "date"]],
        "newspaper" => &[&["title"], &["journal", "journaltitle"], &["year", "date"]],
        "online" | "electronic" | "webpage" | "www" => &[&["title"], &["url"]],
        "unpublished" => &[&["author"], &["title"]],
        "manual" | "misc" => &[&["title"]],
        _ => &[],
    }
}

/// True when the project uses a GB/T 7714 bibliography style.
pub fn uses_gbt7714(files: &[(String, String)]) -> bool {
    files.iter().any(|(_, c)| {
        c.contains("{gbt7714") || c.contains("gbt7714-") || c.contains("gb7714-2015") || c.contains("{gbt7714}")
    })
}

const AUTHOR_FIELDS: [&str; 2] = ["author", "editor"];

/// Author list problem: (fixable separators present, ambiguous comma list).
fn author_problem(value: &str) -> (bool, bool) {
    let has_and = value.contains(" and ") || value.contains("\nand ");
    if has_and {
        return (false, false);
    }
    let cjk = contains_cjk(value);
    let fixable = value.contains(['，', '、', ';', '；']) || (cjk && value.contains(','));
    // "Smith, John, Doe, Jane": Last, First pairs without `and`
    let ambiguous = !fixable && value.matches(',').count() > 1;
    (fixable, ambiguous)
}

fn split_authors(value: &str) -> String {
    let cjk = contains_cjk(value);
    value
        .split(|c: char| matches!(c, '，' | '、' | ';' | '；') || (cjk && c == ','))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" and ")
}

const DOI_PREFIXES: [&str; 5] = ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi:"];

fn doi_prefix_len(value: &str) -> Option<usize> {
    let low = value.trim_start().to_ascii_lowercase();
    DOI_PREFIXES.iter().find(|p| low.starts_with(*p)).map(|p| p.len() + (value.len() - value.trim_start().len()))
}

/// Deterministic fix for `bib_format` issues: rewrite author separators and
/// strip DOI URL prefixes in the whole `.bib` source.
pub fn fix_bib_format(src: &str) -> Option<String> {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for rec in parse_records(src) {
        for f in &rec.fields {
            if AUTHOR_FIELDS.contains(&f.name.as_str()) && author_problem(&f.value).0 {
                edits.push((f.value_start, f.value_end, split_authors(&f.value)));
            }
            if f.name == "doi" {
                if let Some(n) = doi_prefix_len(&f.value) {
                    edits.push((f.value_start, f.value_end, f.value[n..].trim().to_string()));
                }
            }
        }
    }
    if edits.is_empty() {
        return None;
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut out = src.to_string();
    for (s, e, text) in edits {
        out.replace_range(s..e, &text);
    }
    Some(out)
}

fn issue(sev: Severity, rule: &str, file: &str, line: usize, msg: String, hint: String) -> Issue {
    Issue::new(sev, IssueKind::RuleCheck, msg).with_file(file).with_line(line).with_rule(rule, hint)
}

/// Mechanical formatting rule with an automatic fix.
pub struct BibFormatRule;

impl super::Rule for BibFormatRule {
    fn id(&self) -> &'static str {
        "bib_format"
    }
    fn name(&self) -> &'static str {
        "参考文献著录格式（作者分隔 / DOI）"
    }
    fn check(&self, _src: &str, _file: &str, _issues: &mut Vec<Issue>) {}
    fn check_project(&self, ctx: &ProjectCtx, issues: &mut Vec<Issue>) {
        for (file, src) in &ctx.bibs {
            for rec in parse_records(src) {
                for f in &rec.fields {
                    if AUTHOR_FIELDS.contains(&f.name.as_str()) && author_problem(&f.value).0 {
                        issues.push(issue(
                            Severity::Warning,
                            "bib_format",
                            file,
                            f.line,
                            format!("文献 `{}` 的 {} 字段用 `，` `、` `;` 或逗号分隔多位作者，BibTeX 会把它们当成一个人。", rec.key, f.name),
                            format!("多位作者之间用 ` and ` 分隔：{}", split_authors(&f.value)),
                        ));
                    }
                    if f.name == "doi" && doi_prefix_len(&f.value).is_some() {
                        issues.push(issue(
                            Severity::Suggestion,
                            "bib_format",
                            file,
                            f.line,
                            format!("文献 `{}` 的 doi 字段带有网址前缀，参考文献表中会重复显示 `https://doi.org/`。", rec.key),
                            "doi 字段只保留 `10.xxxx/...` 部分".to_string(),
                        ));
                    }
                }
            }
        }
    }
}

/// Field completeness / GB/T 7714 requirements (report only).
pub struct BibFieldsRule;

impl super::Rule for BibFieldsRule {
    fn id(&self) -> &'static str {
        "bib_fields"
    }
    fn name(&self) -> &'static str {
        "参考文献必备字段（GB/T 7714）"
    }
    fn check(&self, _src: &str, _file: &str, _issues: &mut Vec<Issue>) {}
    fn check_project(&self, ctx: &ProjectCtx, issues: &mut Vec<Issue>) {
        let gb = uses_gbt7714(&ctx.files);
        let mut seen: Vec<(String, String, usize)> = Vec::new();
        for (file, src) in &ctx.bibs {
            for rec in parse_records(src) {
                let push = |issues: &mut Vec<Issue>, sev: Severity, line: usize, msg: String, hint: &str| {
                    issues.push(issue(sev, "bib_fields", file, line, msg, hint.to_string()));
                };
                // duplicate keys
                if let Some((_, pf, pl)) = seen.iter().find(|(k, _, _)| *k == rec.key) {
                    push(
                        issues,
                        Severity::Warning,
                        rec.line,
                        format!("文献键 `{}` 重复定义（{pf}:{pl} 已有同名条目），引用会指向不确定的条目。", rec.key),
                        "删除重复条目或给其中一条换一个键（可在编辑器里对 \\cite 的键按 F2 重命名）",
                    );
                } else {
                    seen.push((rec.key.clone(), file.clone(), rec.line));
                }
                let missing: Vec<&str> = required(&rec.entry_type)
                    .iter()
                    .filter(|alts| !rec.has(alts))
                    .map(|alts| alts[0])
                    .collect();
                if !missing.is_empty() {
                    push(
                        issues,
                        Severity::Warning,
                        rec.line,
                        format!("文献 `{}`（@{}）缺少必备字段：{}。", rec.key, rec.entry_type, missing.join("、")),
                        "按原始文献补全这些字段（不要凭空填写）",
                    );
                }
                for f in &rec.fields {
                    if AUTHOR_FIELDS.contains(&f.name.as_str()) && author_problem(&f.value).1 {
                        push(
                            issues,
                            Severity::Warning,
                            f.line,
                            format!("文献 `{}` 的作者列表没有用 `and` 分隔（\"{}\"），BibTeX 无法区分多位作者。", rec.key, f.value.chars().take(60).collect::<String>()),
                            "写成 `Smith, John and Doe, Jane` 的形式",
                        );
                    }
                }
                if let Some(y) = rec.field("year") {
                    let v = y.value.trim();
                    let chars: Vec<char> = v.chars().collect();
                    // "2020", "2020a" (same-author disambiguation)
                    let ok = chars.len() >= 4
                        && chars[..4].iter().all(|c| c.is_ascii_digit())
                        && chars[4..].iter().all(|c| c.is_ascii_lowercase());
                    if !ok {
                        push(issues, Severity::Warning, y.line, format!("文献 `{}` 的年份 `{v}` 不是四位数字。", rec.key), "year 字段只写四位年份，如 2024");
                    }
                }
                if !gb {
                    continue;
                }
                let t = rec.entry_type.as_str();
                if t == "article" && !rec.has(&["volume", "number"]) {
                    push(issues, Severity::Suggestion, rec.line, format!("GB/T 7714：期刊文献 `{}` 缺少卷（volume）或期（number）。", rec.key), "补全卷、期信息");
                }
                if matches!(t, "article" | "inproceedings" | "incollection" | "inbook") && !rec.has(&["pages"]) {
                    push(issues, Severity::Suggestion, rec.line, format!("GB/T 7714：文献 `{}` 缺少起止页码（pages）。", rec.key), "补全页码，如 pages = {12--20}");
                }
                if matches!(t, "book" | "inbook" | "incollection" | "phdthesis" | "mastersthesis" | "thesis" | "proceedings")
                    && !rec.has(&["address", "location"])
                {
                    push(issues, Severity::Warning, rec.line, format!("GB/T 7714：文献 `{}`（@{t}）缺少出版地（address）。", rec.key), "补全出版地，如 address = {北京}");
                }
                if rec.has(&["url"]) && !rec.has(&["urldate"]) {
                    push(issues, Severity::Warning, rec.line, format!("GB/T 7714：电子资源 `{}` 缺少引用日期（urldate）。", rec.key), "补全访问日期，如 urldate = {2024-05-01}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::rules::Rule;

    const BIB: &str = r#"@article{zhang2020,
  author = {张三, 李四、王五},
  title = {中文文献},
  journal = {计算机学报},
  year = {2020},
  doi = {https://doi.org/10.1000/xyz}
}
@book{knuth,
  author = "Knuth, Donald E.",
  title = {The TeXbook},
  year = {1984}
}
@online{web,
  title = {Site},
  url = {https://example.org}
}
@article{bad,
  author = {Smith, John, Doe, Jane},
  title = {X}, journal = {J}, year = {20xx}, volume = {1}, pages = {1--2}
}
@article{knuth, title = {Dup}, author = {A}, journal = {B}, year = {2001}}
"#;

    fn ctx(gb: bool) -> ProjectCtx {
        let style = if gb { "\\bibliographystyle{gbt7714-numerical}" } else { "\\bibliographystyle{plain}" };
        ProjectCtx { files: vec![("main.tex".into(), style.into())], bib_keys: vec![], bibs: vec![("refs.bib".into(), BIB.into())] }
    }

    #[test]
    fn parses_fields_with_positions() {
        let recs = parse_records(BIB);
        assert_eq!(recs.len(), 5);
        assert_eq!(recs[0].key, "zhang2020");
        assert_eq!(recs[0].field("author").unwrap().line, 2);
        assert_eq!(recs[1].field("author").unwrap().value, "Knuth, Donald E.");
        assert_eq!(recs[3].field("year").unwrap().value, "20xx");
        let f = recs[0].field("journal").unwrap();
        assert_eq!(&BIB[f.value_start..f.value_end], "计算机学报");
    }

    #[test]
    fn format_rule_flags_separators_and_doi_and_fix_repairs_them() {
        let mut issues = Vec::new();
        BibFormatRule.check_project(&ctx(false), &mut issues);
        assert_eq!(issues.len(), 2, "{issues:#?}");
        let fixed = fix_bib_format(BIB).unwrap();
        assert!(fixed.contains("author = {张三 and 李四 and 王五}"));
        assert!(fixed.contains("doi = {10.1000/xyz}"));
        assert!(fixed.contains("author = \"Knuth, Donald E.\""), "a single Last, First author is untouched");
        let mut again = Vec::new();
        BibFormatRule.check_project(
            &ProjectCtx { files: vec![], bib_keys: vec![], bibs: vec![("refs.bib".into(), fixed.clone())] },
            &mut again,
        );
        assert!(again.is_empty(), "fix is complete: {again:#?}");
        assert!(fix_bib_format(&fixed).is_none(), "idempotent");
    }

    #[test]
    fn fields_rule_reports_missing_duplicates_years_and_ambiguous_authors() {
        let mut issues = Vec::new();
        BibFieldsRule.check_project(&ctx(false), &mut issues);
        let msgs: Vec<&str> = issues.iter().map(|i| i.message.as_str()).collect();
        assert!(msgs.iter().any(|m| m.contains("`knuth`（@book）缺少必备字段：publisher")), "{msgs:#?}");
        assert!(msgs.iter().any(|m| m.contains("`knuth` 重复定义")));
        assert!(msgs.iter().any(|m| m.contains("`20xx`")));
        assert!(msgs.iter().any(|m| m.contains("`bad` 的作者列表没有用 `and`")));
        assert!(!msgs.iter().any(|m| m.contains("GB/T")), "no GB/T checks without the style");
    }

    #[test]
    fn gbt7714_checks_only_with_the_style() {
        let mut issues = Vec::new();
        BibFieldsRule.check_project(&ctx(true), &mut issues);
        let msgs: Vec<&str> = issues.iter().map(|i| i.message.as_str()).collect();
        assert!(msgs.iter().any(|m| m.contains("`knuth`（@book）缺少出版地")), "{msgs:#?}");
        assert!(msgs.iter().any(|m| m.contains("`web` 缺少引用日期")));
        assert!(msgs.iter().any(|m| m.contains("`zhang2020` 缺少卷")));
        assert!(msgs.iter().any(|m| m.contains("`zhang2020` 缺少起止页码")));
        assert!(!msgs.iter().any(|m| m.contains("`bad` 缺少卷")), "bad has a volume");
    }
}
