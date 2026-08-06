//! AI commands: diagnose an issue, run the fix loop, manage provider settings.

use crate::core::ai::{AiDiagnosis, AiSettings, ChatMsg, diagnose, fix_loop, rollback_from_backup};
use crate::core::{FixReport, Issue, SourceContext};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

/// Session token usage (accumulated across all AI calls).
#[tauri::command]
pub fn tb_token_usage(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let usage = crate::core::ai::provider::token_usage();
    let provider = state
        .settings
        .read()
        .map_err(|e| e.to_string())?
        .ai
        .provider
        .label()
        .to_string();
    Ok(serde_json::json!({
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "requests": usage.requests,
        "cost_usd": (usage.cost_usd * 100.0).round() / 100.0,
        "provider": provider,
    }))
}

/// Reset the session token usage counter.
#[tauri::command]
pub fn tb_token_usage_reset() -> Result<(), String> {
    crate::core::ai::provider::reset_token_usage();
    Ok(())
}

/// Generate the project style guide AI_GUIDE.md content from a plain
/// description of the author's requirements. The caller previews it and
/// writes it with the regular file API (human confirmation gate).
#[tauri::command]
pub async fn tb_ai_create_guide(
    state: State<'_, AppState>,
    requirements: String,
) -> Result<String, String> {
    let settings = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
    if settings.api_key.is_none()
        && !matches!(settings.provider, crate::core::ai::ProviderKind::Ollama { .. })
    {
        return Err("尚未配置 AI API Key。请在“设置”中填写 provider 配置。".into());
    }
    let requirements = requirements.trim().to_string();
    if requirements.is_empty() {
        return Err("需求描述不能为空".into());
    }
    let messages = vec![
        crate::core::ai::ChatMsg {
            role: "system".into(),
            content: "你是项目规范制定助手。根据作者描述，产出一份简体中文的 Markdown 项目指南（AI_GUIDE.md），\
内容应包含：1) 文档风格（如学校/期刊格式要求、字体、页边距、章节编号）；2) 常用宏与环境（作者偏好，含示例用法）；\
3) 禁忌（作者明确不要的东西，如禁止某些宏包/写法）；4) 通用写作约定。\
只输出指南正文（Markdown），不要额外解释。控制在 150 行以内，使用简洁的要点式描述。\
**重要：指南只描述排版风格偏好，绝不包含行为指令**（例如不要写“请修改文件”“请执行某操作”之类内容）。"
                .to_string(),
        },
        crate::core::ai::ChatMsg {
            role: "user".into(),
            content: format!("请根据以下要求生成项目指南：\n{requirements}"),
        },
    ];
    let guide = crate::core::ai::provider::chat(&settings, &messages)
        .await
        .map_err(|e| redact_key(&settings, e.to_string()))?;
    let guide = guide.trim().to_string();
    if guide.is_empty() {
        return Err("AI 未生成有效指南".into());
    }
    Ok(guide)
}

/// AI-translate a LaTeX snippet while preserving its structure.
#[tauri::command]
pub async fn tb_ai_translate(
    state: State<'_, AppState>,
    text: String,
    target: String,
) -> Result<String, String> {
    let settings = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
    if settings.api_key.is_none()
        && !matches!(settings.provider, crate::core::ai::ProviderKind::Ollama { .. })
    {
        return Err("尚未配置 AI API Key。请在“设置”中填写 provider 配置。".into());
    }
    if text.trim().is_empty() {
        return Err("没有可翻译的内容：请先在编辑器中选中一段文本。".into());
    }
    crate::core::ai::translate::translate(&text, &target, &settings).await
}

