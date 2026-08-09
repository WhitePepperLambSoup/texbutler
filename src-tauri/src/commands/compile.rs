//! Compile commands: run compile asynchronously, cancel, query status.
//! Progress and completion are pushed to the frontend via Tauri events.

use crate::core::compiler::{CompileResult, CompilerScheduler};
use crate::core::settings::Settings;
use crate::state::AppState;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
pub struct CompileProgress {
    pub stage: String,
    pub progress: f32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompileDoneEvent {
    pub root: String,
    pub result: CompileResult,
}

pub fn emit_compile_done(app: &AppHandle, root: &Path, result: &CompileResult) {
    let _ = app.emit(
        "tb://compile-done",
        CompileDoneEvent {
            root: root.to_string_lossy().to_string(),
            result: result.clone(),
        },
    );
}

/// Start an async compile of the current project.
/// `main_override` (optional relative path) compiles that file instead of
/// the project's main file (used for "编译当前文件").
#[tauri::command]
pub async fn tb_compile(
    app: AppHandle,
    state: State<'_, AppState>,
    main_override: Option<String>,
) -> Result<(), String> {
    let (root, main, project_generation) = {
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
        let target = match main_override.filter(|p| !p.is_empty()) {
            Some(p) => {
                // validate: only project-internal files may be compiled
                if proj.resolve(&p).is_none() || !proj.root.join(&p).exists() {
                    return Err(format!("非法编译目标: {p}"));
                }
                p
            }
            None => proj.main_file.clone(),
        };
        (
            proj.root.clone(),
            target,
            state.project_generation.load(Ordering::SeqCst),
        )
    };
    if !root.exists() {
        return Err("项目目录不存在".into());
    }

    // reset cancel flag and mark running
    state.cancel_flag.store(false, Ordering::SeqCst);
    let _ = app.emit(
        "tb://compile-progress",
        CompileProgress {
            stage: "prepare".into(),
            progress: 0.0,
            message: "准备编译…".into(),
        },
    );

    // read settings snapshot for the scheduler
    let settings: Settings = state.settings.read().map_err(|e| e.to_string())?.clone();
    let scheduler = CompilerScheduler::new_with_passes(settings.engine, settings.texlive_passes);

    let app2 = app.clone();
    let cancel = state.cancel_flag.clone();
    let proj = crate::core::project::Project::open(&root)?;
    let main_owned = main.clone();

    // Compilation is CPU-bound + blocking (tectonic engine) → spawn_blocking.
    let proj_for_job = proj.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let _ = app2.emit(
            "tb://compile-progress",
            CompileProgress {
                stage: "run".into(),
                progress: 0.3,
                message: format!("使用 {} 编译中…", scheduler_preview(&settings)),
            },
        );
        let result = scheduler.compile(&proj_for_job, Path::new(&main_owned), &|| {
            cancel.load(Ordering::SeqCst)
        });
        result
    });

    let result: CompileResult = match handle.await {
        Ok(r) => r,
        Err(e) => CompileResult::failed(
            proj.log_path(),
            crate::core::compiler::EngineUsed::Tectonic,
            &format!("编译任务异常终止: {e}"),
        ),
    };

    let _ = app.emit(
        "tb://compile-progress",
        CompileProgress {
            stage: "done".into(),
            progress: 1.0,
            message: if result.ok {
                "编译完成".into()
            } else {
                "编译失败".into()
            },
        },
    );
    state.publish_compile_result_if_current(project_generation, &root, &result, || {
        emit_compile_done(&app, &root, &result);
    })?;
    Ok(())
}

fn scheduler_preview(s: &Settings) -> &'static str {
    match s.engine {
        crate::core::settings::EnginePreference::Auto => "自动（Tectonic → 系统 TeX）",
        crate::core::settings::EnginePreference::Tectonic => "Tectonic 内置内核",
        crate::core::settings::EnginePreference::SystemTexlive => "系统 TeX Live / MiKTeX",
    }
}

/// Cancel the in-flight compile (best effort; the engine stops at its next
/// status check).
#[tauri::command]
pub fn tb_cancel_compile(state: State<'_, AppState>) {
    state.cancel_flag.store(true, Ordering::SeqCst);
}

/// Latest compile result.
#[tauri::command]
pub fn tb_get_last_result(state: State<'_, AppState>) -> Result<Option<CompileResult>, String> {
    Ok(state.last_result.read().map_err(|e| e.to_string())?.clone())
}

/// Read the raw LaTeX log of the last compile (for the log viewer).
#[tauri::command]
pub fn tb_read_log(state: State<'_, AppState>) -> Result<String, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let log = proj.log_path();
    if !log.exists() {
        return Err("还没有日志文件（请先编译一次）".into());
    }
    std::fs::read_to_string(&log).map_err(|e| format!("读取日志失败: {e}"))
}
