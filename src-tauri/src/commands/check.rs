//! Chinese rule-check commands: run the engine, toggle rules, bundle status.

use crate::core::compiler::Compiler;
use crate::core::rules;
use crate::core::Issue;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize)]
pub struct RuleState {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub issues: Vec<Issue>,
    pub rule_states: Vec<RuleState>,
}

/// Run the rule engine over all .tex files of the current project.
/// When `only_file` is given, only that file is checked (used by the
/// editor debounce — full-project scans on every keystroke cause lag).
#[tauri::command]
pub async fn tb_run_check(
    app: AppHandle,
    state: State<'_, AppState>,
    only_file: Option<String>,
) -> Result<CheckResult, String> {
    let _ = app.emit("tb://check-start", ());
    let (proj, enabled_map) = {
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
        let settings = state.settings.read().map_err(|e| e.to_string())?;
        (proj.clone(), settings.rules.clone())
    };

    let mut issues: Vec<Issue> = Vec::new();
    let tex_files: Vec<String> = match only_file.clone().filter(|f| !f.is_empty()) {
        Some(f) => vec![proj.relative_path(&f)],
        None => {
            let mut all: Vec<String> = Vec::new();
            crate::core::project::flatten_tree(proj.file_tree(), &mut all);
            let mut files: Vec<String> = all.into_iter().filter(|p| p.ends_with(".tex")).collect();
            if files.is_empty() {
                files.push(proj.main_file.clone());
            }
            files
        }
    };
    // Rule toggles from settings (missing = default).
    let enabled_base = |id: &str| {
        enabled_map.get(id).copied().unwrap_or_else(|| {
            rules::all_rules()
                .iter()
                .find(|r| r.id() == id)
                .map(|r| r.default_enabled())
                .unwrap_or(true)
        })
    };
    // Per-file checks skip "refs" on full scans (the project-wide check
    // below covers it without duplicating findings).
    let enabled = |id: &str| {
        if only_file.is_none() && id == "refs" {
            return false;
        }
        enabled_base(id)
    };

    // Full scans also run the project-wide checks (dangling refs/cites).
    let mut project_files: Vec<(String, String)> = Vec::new();
    let mut bib_keys: Vec<String> = Vec::new();
    if only_file.is_none() {
        for rel in proj.bib_files() {
            let Ok(content) = proj.read_file(&rel) else { continue };
            for entry in crate::core::bib::parse_bib(&content) {
                if !bib_keys.contains(&entry.key) {
                    bib_keys.push(entry.key);
                }
            }
        }
    }

    for rel in &tex_files {
        let Ok(src) = proj.read_file(rel) else { continue };
        // BOM check needs the raw bytes (read_file strips the BOM for the
        // editor); re-detect it and let the bom rule see the marker.
        let raw_starts_with_bom = proj
            .resolve(rel)
            .and_then(|p| std::fs::read(p).ok())
            .map(|b| b.starts_with(&[0xEF, 0xBB, 0xBF]))
            .unwrap_or(false);
        let src = if raw_starts_with_bom {
            format!("\u{FEFF}{src}")
        } else {
            src
        };
        rules::check_source(&src, rel, &enabled, &mut issues);
        if only_file.is_none() {
            project_files.push((rel.clone(), src));
        }
    }
    if only_file.is_none() && !project_files.is_empty() {
        let ctx = rules::ProjectCtx { files: project_files, bib_keys };
        rules::check_project(&ctx, &enabled_base, &mut issues);
    }
    // sort: errors first, then by file/line
    issues.sort_by_key(|i| {
        (
            match i.severity {
                crate::core::Severity::Error => 0,
                crate::core::Severity::Warning => 1,
                crate::core::Severity::Info => 2,
                crate::core::Severity::Suggestion => 3,
            },
            i.file.clone().unwrap_or_default(),
            i.line.unwrap_or(0),
        )
    });

    {
        let mut guard = state.rule_issues.write().map_err(|e| e.to_string())?;
        *guard = issues.clone();
    }
    let _ = app.emit("tb://check-done", &issues);
    Ok(CheckResult {
        issues,
        rule_states: rule_states(&state),
    })
}

