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
        Some(t) if !t.is_empty() => {
            // built-in template first, then user-saved template
            let builtin = crate::core::project::templates().iter().any(|(id, _, _)| *id == t);
            if builtin {
                Project::create_with_template(Path::new(&parent), &name, t)?
            } else {
                let user_path = user_template_dir().join(format!("{t}.tex"));
                if user_path.exists() {
                    let content = std::fs::read_to_string(&user_path).map_err(|e| e.to_string())?;
                    let dir = Path::new(&parent).join(&name);
                    if dir.exists() {
                        return Err(format!("目录已存在: {}", dir.display()));
                    }
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    std::fs::write(dir.join("main.tex"), content).map_err(|e| e.to_string())?;
                    std::fs::create_dir_all(dir.join(".texbutler")).ok();
                    Project::open(&dir)?
                } else {
                    return Err(format!("模板不存在: {t}"));
                }
            }
        }
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
        .map(|(id, name, _)| TemplateInfo { id: id.to_string(), name: name.to_string(), source: "builtin".into() })
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub source: String,
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

/// Import an image file into the project root (unique name on conflict).
/// Returns the file name to reference in `\includegraphics`.
#[tauri::command]
pub fn tb_import_image(state: State<'_, AppState>, source_path: String) -> Result<String, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let src = Path::new(&source_path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "gif", "svg", "pdf", "eps"].contains(&ext.as_str()) {
        return Err(format!("不支持的图片格式: {ext}（支持 png/jpg/jpeg/gif/svg/pdf/eps）"));
    }
    if !src.is_file() {
        return Err("源图片文件不存在".into());
    }
    let fname = src.file_name().ok_or_else(|| "无效文件名".to_string())?.to_string_lossy().to_string();
    let mut target = proj.root.join(&fname);
    let mut n = 1usize;
    while target.exists() {
        let stem = src.file_stem().unwrap_or_default().to_string_lossy();
        target = proj.root.join(format!("{stem}_{n}.{ext}"));
        n += 1;
    }
    std::fs::copy(src, &target).map_err(|e| format!("复制图片失败: {e}"))?;
    drop(guard);
    // refresh the file tree (scan needs a write lock)
    if let Ok(mut g) = state.project.write() {
        if let Some(p) = g.as_mut() {
            let _ = p.scan();
        }
    }
    Ok(target.file_name().unwrap_or_default().to_string_lossy().to_string())
}

/// Import a Word (.docx) document: parse its structure, let the AI convert
/// it into a complete LaTeX document and write it into the project.
/// Returns the created file name.
#[tauri::command]
pub async fn tb_import_docx(
    app: AppHandle,
    state: State<'_, AppState>,
    source_path: String,
) -> Result<serde_json::Value, String> {
    let (proj, settings) = {
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?.clone();
        let settings = state.settings.read().map_err(|e| e.to_string())?.ai.clone();
        (proj, settings)
    };
    let path = std::path::Path::new(&source_path);
    if !path.is_file() {
        return Err("docx 文件不存在".into());
    }
    // 1) parse
    let blocks = crate::core::docx::parse_docx(path).map_err(|e| e.to_string())?;
    let markdown = crate::core::docx::render_markdown(&blocks);
    if markdown.trim().is_empty() {
        return Err("未能从 docx 中提取到文本内容".into());
    }
    // 2) AI conversion (async; blocking chat is fine on the tokio runtime)
    let system = "你是 TeXButler 的 Word 转 LaTeX 助手。把用户提供的文档内容转换成一份完整、可直接编译的中文 LaTeX 文档（ctexart）。\
规则：1) 只输出 LaTeX 代码（含 \\documentclass 到 \\end{document}），不要 Markdown 围栏与解释；\
2) 标题用 \\section/\\subsection；段落用空行分隔；表格转成 booktabs 风格（\\toprule/\\midrule/\\bottomrule，先 \\usepackage{booktabs}）；\
3) 中文规范：百分号转义 \\%、中文字体不用斜体、表格单元格内用 {\\bfseries ...}；\
4) 合理使用公式环境把文档中的数学内容（如 a^2、1/2）转成正确的 LaTeX 公式。";
    let user_prompt = format!(
        "请把下面从 Word 提取的内容转换为完整 LaTeX 文档：\n\n{}",
        markdown
    );
    let reply = crate::core::ai::chat(
        &settings,
        &[
            crate::core::ai::ChatMsg { role: "system".into(), content: system.into() },
            crate::core::ai::ChatMsg { role: "user".into(), content: user_prompt },
        ],
    )
    .await
    .map_err(|e| e.to_string())?;
    let code = reply.trim().to_string();
    if code.is_empty() {
        return Err("AI 返回为空，请检查模型配置".into());
    }
    // strip fences if any
    let code = code
        .strip_prefix("```")
        .map(|s| {
            let body = match s.find('\n') {
                Some(nl) => &s[nl + 1..],
                None => s,
            };
            body.trim_end_matches("```").trim().to_string()
        })
        .unwrap_or(code);

    // 3) write into project with a unique name
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let mut fname = format!("{stem}.tex");
    let mut n = 1usize;
    while proj.resolve(&fname).map(|p| p.exists()).unwrap_or(false) {
        fname = format!("{stem}_{n}.tex");
        n += 1;
    }
    proj.write_file(&fname, &code)?;
    let _ = app.emit("tb://project-changed", serde_json::json!({ "ts": 0 }));
    Ok(serde_json::json!({
        "file": fname,
        "preview": code.chars().take(400).collect::<String>(),
        "chars": code.chars().count(),
    }))
}

/// User template directory (%APPDATA%/texbutler/templates).
pub fn user_template_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("texbutler")
        .join("templates")
}

/// Save the current project's main.tex as a reusable user template.
#[tauri::command]
pub fn tb_save_template(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("模板名不合法（不能含路径分隔符）".into());
    }
    let content = {
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
        proj.read_file(&proj.main_file)?
    };
    let dir = user_template_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.tex"));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// List all templates: built-in + user-saved.
#[tauri::command]
pub fn tb_list_templates() -> Vec<TemplateInfo> {
    let mut items: Vec<TemplateInfo> = crate::core::project::templates()
        .into_iter()
        .map(|(id, name, _)| TemplateInfo { id: id.to_string(), name: name.to_string(), source: "builtin".into() })
        .collect();
    if let Ok(rd) = std::fs::read_dir(user_template_dir()) {
        let mut users: Vec<TemplateInfo> = rd
            .flatten()
            .filter(|e| e.path().extension().map(|x| x == "tex").unwrap_or(false))
            .map(|e| {
                let stem = e.path().file_stem().unwrap_or_default().to_string_lossy().to_string();
                TemplateInfo { id: stem.clone(), name: format!("{stem}（我的模板）"), source: "user".into() }
            })
            .collect();
        users.sort_by(|a, b| a.id.cmp(&b.id));
        items.extend(users);
    }
    items
}

/// Delete a user-saved template.
#[tauri::command]
pub fn tb_delete_template(name: String) -> Result<(), String> {
    let path = user_template_dir().join(format!("{name}.tex"));
    if !path.exists() {
        return Err("模板不存在".into());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
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
