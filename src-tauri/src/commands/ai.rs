//! AI commands: diagnose an issue, run the fix loop, manage provider settings.

use crate::core::ai::{AiDiagnosis, ChatMsg, diagnose, fix_loop};
use crate::core::{FixReport, Issue, SourceContext};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// AI-diagnose one compile issue (by index into the last result's issues).
#[tauri::command]
pub async fn tb_ai_diagnose(
    app: AppHandle,
    state: State<'_, AppState>,
    issue_index: usize,
) -> Result<AiDiagnosis, String> {
    let (issue, settings) = {
        let last = state.last_result.read().map_err(|e| e.to_string())?;
        let r = last.as_ref().ok_or_else(|| "还没有编译结果".to_string())?;
        let issue = r.issues.get(issue_index).cloned().ok_or_else(|| "问题索引越界".to_string())?;
        let settings = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
        (issue, settings)
    };
    if settings.api_key.is_none() && !matches!(settings.provider, crate::core::ai::ProviderKind::Ollama { .. }) {
        return Err("尚未配置 AI API Key。请在“设置”中填写 provider 配置。".into());
    }
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "diagnose", "status": "start" }));

    let ctx = {
        let default_file = issue.file.clone().unwrap_or_default();
        build_context(&state, &issue)
            .unwrap_or_else(|| SourceContext::around(&default_file, issue.line, "", 20))
    };
    let result = diagnose(&issue, &ctx, &settings).await;
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "diagnose", "status": "done" }));
    Ok(result)
}

/// Run the AI fix loop on one issue (rounds ≤ max_rounds, auto rollback).
#[tauri::command]
pub async fn tb_ai_fix(
    app: AppHandle,
    state: State<'_, AppState>,
    issue_index: usize,
    max_rounds: Option<u32>,
) -> Result<FixReport, String> {
    let (issue, settings, proj) = {
        let last = state.last_result.read().map_err(|e| e.to_string())?;
        let r = last.as_ref().ok_or_else(|| "还没有编译结果".to_string())?;
        let issue = r.issues.get(issue_index).cloned().ok_or_else(|| "问题索引越界".to_string())?;
        let settings = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?.clone();
        (issue, settings, proj)
    };
    if settings.api_key.is_none() && !matches!(settings.provider, crate::core::ai::ProviderKind::Ollama { .. }) {
        return Err("尚未配置 AI API Key。请在“设置”中填写 provider 配置。".into());
    }
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "fix", "status": "start" }));
    let report = fix_loop(&issue, &proj, &settings, max_rounds.unwrap_or(3)).await;
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "fix", "status": "done", "ok": report.ok }));
    Ok(report)
}

/// Get the current AI settings (masked: api_key only shows "***").
#[tauri::command]
pub fn tb_ai_get_settings(state: State<'_, AppState>) -> Result<AiSettingsView, String> {
    let s = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
    Ok(AiSettingsView {
        provider: s.provider,
        model: s.model,
        api_key: if s.api_key.as_deref().map(|k| !k.is_empty()).unwrap_or(false) {
            Some("••••••••".to_string())
        } else {
            None
        },
        temperature: s.temperature,
        max_tokens: s.max_tokens,
        timeout_secs: s.timeout_secs,
        disable_thinking: s.disable_thinking,
    })
}

/// Save AI settings. When `api_key` is "••••••••" the old key is kept.
#[tauri::command]
pub fn tb_ai_set_settings(
    state: State<'_, AppState>,
    provider: crate::core::ai::ProviderKind,
    model: String,
    api_key: Option<String>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    timeout_secs: Option<u64>,
    disable_thinking: Option<bool>,
) -> Result<(), String> {
    let mut settings = state.settings.write().map_err(|e| e.to_string())?;
    let keep_key = api_key.as_deref() == Some("••••••••");
    if !keep_key {
        settings.ai.api_key = api_key.filter(|k| !k.is_empty());
    }
    settings.ai.provider = provider;
    settings.ai.model = model;
    if let Some(t) = temperature {
        settings.ai.temperature = t.clamp(0.0, 2.0);
    }
    if let Some(m) = max_tokens {
        settings.ai.max_tokens = m.clamp(64, 16384);
    }
    if let Some(t) = timeout_secs {
        settings.ai.timeout_secs = t.clamp(5, 600);
    }
    if let Some(d) = disable_thinking {
        settings.ai.disable_thinking = d;
    }
    settings.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Ping the configured provider with a tiny message to verify connectivity.
#[tauri::command]
pub async fn tb_ai_test_connection(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let s = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
    if s.api_key.is_none() && !matches!(s.provider, crate::core::ai::ProviderKind::Ollama { .. }) {
        return Err("未配置 api_key".into());
    }
    let reply = crate::core::ai::chat(
        &s,
        &[ChatMsg { role: "user".into(), content: "请只回复两个字：正常".into() }],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(format!("连接成功，模型回复: {}", reply.trim()))
}

fn build_context(state: &State<'_, AppState>, issue: &Issue) -> Option<SourceContext> {
    let guard = state.project.read().ok()?;
    let proj = guard.as_ref()?;
    let file = issue
        .file
        .clone()
        .map(|f| proj.relative_path(&f))
        .unwrap_or_else(|| proj.main_file.clone());
    let body = proj.read_file(&file).ok()?;
    Some(SourceContext::around(&file, issue.line, &body, 20))
}

#[derive(serde::Serialize)]
pub struct AiSettingsView {
    pub provider: crate::core::ai::ProviderKind,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: f32,
    pub max_tokens: u32,
    pub timeout_secs: u64,
    pub disable_thinking: bool,
}
