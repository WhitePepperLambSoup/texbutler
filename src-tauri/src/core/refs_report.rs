//! Project-wide label / reference / citation report: which labels are used,
//! which references point nowhere, which bibliography entries are never
//! cited and which citations have no entry. Deterministic, no AI.

use crate::core::rules::refs::scan_cmd_uses;
use serde::Serialize;
use std::collections::HashMap;

const REF_CMDS: [&str; 9] = ["ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref", "vref", "labelcref"];
const CITE_CMDS: [&str; 12] = [
    "cite", "citep", "citet", "parencite", "textcite", "autocite", "footcite", "citealp", "citealt", "citeauthor", "citeyear", "nocite",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Loc {
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LabelInfo {
    pub key: String,
    pub file: String,
    pub line: usize,
    /// Number of `\ref`-family uses.
    pub refs: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KeyUse {
    pub key: String,
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BibInfo {
    pub key: String,
    pub file: Option<String>,
    pub line: Option<usize>,
    pub title: String,
    /// Number of `\cite`-family uses.
    pub cites: usize,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct ReferenceReport {
    pub labels: Vec<LabelInfo>,
    /// `\ref{x}` whose label does not exist.
    pub undefined_refs: Vec<KeyUse>,
    /// Labels defined more than once (every occurrence listed).
    pub duplicate_labels: Vec<KeyUse>,
    pub bib: Vec<BibInfo>,
    /// `\cite{x}` with no bibliography entry.
    pub missing_cites: Vec<KeyUse>,
    /// True when the document uses `\nocite{*}` (every entry counts as cited).
    pub nocite_all: bool,
}

/// Build the report from `(rel path, content)` of the .tex sources and the
/// parsed bibliography (`(key, file, line, title)`).
pub fn build(tex: &[(String, String)], bib: &[(String, Option<String>, Option<usize>, String)]) -> ReferenceReport {
    let mut report = ReferenceReport::default();
    let mut label_defs: Vec<KeyUse> = Vec::new();
    let mut ref_uses: Vec<KeyUse> = Vec::new();
    let mut cite_uses: Vec<KeyUse> = Vec::new();
    for (file, content) in tex {
        for (_cmd, key, line) in scan_cmd_uses(content, &["label"]) {
            label_defs.push(KeyUse { key, file: file.clone(), line });
        }
        for (_cmd, key, line) in scan_cmd_uses(content, &REF_CMDS) {
            ref_uses.push(KeyUse { key, file: file.clone(), line });
        }
        for (_cmd, key, line) in scan_cmd_uses(content, &CITE_CMDS) {
            if key == "*" {
                report.nocite_all = true;
                continue;
            }
            cite_uses.push(KeyUse { key, file: file.clone(), line });
        }
    }

    let mut ref_count: HashMap<&str, usize> = HashMap::new();
    for r in &ref_uses {
        *ref_count.entry(r.key.as_str()).or_default() += 1;
    }
    let mut def_count: HashMap<&str, usize> = HashMap::new();
    for d in &label_defs {
        *def_count.entry(d.key.as_str()).or_default() += 1;
    }
    for d in &label_defs {
        if def_count[d.key.as_str()] > 1 {
            report.duplicate_labels.push(d.clone());
        }
    }
    let mut seen = std::collections::HashSet::new();
    for d in &label_defs {
        if seen.insert(d.key.clone()) {
            report.labels.push(LabelInfo {
                key: d.key.clone(),
                file: d.file.clone(),
                line: d.line,
                refs: ref_count.get(d.key.as_str()).copied().unwrap_or(0),
            });
        }
    }
    report.undefined_refs = ref_uses.into_iter().filter(|r| !def_count.contains_key(r.key.as_str())).collect();

    let mut cite_count: HashMap<&str, usize> = HashMap::new();
    for c in &cite_uses {
        *cite_count.entry(c.key.as_str()).or_default() += 1;
    }
    let bib_keys: std::collections::HashSet<&str> = bib.iter().map(|b| b.0.as_str()).collect();
    for (key, file, line, title) in bib {
        report.bib.push(BibInfo {
            key: key.clone(),
            file: file.clone(),
            line: *line,
            title: title.clone(),
            cites: cite_count.get(key.as_str()).copied().unwrap_or(0),
        });
    }
    report.missing_cites = cite_uses.into_iter().filter(|c| !bib_keys.contains(c.key.as_str())).collect();
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_finds_unused_undefined_duplicate_and_missing() {
        let tex = vec![
            (
                "main.tex".to_string(),
                "\\section{A}\\label{sec:a}\nSee \\ref{sec:a}, \\cref{sec:b} and \\eqref{eq:x}.\n\\cite{knuth,lamport}\n% \\ref{sec:commented}\n\\nocite{ghost}\n".to_string(),
            ),
            ("ch.tex".to_string(), "\\label{sec:b}\\label{fig:unused}\\label{sec:a}\n".to_string()),
        ];
        let bib = vec![
            ("knuth".to_string(), Some("refs.bib".to_string()), Some(1), "TeXbook".to_string()),
            ("unused".to_string(), Some("refs.bib".to_string()), Some(7), "Never cited".to_string()),
        ];
        let r = build(&tex, &bib);
        let label = |k: &str| r.labels.iter().find(|l| l.key == k).unwrap().refs;
        assert_eq!(label("sec:a"), 1);
        assert_eq!(label("sec:b"), 1);
        assert_eq!(label("fig:unused"), 0);
        assert_eq!(r.undefined_refs.iter().map(|u| u.key.as_str()).collect::<Vec<_>>(), vec!["eq:x"]);
        assert_eq!(r.duplicate_labels.len(), 2, "both sec:a definitions are listed");
        assert_eq!(r.bib.iter().find(|b| b.key == "unused").unwrap().cites, 0);
        assert_eq!(r.bib.iter().find(|b| b.key == "knuth").unwrap().cites, 1);
        let missing: Vec<&str> = r.missing_cites.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(missing, vec!["lamport", "ghost"]);
        assert!(!r.nocite_all);
    }

    #[test]
    fn nocite_star_marks_all_entries_as_cited() {
        let r = build(&[("m.tex".into(), "\\nocite{*}".into())], &[]);
        assert!(r.nocite_all);
        assert!(r.missing_cites.is_empty());
    }
}