/// Toggle one rule (persisted in settings).
#[tauri::command]
pub fn tb_set_rule_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> Result<(), String> {
    {
        let mut settings = state.settings.write().map_err(|e| e.to_string())?;
        settings.rules.insert(id, enabled);
        settings.save().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Current rule toggle states.
#[tauri::command]
pub fn tb_get_rule_states(state: State<'_, AppState>) -> Vec<RuleState> {
    rule_states(&state)
}

fn rule_states(state: &State<'_, AppState>) -> Vec<RuleState> {
    let settings = state.settings.read().map(|s| s.rules.clone()).unwrap_or_default();
    rules::all_rules()
        .into_iter()
        .map(|r| RuleState {
            id: r.id().to_string(),
            name: r.name().to_string(),
            enabled: settings.get(r.id()).copied().unwrap_or_else(|| r.default_enabled()),
        })
        .collect()
}

/// Check whether common CJK + Latin fonts are installed (Windows font dir).
/// Used by the settings UI to guide Chinese font troubleshooting.
#[tauri::command]
pub fn tb_get_cjk_fonts() -> Vec<CjkFontInfo> {
    let font_dir = std::path::Path::new("C:\\Windows\\Fonts");
    let candidates: &[(&str, &str)] = &[
        // CJK
        ("simsun.ttc", "宋体 SimSun"),
        ("simsunb.ttf", "宋体 Bold SimSun-Bold"),
        ("simhei.ttf", "黑体 SimHei"),
        ("msyh.ttc", "微软雅黑 Microsoft YaHei"),
        ("msyhbd.ttc", "微软雅黑 Bold"),
        ("simkai.ttf", "楷体 KaiTi"),
        ("simfang.ttf", "仿宋 FangSong"),
        ("Deng.ttf", "等线 DengXian"),
        ("Dengb.ttf", "等线 Bold"),
        // Latin
        ("times.ttf", "Times New Roman"),
        ("timesbd.ttf", "Times New Roman Bold"),
        ("timesi.ttf", "Times New Roman Italic"),
        ("arial.ttf", "Arial"),
        ("arialbd.ttf", "Arial Bold"),
        ("calibri.ttf", "Calibri"),
        ("calibrib.ttf", "Calibri Bold"),
        ("cambria.ttc", "Cambria"),
        ("cambriab.ttf", "Cambria Bold"),
        ("georgia.ttf", "Georgia"),
        ("georgiab.ttf", "Georgia Bold"),
        ("verdana.ttf", "Verdana"),
        ("cour.ttf", "Courier New"),
        ("courbd.ttf", "Courier New Bold"),
        ("segoeui.ttf", "Segoe UI"),
        ("segoeuib.ttf", "Segoe UI Bold"),
    ];
    candidates
        .iter()
        .map(|(file, name)| CjkFontInfo {
            name: name.to_string(),
            available: font_dir.join(file).exists(),
        })
        .collect()
}

#[derive(Debug, serde::Serialize)]
pub struct CjkFontInfo {
    pub name: String,
    pub available: bool,
}

/// Bundle status for the settings UI.
#[tauri::command]
pub fn tb_get_bundle_status() -> serde_json::Value {
    let dir = crate::core::compiler::bundler::tectonic_cache_root();
    let size = dir_size(&dir);
    let texlive = crate::core::compiler::texlive::SystemTexliveCompiler::new().available();
    serde_json::json!({
        "bundle_dir": dir.to_string_lossy(),
        "bundle_present": crate::core::compiler::bundler::bundle_available(),
        "bundle_bytes": size,
        "system_texlive": texlive,
    })
}

/// Recursive size (bytes) of a directory.
fn dir_size(dir: &std::path::Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// Set the engine preference ("auto" | "tectonic" | "system_texlive").
#[tauri::command]
pub fn tb_set_engine(state: State<'_, AppState>, preference: String) -> Result<(), String> {    let p = match preference.as_str() {
        "auto" => crate::core::settings::EnginePreference::Auto,
        "tectonic" => crate::core::settings::EnginePreference::Tectonic,
        "system_texlive" => crate::core::settings::EnginePreference::SystemTexlive,
        _ => return Err("未知引擎偏好".into()),
    };
    {
        let mut settings = state.settings.write().map_err(|e| e.to_string())?;
        settings.engine = p;
        settings.save().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Set the number of passes for the system texlive driver (1-5).
#[tauri::command]
pub fn tb_set_texlive_passes(state: State<'_, AppState>, passes: u32) -> Result<(), String> {
    let p = passes.clamp(1, 5);
    {
        let mut settings = state.settings.write().map_err(|e| e.to_string())?;
        settings.texlive_passes = p;
        settings.save().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Current texlive passes setting.
#[tauri::command]
pub fn tb_get_texlive_passes(state: State<'_, AppState>) -> u32 {
    state.settings.read().map(|s| s.texlive_passes).unwrap_or(2)
}

/// Current engine preference.
#[tauri::command]
pub fn tb_get_engine(state: State<'_, AppState>) -> String {
    match state.settings.read().map(|s| s.engine).unwrap_or_default() {
        crate::core::settings::EnginePreference::Auto => "auto".into(),
        crate::core::settings::EnginePreference::Tectonic => "tectonic".into(),
        crate::core::settings::EnginePreference::SystemTexlive => "system_texlive".into(),
    }
}

/// Pre-warm the bundle (compiles a tiny doc once so tectonic caches the
/// format + core files; afterwards `-C --only-cached` works offline).
#[tauri::command]
pub async fn tb_download_bundle(app: AppHandle) -> Result<String, String> {
    use crate::core::compiler::bundler;
    let _ = app.emit("tb://bundle-progress", serde_json::json!({ "phase": "download", "downloaded": 0, "total": null }));
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let r = bundler::download_bundle();
        match r {
            Ok(delta) => {
                let total = bundler::cache_size_bytes();
                let _ = app2.emit(
                    "tb://bundle-progress",
                    serde_json::json!({ "phase": "done", "downloaded": total, "total": total }),
                );
                Ok(format!("已下载 {} MB（本次新增 {} MB）到 {}", mb(total), mb(delta), bundler::tectonic_cache_root().display()))
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| format!("bundle 下载任务异常: {e}"))?;
    let _ = app.emit("tb://bundle-progress", serde_json::json!({ "phase": "done" }));
    result
}

fn mb(bytes: u64) -> f64 {
    crate::core::round_f64(bytes as f64 / 1024.0 / 1024.0, 1)
}

/// Word count for the current file or the whole project (comments and
/// command names excluded, command arguments counted as body text).
#[tauri::command]
pub fn tb_count_words(
    state: State<'_, AppState>,
    file: Option<String>,
) -> Result<crate::core::word_count::WordCount, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let mut total = crate::core::word_count::WordCount {
        chars: 0,
        cjk_chars: 0,
        words: 0,
        lines: 0,
    };
    match file.filter(|f| !f.is_empty()) {
        Some(f) => {
            let rel = proj.relative_path(&f);
            if let Ok(src) = proj.read_file(&rel) {
                total = crate::core::word_count::count_source(&src);
            }
        }
        None => {
            for rel in proj.tex_files() {
                if let Ok(src) = proj.read_file(&rel) {
                    let w = crate::core::word_count::count_source(&src);
                    total.chars += w.chars;
                    total.cjk_chars += w.cjk_chars;
                    total.words += w.words;
                    total.lines += w.lines;
                }
            }
        }
    }
    Ok(total)
}