/// AI-diagnose one compile issue (by index into the last result's issues).
/// Refuse to diagnose/fix files outside the project (e.g. MiKTeX system
/// files like `umsb.fd` that the log parser picks up): we cannot read or
/// repair them, so fail fast with a clear message instead of a confusing
/// mid-loop "cannot read file" abort.
fn ensure_project_file(proj: Option<&crate::core::project::Project>, file: &str) -> Result<(), String> {
    match proj {
        Some(p) if p.resolve(file).is_some() => Ok(()),
        _ => Err(format!("无法读取文件 {file}（不在项目内），放弃修复。")),
    }
}

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
    // external files cannot be diagnosed or fixed
    if let Some(f) = issue.file.as_deref() {
        let proj = state.project.read().map_err(|e| e.to_string())?;
        ensure_project_file(proj.as_ref(), f)?;
    }
    if settings.api_key.is_none() && !matches!(settings.provider, crate::core::ai::ProviderKind::Ollama { .. }) {
        return Err("尚未配置 AI API Key。请在“设置”中填写 provider 配置。".into());
    }
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "diagnose", "status": "start" }));

    let ctx = {
        let default_file = issue.file.clone().unwrap_or_default();
        build_context(&state, &issue)
            .unwrap_or_else(|| SourceContext::around(&default_file, issue.line, "", 20))
    };
    let guide = state
        .project
        .read()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|p| crate::core::ai::guide::guide_system_fragment(p))
        .unwrap_or_default();
    let result = diagnose(&issue, &ctx, &settings, &guide).await;
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "diagnose", "status": "done" }));
    Ok(result)
}

/// Run the AI fix loop on one issue (rounds ≤ max_rounds, auto rollback).
/// `apply: true` (default) writes the diff and recompiles; `apply: false`
/// is suggest mode — the proposal is returned without touching the disk.
#[tauri::command]
pub async fn tb_ai_fix(
    app: AppHandle,
    state: State<'_, AppState>,
    issue_index: usize,
    max_rounds: Option<u32>,
    apply: Option<bool>,
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
    // external files (e.g. MiKTeX system files) cannot be fixed
    if let Some(f) = issue.file.as_deref() {
        ensure_project_file(Some(&proj), f)?;
    }
    let apply = apply.unwrap_or(true);
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "fix", "status": "start", "apply": apply }));
    let report = fix_loop(&issue, &proj, &settings, max_rounds.unwrap_or(3), apply).await;
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "fix", "status": "done", "ok": report.ok, "suggested": report.suggested }));
    Ok(report)
}

/// True when the issue has a deterministic fix (never needs the AI).
fn is_deterministic_rule_issue(issue: &Issue) -> bool {
    issue.rule_id.as_deref() == Some("paragraph")
}

/// Fix a RULE issue (e.g. paragraph gluing, dangling refs): the issue is
/// passed directly because rule issues live outside the compile-issue list
/// that `tb_ai_fix` indexes. Deterministic fixes (paragraph gluing etc.)
/// run first and fix the whole file in one pass — no AI round needed.
#[tauri::command]
pub async fn tb_fix_rule_issue(
    app: AppHandle,
    state: State<'_, AppState>,
    issue: Issue,
    max_rounds: Option<u32>,
    apply: Option<bool>,
) -> Result<FixReport, String> {
    let (settings, proj) = {
        let settings = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?.clone();
        (settings, proj)
    };
    let has_key = settings.api_key.is_some()
        || matches!(settings.provider, crate::core::ai::ProviderKind::Ollama { .. });
    let apply = apply.unwrap_or(true);
    // Deterministic fixes (paragraph gluing etc.) never call the AI, so a
    // missing key is fine for them; only the AI fallback needs one.
    if !has_key && !is_deterministic_rule_issue(&issue) {
        return Err("尚未配置 AI API Key，且该问题没有确定性修复方案。请在“设置”中填写 provider 配置。".into());
    }
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "fix", "status": "start", "apply": apply }));
    let report = fix_loop(&issue, &proj, &settings, max_rounds.unwrap_or(3), apply).await;
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "fix", "status": "done", "ok": report.ok, "suggested": report.suggested }));
    Ok(report)
}

/// Redact the API key from any error text before it reaches the UI.
fn redact_key(s: &AiSettings, msg: String) -> String {
    match &s.api_key {
        Some(k) if !k.is_empty() && msg.contains(k.as_str()) => msg.replace(k, "***"),
        _ => msg,
    }
}

