//! Diagnostics commands: the unified problem list (compile + rules + AI).

use crate::core::{Issue, IssueKind};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct DiagnosticsBundle {
    pub compile_issues: Vec<Issue>,
    pub rule_issues: Vec<Issue>,
    pub ai_notes: Vec<Issue>,
}

/// All current issues grouped by kind.
#[tauri::command]
pub fn tb_get_diagnostics(state: State<'_, AppState>) -> Result<DiagnosticsBundle, String> {
    let last = state.last_result.read().map_err(|e| e.to_string())?;
    let rule = state.rule_issues.read().map_err(|e| e.to_string())?;
    let compile_issues: Vec<Issue> = last
        .as_ref()
        .map(|r| r.issues.iter().filter(|i| i.kind == IssueKind::CompileError).cloned().collect())
        .unwrap_or_default();
    let ai_notes: Vec<Issue> = last
        .as_ref()
        .map(|r| r.issues.iter().filter(|i| i.kind == IssueKind::AiDiagnosis).cloned().collect())
        .unwrap_or_default();
    Ok(DiagnosticsBundle {
        compile_issues,
        rule_issues: rule.clone(),
        ai_notes,
    })
}
