//! AI full-document review ("annotation mode"): the model returns a list of
//! located findings — exact quote, problem, suggested replacement — which
//! the user accepts or dismisses one by one. Nothing is written by the
//! backend; every finding is validated against the source so a
//! hallucinated quote never turns into an edit.

use serde::{Deserialize, Serialize};

/// Longest document sent in one request (characters).
pub const MAX_CHARS: usize = 60_000;
/// Upper bound on findings kept from one answer.
pub const MAX_ITEMS: usize = 40;

#[derive(Debug, Clone, Deserialize)]
struct RawItem {
    #[serde(default)]
    line: serde_json::Value,
    #[serde(default)]
    quote: String,
    #[serde(default, alias = "issue")]
    problem: String,
    #[serde(default, alias = "replacement", alias = "fix")]
    suggestion: String,
    #[serde(default, alias = "type")]
    category: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReviewItem {
    /// 1-based line of the quote.
    pub line: usize,
    /// 1-based UTF-16 columns of the quote on that line.
    pub start_col: usize,
    pub end_col: usize,
    pub quote: String,
    pub problem: String,
    /// Replacement for the quote; empty = comment only.
    pub suggestion: String,
    /// grammar | wording | logic | latex | typography | consistency | other
    pub category: String,
}

/// System prompt for the review request.
pub fn system_prompt(english_ui: bool) -> String {
    let lang = if english_ui { "English" } else { "简体中文" };
    format!(
        "You are a meticulous academic copy editor reviewing a LaTeX source file. Find concrete problems: grammar and typos, \
         unclear or awkward wording, inconsistent terminology, logical gaps, misuse of LaTeX (e.g. wrong quotes, missing ~ before \\ref, \
         math typed as text), and Chinese typography issues. Do NOT report style preferences, and never change math, labels, \
         citation keys or commands unless they are wrong.\n\
         Reply with ONLY a JSON array (no prose, no code fences). Each element: \
         {{\"line\": <line number from the listing>, \"quote\": \"<exact text copied from that line, short but unique on the line>\", \
         \"problem\": \"<what is wrong, in {lang}>\", \"suggestion\": \"<replacement text for quote, or empty string if only a comment>\", \
         \"category\": \"grammar|wording|logic|latex|typography|consistency|other\"}}. \
         Keep the document's own language in quote and suggestion. At most {MAX_ITEMS} items, most important first. \
         Reply [] if there is nothing worth changing."
    )
}

/// The user message: the file with line numbers.
pub fn user_prompt(file: &str, content: &str) -> String {
    let mut out = format!("File: {file}\n\n");
    for (i, line) in content.lines().enumerate() {
        out.push_str(&format!("{:>4} | {}\n", i + 1, line));
    }
    out
}

/// Extract the JSON array from a model reply (tolerates fences / prose).
fn json_slice(reply: &str) -> Option<&str> {
    let start = reply.find('[')?;
    let end = reply.rfind(']')?;
    (end > start).then(|| &reply[start..=end])
}

fn utf16_col(line: &str, byte: usize) -> usize {
    line[..byte].encode_utf16().count() + 1
}

/// Parse and validate the model's findings against the source. A quote must
/// occur on the stated line (or within 3 lines of it — models miscount);
/// findings whose quote cannot be found are dropped.
pub fn parse_items(reply: &str, content: &str) -> Result<Vec<ReviewItem>, String> {
    let slice = json_slice(reply).ok_or("AI 没有返回审阅清单（JSON 数组）")?;
    let raw: Vec<RawItem> = serde_json::from_str(slice).map_err(|e| format!("AI 返回的审阅清单格式有误: {e}"))?;
    let lines: Vec<&str> = content.lines().collect();
    let mut out: Vec<ReviewItem> = Vec::new();
    for item in raw {
        let quote = item.quote.trim_matches(['\r', '\n']).to_string();
        if quote.trim().is_empty() || item.problem.trim().is_empty() || quote.contains('\n') {
            continue;
        }
        let stated = match &item.line {
            serde_json::Value::Number(n) => n.as_u64().unwrap_or(0) as usize,
            serde_json::Value::String(s) => s.trim().parse().unwrap_or(0),
            _ => 0,
        };
        let mut candidates: Vec<usize> = Vec::new();
        if stated >= 1 && stated <= lines.len() {
            candidates.push(stated);
            for d in 1..=3 {
                if stated > d {
                    candidates.push(stated - d);
                }
                if stated + d <= lines.len() {
                    candidates.push(stated + d);
                }
            }
        } else {
            candidates.extend(1..=lines.len());
        }
        let Some((line_no, byte)) = candidates.into_iter().find_map(|n| lines[n - 1].find(&quote).map(|b| (n, b))) else {
            continue;
        };
        let suggestion = item.suggestion.trim_matches(['\r', '\n']).to_string();
        if suggestion == quote {
            continue; // no-op suggestion
        }
        if out.iter().any(|o| o.line == line_no && o.quote == quote) {
            continue;
        }
        let text = lines[line_no - 1];
        out.push(ReviewItem {
            line: line_no,
            start_col: utf16_col(text, byte),
            end_col: utf16_col(text, byte + quote.len()),
            quote,
            problem: item.problem.trim().to_string(),
            suggestion,
            category: if item.category.trim().is_empty() { "other".into() } else { item.category.trim().to_lowercase() },
        });
        if out.len() >= MAX_ITEMS {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "\\section{引言}\n本文研究了一种新的的方法。\nWe has shown in Section \\ref{sec:a} that it work.\n";

    #[test]
    fn parses_validates_and_locates_findings() {
        let reply = r#"Here you go:
```json
[
 {"line": 2, "quote": "新的的方法", "problem": "重复的“的”", "suggestion": "新的方法", "category": "typography"},
 {"line": 2, "quote": "We has shown", "problem": "subject-verb agreement", "suggestion": "We have shown", "category": "Grammar"},
 {"line": 3, "quote": "Section \\ref", "problem": "missing tie", "suggestion": "Section~\\ref", "category": "latex"},
 {"line": 3, "quote": "not in the file", "problem": "hallucinated", "suggestion": "x"},
 {"line": 3, "quote": "it work", "problem": "", "suggestion": "it works"},
 {"line": "3", "quote": "it work", "problem": "agreement", "suggestion": "it work"}
]
```"#;
        let items = parse_items(reply, SRC).unwrap();
        assert_eq!(items.len(), 3, "{items:#?}");
        assert_eq!(items[0].line, 2);
        // "本文研究了一种" is 7 UTF-16 units → the quote starts at column 8
        assert_eq!((items[0].start_col, items[0].end_col), (8, 13));
        // the model said line 2 but the quote is on line 3: found nearby
        assert_eq!(items[1].line, 3);
        assert_eq!(items[1].category, "grammar");
        assert_eq!(items[2].suggestion, "Section~\\ref");
    }

    #[test]
    fn rejects_non_json_and_accepts_empty() {
        assert!(parse_items("I could not review this.", SRC).is_err());
        assert!(parse_items("[]", SRC).unwrap().is_empty());
    }

    #[test]
    fn prompt_numbers_lines() {
        let p = user_prompt("a.tex", "x\ny\n");
        assert!(p.contains("   1 | x\n   2 | y\n"));
    }
}