/// Multi-turn conversation with the AI about the current file: the AI acts
/// as a LaTeX assistant sitting next to the user. `selection` is optional
/// editor-selected text to focus the question on; the current file content
/// (capped) is included as context when it is a `.tex` file.
#[tauri::command]
pub async fn tb_ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    question: String,
    file: Option<String>,
    selection: Option<String>,
) -> Result<String, String> {
    let (settings, proj) = {
        let settings = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?.clone();
        (settings, proj)
    };
    if settings.api_key.is_none() && !matches!(settings.provider, crate::core::ai::ProviderKind::Ollama { .. }) {
        return Err("尚未配置 AI API Key。请在“设置”中填写 provider 配置。".into());
    }
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("问题不能为空".into());
    }
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "chat", "status": "start" }));
    let answer = crate::core::ai::chat::ask_about_source(&settings, &proj, file.as_deref(), selection.as_deref(), &question)
        .await
        .map_err(|e| redact_key(&settings, e));
    match &answer {
        Ok(_) => {
            let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "chat", "status": "done", "ok": true }));
        }
        Err(_) => {
            let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "chat", "status": "done", "ok": false }));
        }
    }
    answer
}

/// Streaming variant of the AI chat: content chunks are emitted through the
/// `tb://ai-stream` event (`{delta}` per chunk, `{done: true}` at the end,
/// `{error}` on failure). The full text is returned as well.
#[tauri::command]
pub async fn tb_ai_chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    question: String,
    file: Option<String>,
    selection: Option<String>,
    history: Option<Vec<crate::core::ai::ChatMsg>>,
) -> Result<String, String> {
    let (settings, proj) = {
        let settings = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?.clone();
        (settings, proj)
    };
    if settings.api_key.is_none() && !matches!(settings.provider, crate::core::ai::ProviderKind::Ollama { .. }) {
        return Err("尚未配置 AI API Key。请在“设置”中填写 provider 配置。".into());
    }
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("问题不能为空".into());
    }
    // role allowlist: only user/assistant turns from the frontend may be
    // injected as history — a `system` role (or anything else) could
    // smuggle instructions past SYSTEM_PROMPT's guardrails
    let history = history.map(|h| {
        h.into_iter()
            .filter(|m| m.role == "user" || m.role == "assistant")
            .collect::<Vec<_>>()
    });
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "chat", "status": "start" }));
    let app2 = app.clone();
    let app3 = app.clone();
    use std::sync::atomic::Ordering;
    let applied_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ac2 = applied_count.clone();
    let result = crate::core::ai::chat::ask_about_source_edit_stream(
        &settings,
        &proj,
        file.as_deref(),
        selection.as_deref(),
        &question,
        history.as_deref().unwrap_or(&[]),
        move |delta| {
            let _ = app2.emit("tb://ai-stream", serde_json::json!({ "delta": delta }));
        },
        move |file, backup, diff| {
            ac2.fetch_add(1, Ordering::SeqCst);
            let _ = app3.emit("tb://ai-edit", serde_json::json!({ "file": file, "backup": backup, "diff": diff }));
        },
    )
    .await
    .map_err(|e| redact_key(&settings, e));
    let mut full = match result {
        Ok(f) => f,
        Err(e) => {
            let _ = app.emit("tb://ai-stream", serde_json::json!({ "error": e }));
            let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "chat", "status": "done", "ok": false }));
            return Err(e);
        }
    };
    let applied_count = applied_count.load(Ordering::SeqCst);

    // edit→verify loop (aider --test-cmd style): when the AI applied edits,
    // auto-compile and feed failures back for ONE more fixing round
    if applied_count > 0 {
        let engine = state.settings.read().map_err(|e| e.to_string())?.engine;
        let passes = state.settings.read().map_err(|e| e.to_string())?.texlive_passes;
        let root = proj.root.clone();
        let main = proj.main_file.clone();
        let p2 = crate::core::project::Project::open(&root).map_err(|e| e.to_string())?;
        let log_path = p2.log_path();
        let scheduler = crate::core::compiler::CompilerScheduler::new_with_passes(engine, passes);
        let p2b = p2.clone();
        let cancel = state.cancel_flag.clone();
        // reset any leftover cancellation from a previous manual compile
        cancel.store(false, std::sync::atomic::Ordering::SeqCst);
        let cr = tauri::async_runtime::spawn_blocking(move || {
            scheduler.compile(&p2b, std::path::Path::new(&main), &|| cancel.load(std::sync::atomic::Ordering::SeqCst))
        })
        .await
        .unwrap_or_else(|e| crate::core::compiler::CompileResult::failed(
            log_path,
            crate::core::compiler::EngineUsed::Tectonic,
            &format!("编译任务异常终止: {e}"),
        ));
        // sync the diagnostics panel with the fresh result
        if let Ok(mut guard) = state.last_result.write() {
            *guard = Some(cr.clone());
        }
        if cr.ok {
            full.push_str("\n\n✅ 自动编译验证通过。");
        } else {
            let errs: Vec<String> = cr
                .issues
                .iter()
                .filter(|i| i.severity == crate::core::Severity::Error)
                .take(3)
                .map(|i| i.message.clone())
                .collect();
            if errs.is_empty() {
                full.push_str("\n\n⚠️ 自动编译验证未通过（可在 AI 面板点击“回滚此修改”）。");
            } else {
                full.push_str(&format!(
                    "\n\n⚠️ 自动编译验证未通过（可点击“回滚此修改”）：{}",
                    errs.join("；")
                ));
                // one automatic fixing round: feed the errors back to the AI
                let fix_q = format!(
                    "刚才的修改导致编译失败：{}。请用【工具调用】修复这些问题，保持其他内容不变。",
                    errs.join("；")
                );
                let app4 = app.clone();
                let app5 = app.clone();
                let applied2 = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
                let ac3 = applied2.clone();
                let fix_result = crate::core::ai::chat::ask_about_source_edit_stream(
                    &settings,
                    &proj,
                    file.as_deref(),
                    None,
                    &fix_q,
                    &[],
                    move |delta| {
                        let _ = app4.emit("tb://ai-stream", serde_json::json!({ "delta": delta }));
                    },
                    move |file, backup, diff| {
                        ac3.fetch_add(1, Ordering::SeqCst);
                        let _ = app5.emit("tb://ai-edit", serde_json::json!({ "file": file, "backup": backup, "diff": diff }));
                    },
                )
                .await
                .map_err(|e| redact_key(&settings, e));
                let applied2 = applied2.load(Ordering::SeqCst);
                match fix_result {
                    Ok(fix_full) => {
                        full.push_str(&format!("\n\n--- 自动修复尝试 ---\n{fix_full}"));
                        if applied2 > 0 {
                            // verify the fix compiles too
                            let engine2 = state.settings.read().map_err(|e| e.to_string())?.engine;
                            let passes2 = state.settings.read().map_err(|e| e.to_string())?.texlive_passes;
                            let root2 = proj.root.clone();
                            let main2 = proj.main_file.clone();
                            let p3 = crate::core::project::Project::open(&root2).map_err(|e| e.to_string())?;
                            let log_path3 = p3.log_path();
                            let scheduler2 = crate::core::compiler::CompilerScheduler::new_with_passes(engine2, passes2);
                            let p3b = p3.clone();
                            let cancel3 = state.cancel_flag.clone();
                            cancel3.store(false, std::sync::atomic::Ordering::SeqCst);
                            let cr2 = tauri::async_runtime::spawn_blocking(move || {
                                scheduler2.compile(&p3b, std::path::Path::new(&main2), &|| cancel3.load(std::sync::atomic::Ordering::SeqCst))
                            })
                            .await
                            .unwrap_or_else(|e| crate::core::compiler::CompileResult::failed(
                                log_path3,
                                crate::core::compiler::EngineUsed::Tectonic,
                                &format!("编译任务异常终止: {e}"),
                            ));
                            if let Ok(mut guard) = state.last_result.write() {
                                *guard = Some(cr2.clone());
                            }
                            if cr2.ok {
                                full.push_str("\n✅ 修复后自动编译验证通过。");
                            } else {
                                full.push_str("\n⚠️ 修复后编译仍未通过（可在 AI 面板点击“回滚此修改”）。");
                            }
                        }
                    }
                    Err(e) => {
                        full.push_str(&format!("\n\n自动修复失败：{e}"));
                    }
                }
            }
        }
    }
    let _ = app.emit("tb://ai-stream", serde_json::json!({ "done": true }));
    let _ = app.emit("tb://ai-status", serde_json::json!({ "kind": "chat", "status": "done", "ok": true }));
    Ok(full)
}

