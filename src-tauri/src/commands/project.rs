//! Project commands: open / create / save / file tree / read-write files.

use crate::core::project::{Project, flatten_tree};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub root: String,
    pub main_file: String,
    pub files: Vec<ProjectFile>,
    pub pdf_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectFile {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub children: Vec<ProjectFile>,
}

fn to_project_file(n: &crate::core::project::FileNode) -> ProjectFile {
    ProjectFile {
        path: n.path.clone(),
        name: n.name.clone(),
        is_dir: n.is_dir,
        children: n.children.iter().map(to_project_file).collect(),
    }
}

/// Emit a project-changed event to the frontend.
pub fn emit_project_changed(app: &AppHandle) {
    let _ = app.emit("tb://project-changed", serde_json::json!({ "ts": chrono_ts() }));
}

fn chrono_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Open a project directory. When `path` is None, show a folder picker.
#[tauri::command]
pub async fn tb_open_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<ProjectInfo, String> {
    let picked = match path {
        Some(p) => Some(PathBuf::from(p)),
        None => app
            .dialog()
            .file()
            .blocking_pick_folder()
            .map(|p| p.into_path())
            .transpose()
            .map_err(|e| format!("选择目录失败: {e}"))?,
    };
    let Some(dir) = picked else {
        return Err("用户取消选择目录".into());
    };
    let proj = Project::open(&dir)?;

    // set up watcher
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = proj.watch(tx)?;
    let app2 = app.clone();
    std::thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            let kind = match ev {
                crate::core::project::WatchEvent::Created(_) => "created",
                crate::core::project::WatchEvent::Modified(_) => "modified",
                crate::core::project::WatchEvent::Removed(_) => "removed",
            };
            let _ = app2.emit("tb://file-changed", serde_json::json!({ "kind": kind }));
        }
    });

    {
        let mut proj_guard = state.project.write().map_err(|e| e.to_string())?;
        *proj_guard = Some(proj);
    }
    *state.watcher.write().map_err(|e| e.to_string())? = Some(handle);
    state
        .settings
        .write()
        .map_err(|e| e.to_string())?
        .remember_project(&dir.to_string_lossy());

    Ok(project_info(&state)?)
}

/// Create a new project under `parent` with `name`, then open it.
#[tauri::command]
pub async fn tb_new_project(
    app: AppHandle,
    state: State<'_, AppState>,
    parent: String,
    name: String,
    template: Option<String>,
) -> Result<ProjectInfo, String> {
    let proj = match template.as_deref() {
        Some(t) if !t.is_empty() => Project::create_with_template(Path::new(&parent), &name, t)?,
        _ => Project::create(Path::new(&parent), &name)?,
    };
    let dir = proj.root.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = proj.watch(tx)?;
    let app2 = app.clone();
    std::thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            let kind = match ev {
                crate::core::project::WatchEvent::Created(_) => "created",
                crate::core::project::WatchEvent::Modified(_) => "modified",
                crate::core::project::WatchEvent::Removed(_) => "removed",
            };
            let _ = app2.emit("tb://file-changed", serde_json::json!({ "kind": kind }));
        }
    });
    {
        let mut proj_guard = state.project.write().map_err(|e| e.to_string())?;
        *proj_guard = Some(proj);
    }
    *state.watcher.write().map_err(|e| e.to_string())? = Some(handle);
    state
        .settings
        .write()
        .map_err(|e| e.to_string())?
        .remember_project(&dir.to_string_lossy());
    Ok(project_info(&state)?)
}

/// Current project info + file tree.
#[tauri::command]
pub fn tb_project_info(state: State<'_, AppState>) -> Result<ProjectInfo, String> {
    project_info(&state)
}

fn project_info(state: &State<'_, AppState>) -> Result<ProjectInfo, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let mut flat = Vec::new();
    flatten_tree(proj.file_tree(), &mut flat);
    let files = proj.file_tree().iter().map(to_project_file).collect();
    let pdf = proj.pdf_path();
    Ok(ProjectInfo {
        root: proj.root.to_string_lossy().to_string(),
        main_file: proj.main_file.clone(),
        files,
        pdf_url: if pdf.exists() {
            Some(pdf.to_string_lossy().to_string())
        } else {
            None
        },
    })
}

/// Available new-project templates.
#[tauri::command]
pub fn tb_get_templates() -> Vec<TemplateInfo> {
    crate::core::project::templates()
        .into_iter()
        .map(|(id, name, _)| TemplateInfo { id: id.to_string(), name: name.to_string() })
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
}

/// Set the project's main file (persisted in .texbutler/main.txt).
#[tauri::command]
pub fn tb_set_main_file(state: State<'_, AppState>, path: String) -> Result<ProjectInfo, String> {
    let mut guard = state.project.write().map_err(|e| e.to_string())?;
    let proj = guard.as_mut().ok_or_else(|| "尚未打开项目".to_string())?;
    proj.set_main_file(&path)?;
    drop(guard);
    project_info(&state)
}

/// Read a file's content (relative path, UTF-8).
#[tauri::command]
pub fn tb_read_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    proj.read_file(&path)
}

/// Save a file (relative path). Returns the new mtime.
#[tauri::command]
pub fn tb_write_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    proj.write_file(&path, &content)?;
    emit_project_changed(&app);
    Ok(())
}

/// Recently opened projects (most recent first).
#[tauri::command]
pub fn tb_recent_projects(state: State<'_, AppState>) -> Vec<String> {
    state.settings.read().map(|s| s.recent_projects.clone()).unwrap_or_default()
}
