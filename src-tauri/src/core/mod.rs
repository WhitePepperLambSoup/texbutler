//! TeXButler core library: project model, compiler drivers, log parser,
//! Chinese-LaTeX rule engine and AI layer. All UI-agnostic logic lives here.

pub mod ai;
pub mod bib;
pub mod compiler;
pub mod docx;
pub mod document_path;
pub mod export;
pub mod log_parser;
pub mod project;
pub mod rules;
pub mod settings;
pub mod synctex;
pub mod word_count;

use serde::{Deserialize, Serialize};

/// Severity of a reported issue. Order matters for filtering/UI grouping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
    Suggestion,
}

/// Where an issue came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueKind {
    /// Parsed from a LaTeX .log file.
    CompileError,
    /// Produced by the Chinese rule engine.
    RuleCheck,
    /// Produced by the AI diagnosis/fix layer.
    AiDiagnosis,
    /// Cross-file consistency (reserved for future phases).
    Consistency,
}

/// Unified "problem" struct: compile errors, rule findings and AI
/// diagnoses all share this shape so the frontend renders one list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub severity: Severity,
    /// Path relative to the project root (forward slashes).
    pub file: Option<String>,
    /// 1-based real line number in `file`.
    pub line: Option<usize>,
    pub col: Option<usize>,
    /// Human-readable message (Chinese for the UI).
    pub message: String,
    /// Raw original error text, kept for AI context.
    pub raw: Option<String>,
    pub kind: IssueKind,
    /// Stable rule id (e.g. "percent") for rules; None otherwise.
    pub rule_id: Option<String>,
    /// Suggested replacement snippet (rules only).
    pub fix_hint: Option<String>,
}

impl Issue {
    pub fn new(severity: Severity, kind: IssueKind, message: impl Into<String>) -> Self {
        Issue {
            severity,
            file: None,
            line: None,
            col: None,
            message: message.into(),
            raw: None,
            kind,
            rule_id: None,
            fix_hint: None,
        }
    }

    pub fn with_file(mut self, file: impl Into<String>) -> Self {
        self.file = Some(file.into());
        self
    }

    pub fn with_line(mut self, line: usize) -> Self {
        self.line = Some(line);
        self
    }

    pub fn with_col(mut self, col: usize) -> Self {
        self.col = Some(col);
        self
    }

    pub fn with_raw(mut self, raw: impl Into<String>) -> Self {
        self.raw = Some(raw.into());
        self
    }

    pub fn with_rule(mut self, id: &str, fix_hint: impl Into<String>) -> Self {
        self.rule_id = Some(id.to_string());
        self.fix_hint = Some(fix_hint.into());
        self
    }
}

/// A source code context window around a line, sent to the AI (never the
/// whole file — see security rules in the design doc).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceContext {
    pub file: String,
    pub line: Option<usize>,
    /// Lines before the error line (max 20).
    pub before: Vec<String>,
    /// The offending line itself, if known.
    pub focus: Option<String>,
    /// Lines after the error line (max 20).
    pub after: Vec<String>,
}

impl SourceContext {
    /// Build a context window around `line` (1-based) from a full file body.
    pub fn around(file: &str, line: Option<usize>, body: &str, radius: usize) -> Self {
        let lines: Vec<&str> = body.lines().collect();
        let idx = line.and_then(|l| l.checked_sub(1)).unwrap_or(0).min(lines.len().saturating_sub(1));
        let before = lines
            .iter()
            .skip(idx.saturating_sub(radius))
            .take(idx.saturating_sub(idx.saturating_sub(radius)))
            .map(|s| s.to_string())
            .collect();
        let focus = lines.get(idx).map(|s| s.to_string());
        let after = lines
            .iter()
            .skip(idx + 1)
            .take(radius)
            .map(|s| s.to_string())
            .collect();
        SourceContext {
            file: file.to_string(),
            line,
            before,
            focus,
            after,
        }
    }

    /// Render the window as one text block (line numbers included).
    pub fn render(&self) -> String {
        let mut out = String::new();
        let start = self.line.unwrap_or(1).saturating_sub(self.before.len());
        for (i, l) in self.before.iter().enumerate() {
            out.push_str(&format!("{} | {}\n", start + i, l));
        }
        if let Some(f) = &self.focus {
            out.push_str(&format!("{} | {}   <<<< 此处出错\n", self.line.unwrap_or(0), f));
        }
        for (i, l) in self.after.iter().enumerate() {
            out.push_str(&format!("{} | {}\n", self.line.unwrap_or(0) + 1 + i, l));
        }
        out
    }
}

/// A patch in unified-diff format plus a human description, produced by AI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDiff {
    /// Unified diff text (parsed on apply).
    pub diff: String,
    /// One-line human summary of what changed.
    pub summary: String,
}

/// One hunk of a proposed fix with a per-hunk explanation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixHunk {
    /// File the hunk applies to (relative project path).
    pub file: String,
    /// Approximate starting line in the current file (1-based).
    pub line: u32,
    /// The lines being replaced (without the leading `-`/` ` markers).
    pub old: String,
    /// The replacement lines (without the leading `+` markers).
    pub new: String,
    /// One-sentence explanation of this change (AI-provided when present).
    pub why: String,
}

/// Result of the AI fix loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixReport {
    pub ok: bool,
    /// Rounds actually executed (1..=max_rounds).
    pub rounds: u32,
    /// The diff proposed in the final (or successful) round.
    pub diff: Option<String>,
    pub summary: String,
    /// Issues remaining after the last compile.
    pub issues_after: Vec<Issue>,
    /// True when the applied changes were rolled back from backup.
    pub rolled_back: bool,
    /// Snapshot path of the file content BEFORE the fix was applied.
    /// Present on success so the user can reject the fix (roll back).
    pub backup: Option<String>,
    /// Per-hunk breakdown with AI explanations (empty in suggest mode
    /// when the diff was never applied, unless the AI provided them).
    pub hunks: Vec<FixHunk>,
    /// True when the fix was produced in suggest mode (nothing written).
    pub suggested: bool,
}

/// Round a float to `decimals` and format without floating-point garbage.
pub fn round_f64(v: f64, decimals: usize) -> f64 {
    let factor = 10f64.powi(decimals as i32);
    (v * factor).round() / factor
}