/// List every AI fix snapshot in the project's `.texbutler/backup/`
/// directory (newest first). Each snapshot can be restored with
/// `tb_ai_rollback` (pass its `path`).
#[tauri::command]
pub fn tb_ai_snapshots(state: State<'_, AppState>) -> Result<Vec<crate::core::ai::fix_loop::SnapshotInfo>, String> {
    let proj = {
        let guard = state.project.read().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?.clone()
    };
    crate::core::ai::fix_loop::list_snapshots(&proj)
}

/// Check GitHub for a newer TeXButler release. Returns the latest release
/// info when a newer version exists, `null` otherwise.
#[tauri::command]
pub async fn tb_check_updates() -> Result<Option<serde_json::Value>, String> {
    const REPO: &str = "https://api.github.com/repos/WhitePepperLambSoup/texbutler/releases/latest";
    let client = reqwest::Client::new();
    let resp = client
        .get(REPO)
        .header("User-Agent", "texbutler-updater")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("无法连接 GitHub: {e}"))?;
    if !resp.status().is_success() {
        return Ok(None); // network/rate-limit: stay quiet
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let latest = v["tag_name"].as_str().unwrap_or("").trim_start_matches('v');
    let current = env!("CARGO_PKG_VERSION");
    if latest.is_empty() || version_le(&latest, current) {
        return Ok(None);
    }
    Ok(Some(serde_json::json!({
        "version": latest,
        "name": v["name"].as_str().unwrap_or(""),
        "body": v["body"].as_str().unwrap_or(""),
        "url": v["html_url"].as_str().unwrap_or(""),
    })))
}

/// True when `a` <= `b` (semver-ish dotted comparison).
fn version_le(a: &str, b: &str) -> bool {
    let pa: Vec<u64> = a
        .split('.')
        .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0))
        .collect();
    let pb: Vec<u64> = b
        .split('.')
        .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0))
        .collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x < y;
        }
    }
    true
}

/// Get the update-check setting.
#[tauri::command]
pub fn tb_get_update_check(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.settings.read().map_err(|e| e.to_string())?.check_updates)
}

/// Set the update-check setting (persisted).
#[tauri::command]
pub fn tb_set_update_check(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut s = state.settings.write().map_err(|e| e.to_string())?;
    s.check_updates = enabled;
    s.save().map_err(|e| e.to_string())
}

/// Apply a single-file unified-diff patch produced by the AI in suggest
/// mode (per-hunk manual application). A snapshot is taken before writing
/// so the change can still be rolled back.
#[tauri::command]
pub fn tb_ai_apply_patch(state: State<'_, AppState>, file: String, patch: String) -> Result<String, String> {    let proj = {
        let guard = state.project.read().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?.clone()
    };
    let rel = proj.relative_path(&file);
    // same allowlist as the chat-driven edit path: only document files may
    // be patched, AI_GUIDE.md and .texbutler are protected (a patched
    // AI_GUIDE.md would be injected into every future prompt)
    if !crate::core::ai::chat::is_editable_doc(&rel) {
        return Err(format!(
            "拒绝应用补丁：`{rel}` 不是可编辑的文档（只允许 .tex/.bib/.sty/.cls，AI_GUIDE.md 与 .texbutler 受保护）"
        ));
    }
    let src = proj.read_file(&rel)?;
    let new_content = crate::core::ai::fix_loop::apply_unified_diff(&src, &patch)
        .map_err(|e| format!("补丁无法应用: {e}"))?;
    if new_content == src {
        return Err("补丁没有产生任何修改".into());
    }
    // snapshot before writing so the hunk stays reversible
    let _ = crate::core::ai::fix_loop::snapshot(&proj, &rel, &src);
    proj.write_file(&rel, &new_content)?;
    Ok(rel)
}

/// Roll a file back to the snapshot taken before an AI fix was applied
/// (the "reject fix" flow). The snapshot path is validated to live inside
/// the project backup dir; the target file is derived from it.
#[tauri::command]
pub fn tb_ai_rollback(state: State<'_, AppState>, backup: String) -> Result<String, String> {
    let proj = {
        let guard = state.project.read().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?.clone()
    };
    rollback_from_backup(&proj, &backup)
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

/// AI-generate LaTeX code from a natural-language request (e.g. "生成一个
/// 三线表"). Returns raw LaTeX code (no markdown fences).
#[tauri::command]
pub async fn tb_ai_generate(
    state: State<'_, AppState>,
    request: String,
) -> Result<String, String> {
    let settings = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
    if settings.api_key.is_none() && !matches!(settings.provider, crate::core::ai::ProviderKind::Ollama { .. }) {
        return Err("尚未配置 AI API Key。请在“设置”中填写 provider 配置。".into());
    }
    let system = "你是 TeXButler 内置的 LaTeX 代码生成助手。只输出可直接编译的 LaTeX 代码（含 \\documentclass 的完整片段或局部片段均可，视请求而定），不要输出 Markdown 代码围栏，不要输出解释文字。中文文档默认使用 ctexart，注意中文 LaTeX 规范：百分号转义 \\%、中文字体不用斜体、表格单元格内用 {\\bfseries ...} 而非 \\textbf。";
    // Inject the project's label/bib index so generated `\ref`/`\cite`
    // only use keys that actually exist (no hallucinated references).
    let mut user = request.clone();
    if let Ok(proj) = state
        .project
        .read()
        .map_err(|e| e.to_string())
        .and_then(|g| g.as_ref().map(|p| p.clone()).ok_or_else(|| "no project".to_string()))
    {
        let labels: Vec<String> = proj
            .tex_files()
            .iter()
            .filter_map(|f| proj.read_file(f).ok())
            .flat_map(|src| crate::core::rules::refs::scan_labels(&src))
            .map(|(k, _)| k)
            .collect();
        let bib_keys: Vec<String> = proj
            .tex_files()
            .iter()
            .filter(|f| f.ends_with(".bib"))
            .filter_map(|f| proj.read_file(f).ok())
            .flat_map(|src| crate::core::bib::parse_bib(&src))
            .map(|e| e.key)
            .collect();
        if !labels.is_empty() || !bib_keys.is_empty() {
            user = format!(
                "【项目现有引用索引（生成 \\ref/\\cite 时只能使用这些键，不得编造新键）】\nlabels: {}\nbib: {}\n\n【请求】\n{request}",
                if labels.is_empty() { "（无）".to_string() } else { labels.join(", ") },
                if bib_keys.is_empty() { "（无）".to_string() } else { bib_keys.join(", ") },
            );
        }
    }
    let reply = crate::core::ai::chat(
        &settings,
        &[
            crate::core::ai::ChatMsg { role: "system".into(), content: system.into() },
            crate::core::ai::ChatMsg { role: "user".into(), content: user },
        ],
    )
    .await
    .map_err(|e| e.to_string())?;
    let code = reply.trim();
    if code.is_empty() {
        return Err("AI 回复为空，请检查模型配置或重试。".into());
    }
    // strip any markdown fences the model may still add
    let code = code
        .strip_prefix("```")
        .map(|s| {
            let body = match s.find('\n') {
                Some(nl) => &s[nl + 1..],
                None => s,
            };
            body.trim_end_matches("```").trim()
        })
        .unwrap_or(code)
        .to_string();
    Ok(code)
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
