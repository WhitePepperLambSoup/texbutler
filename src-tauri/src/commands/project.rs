//! Project commands: open / create / save / file tree / read-write files.

use crate::core::project::{flatten_tree, Project};
use crate::state::AppState;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
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

/// Fetch bibliography metadata for a DOI (Crossref) or arXiv id and return
/// a ready-to-paste BibTeX entry.
#[tauri::command]
pub async fn tb_bib_from_id(identifier: String) -> Result<String, String> {
    let id = identifier.trim();
    if id.is_empty() {
        return Err("请输入 DOI（如 10.1038/nature12373）或 arXiv 编号（如 2401.12345）".into());
    }
    let mut lower = id.to_ascii_lowercase();
    // strip a https://doi.org/ prefix so DOIs pasted as links work too
    lower = lower
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/")
        .trim_start_matches("doi.org/")
        .trim_start_matches("doi:")
        .to_string();
    // --- arXiv: export.arxiv.org Atom feed ---
    // new-style ids (2401.12345) contain a dot; legacy ids (hep-th/9901001)
    // contain a slash — either without a DOI prefix is treated as arXiv
    if lower.contains("arxiv")
        || (lower.contains('/') && !lower.starts_with("10."))
        || (lower.contains('.') && !lower.starts_with("10."))
    {
        let arxid = lower
            .trim_start_matches("arxiv:")
            .trim_start_matches("https://arxiv.org/abs/")
            .trim_start_matches("http://arxiv.org/abs/")
            .to_string();
        let url = format!("https://export.arxiv.org/api/query?id_list={arxid}");
        let xml = reqwest::get(&url)
            .await
            .map_err(|e| format!("arXiv 请求失败: {e}"))?
            .text()
            .await
            .map_err(|e| format!("arXiv 响应读取失败: {e}"))?;
        // the feed has a top-level <title> ("arXiv Query: ..."); the actual
        // paper metadata lives inside the first <entry> block
        let entry_start = xml
            .find("<entry>")
            .ok_or_else(|| "arXiv 未返回结果：请检查编号是否正确".to_string())?;
        let entry_end = xml[entry_start..]
            .find("</entry>")
            .map(|e| entry_start + e)
            .unwrap_or(xml.len());
        let entry = &xml[entry_start..entry_end];
        let grab = |tag: &str| -> String {
            let pat = format!("<{tag}>");
            let end = format!("</{tag}>");
            entry
                .find(&pat)
                .and_then(|s| {
                    let e = entry[s + pat.len()..].find(&end)?;
                    Some(entry[s + pat.len()..s + pat.len() + e].trim().to_string())
                })
                .unwrap_or_default()
        };
        let title = grab("title").replace("  ", " ");
        let published = grab("published");
        let year = published.chars().take(4).collect::<String>();
        let authors: Vec<String> = entry
            .split("<name>")
            .skip(1)
            .map(|s| s.split("</name>").next().unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if title.is_empty() {
            return Err("arXiv 未返回结果：请检查编号是否正确".into());
        }
        let key = bib_key(&title);
        let auth = authors.join(" and ");
        let out = format!(
            "@article{{{key},\n  title = {{{title}}},\n  author = {{{auth}}},\n  year = {{{year}}},\n  eprint = {{{arxid}}},\n  archivePrefix = {{arXiv}},\n}}"
        );
        return Ok(format!("% arXiv:{arxid} — 请核对字段后使用\n{out}"));
    }
    // --- DOI: Crossref REST API ---
    if lower.starts_with("10.") {
        let url = format!("https://api.crossref.org/works/{}", lower);
        let resp = reqwest::get(&url)
            .await
            .map_err(|e| format!("Crossref 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "Crossref 未找到该 DOI（HTTP {}）",
                resp.status().as_u16()
            ));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Crossref 响应解析失败: {e}"))?;
        let m = &json["message"];
        let title = m["title"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if title.is_empty() {
            return Err("Crossref 返回的条目缺少标题".into());
        }
        let authors: Vec<String> = m["author"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| {
                        let family = a["family"].as_str().unwrap_or("");
                        let given = a["given"].as_str().unwrap_or("");
                        if family.is_empty() && given.is_empty() {
                            None
                        } else {
                            Some(format!("{given} {family}").trim().to_string())
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let year = m["issued"]["date-parts"]
            .as_array()
            .and_then(|dp| dp.first())
            .and_then(|d| d.as_array())
            .and_then(|d| d.first())
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let journal = m["container-title"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let volume = m["volume"].as_str().unwrap_or("");
        let pages = m["page"].as_str().unwrap_or("");
        let key = bib_key(title);
        let auth = if authors.is_empty() {
            "TODO: 作者".to_string()
        } else {
            authors.join(" and ")
        };
        let mut entry = format!(
            "@article{{{key},\n  title = {{{title}}},\n  author = {{{auth}}},\n  journal = {{{journal}}},\n  year = {{{year}}}"
        );
        if !volume.is_empty() {
            entry.push_str(&format!(",\n  volume = {{{volume}}}"));
        }
        if !pages.is_empty() {
            entry.push_str(&format!(",\n  pages = {{{pages}}}"));
        }
        entry.push_str(&format!(",\n  doi = {{{id}}},\n}}"));
        return Ok(format!("% DOI:{id} — 请核对字段后使用\n{entry}"));
    }
    Err("无法识别的标识符：请输入 DOI（10.xxxx/yyyy）或 arXiv 编号（2401.12345）".into())
}

/// Build a stable BibTeX key from a title: first word-ish + next
/// significant words, lowercased.
fn bib_key(title: &str) -> String {
    let words: Vec<&str> = title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let mut key = words
        .first()
        .unwrap_or(&"ref")
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    for w in words.iter().skip(1).take(2) {
        let wl = w.to_lowercase();
        if !["the", "a", "an", "on", "of", "for", "and", "in"].contains(&wl.as_str()) {
            key.push_str(&wl);
        }
    }
    key
}

/// Emit a project-changed event to the frontend.
pub fn emit_project_changed(app: &AppHandle) {
    let _ = app.emit(
        "tb://project-changed",
        serde_json::json!({ "ts": chrono_ts() }),
    );
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
        state.project_generation.fetch_add(1, Ordering::SeqCst);
        *state.last_result.write().map_err(|e| e.to_string())? = None;
    }
    *state.watcher.write().map_err(|e| e.to_string())? = Some(handle);

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
            // validate the template id (no traversal) before any join;
            // use the normalized name for both builtin match and file join
            let t = validate_template_name(t)?;
            // New projects only use the fixed built-in seed list. Saved
            // templates are imported into an already-open project instead.
            let builtin = crate::core::project::templates()
                .iter()
                .any(|(id, _, _)| *id == t);
            if builtin {
                Project::create_with_template(Path::new(&parent), &name, &t)?
            } else {
                return Err(format!("模板不存在: {t}"));
            }
        }
        _ => Project::create(Path::new(&parent), &name)?,
    };
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
        state.project_generation.fetch_add(1, Ordering::SeqCst);
        *state.last_result.write().map_err(|e| e.to_string())? = None;
    }
    *state.watcher.write().map_err(|e| e.to_string())? = Some(handle);
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
        .map(|(id, name, _)| TemplateInfo {
            id: id.to_string(),
            name: name.to_string(),
            source: "builtin".into(),
        })
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
        return Err(format!(
            "不支持的图片格式: {ext}（支持 png/jpg/jpeg/gif/svg/pdf/eps）"
        ));
    }
    if !src.is_file() {
        return Err("源图片文件不存在".into());
    }
    let fname = src
        .file_name()
        .ok_or_else(|| "无效文件名".to_string())?
        .to_string_lossy()
        .to_string();
    let mut target = proj.root.join(&fname);
    let mut n = 1usize;
    while target.exists() {
        let stem = src.file_stem().unwrap_or_default().to_string_lossy();
        target = proj.root.join(format!("{stem}_{n}.{ext}"));
        n += 1;
    }
    let target_canon = proj.canonical_inside(&target)?;
    // auto-compress oversized PNG/JPG imports (large screenshots slow the
    // compiler; cap the long edge at 2048 px)
    if matches!(ext.as_str(), "png" | "jpg" | "jpeg") {
        if let Ok(meta) = src.metadata() {
            if meta.len() > 1_048_576 {
                if let Ok(img) = image::open(src) {
                    let (w, h) = img.dimensions();
                    let scale = (2048.0_f32 / w.max(h) as f32).min(1.0);
                    if scale < 1.0 {
                        let resized = img.resize(
                            ((w as f32) * scale).max(1.0) as u32,
                            ((h as f32) * scale).max(1.0) as u32,
                            image::imageops::FilterType::Lanczos3,
                        );
                        let out = if ext == "png" {
                            image::ImageFormat::Png
                        } else {
                            image::ImageFormat::Jpeg
                        };
                        let mut buf = Vec::new();
                        if resized
                            .write_to(&mut std::io::Cursor::new(&mut buf), out)
                            .is_ok()
                        {
                            std::fs::write(&target_canon, buf)
                                .map_err(|e| format!("压缩图片失败: {e}"))?;
                            drop(guard);
                            if let Ok(mut g) = state.project.write() {
                                if let Some(p) = g.as_mut() {
                                    let _ = p.scan();
                                }
                            }
                            return Ok(target
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string());
                        }
                    }
                }
            }
        }
    }
    std::fs::copy(src, &target_canon).map_err(|e| format!("复制图片失败: {e}"))?;
    drop(guard);
    // refresh the file tree (scan needs a write lock)
    if let Ok(mut g) = state.project.write() {
        if let Some(p) = g.as_mut() {
            let _ = p.scan();
        }
    }
    Ok(target
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string())
}

/// Import an image from the clipboard (screenshot) into the project root.
/// Returns the file name to reference in `\includegraphics`.
#[tauri::command]
pub fn tb_import_clipboard_image(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let image = app
        .clipboard()
        .read_image()
        .map_err(|e| format!("剪贴板中没有图片或读取失败: {e}"))?;
    let png = {
        let rgba = image.rgba();
        let w = image.width() as u32;
        let h = image.height() as u32;
        if w == 0 || h == 0 {
            return Err("剪贴板图片尺寸无效".into());
        }
        let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())
            .ok_or_else(|| "剪贴板图片数据无效".to_string())?;
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        image::write_buffer_with_format(
            &mut cursor,
            img.as_raw(),
            w,
            h,
            image::ExtendedColorType::Rgba8,
            image::ImageFormat::Png,
        )
        .map_err(|e| format!("图片编码失败: {e}"))?;
        buf
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let fname = format!("clipboard_{ts}.png");
    let mut target = proj.root.join(&fname);
    let mut n = 1usize;
    while target.exists() {
        target = proj.root.join(format!("clipboard_{ts}_{n}.png"));
        n += 1;
    }
    std::fs::write(&proj.canonical_inside(&target)?, png)
        .map_err(|e| format!("保存图片失败: {e}"))?;
    drop(guard);
    if let Ok(mut g) = state.project.write() {
        if let Some(p) = g.as_mut() {
            let _ = p.scan();
        }
    }
    Ok(target
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string())
}

/// Scan the project's `.bib` files and return parsed entries (with their
/// location for click-to-jump in the reference panel).
#[tauri::command]
pub fn tb_list_bib_entries(
    state: State<'_, AppState>,
) -> Result<Vec<crate::core::bib::BibEntry>, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let mut out: Vec<crate::core::bib::BibEntry> = Vec::new();
    for rel in proj.bib_files() {
        let Some(content) = proj.read_file(&rel).ok() else {
            continue;
        };
        for mut entry in crate::core::bib::parse_bib(&content) {
            if let Some((idx, _)) = content.lines().enumerate().find(|(_, l)| {
                l.contains(&format!("@{}", entry.entry_type))
                    && l.contains(&format!("{{{},", entry.key))
            }) {
                entry.file = Some(rel.clone());
                entry.line = Some(idx + 1);
            }
            out.push(entry);
        }
    }
    Ok(out)
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
        let proj = guard
            .as_ref()
            .ok_or_else(|| "尚未打开项目".to_string())?
            .clone();
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
            crate::core::ai::ChatMsg {
                role: "system".into(),
                content: system.into(),
            },
            crate::core::ai::ChatMsg {
                role: "user".into(),
                content: user_prompt,
            },
        ],
    )
    .await
    .map_err(|e| e.to_string())?;
    let code = reply.trim().to_string();
    if code.is_empty() {
        return Err("AI 返回为空，请检查模型配置".into());
    }
    // AI-output size guard (untrusted model output)
    const MAX_LATEX_BYTES: usize = 2 * 1024 * 1024;
    if code.len() > MAX_LATEX_BYTES {
        return Err(format!(
            "AI 生成的 LaTeX 过大（{} 字节，上限 2MB），已拒绝写入",
            code.len()
        ));
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
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
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

/// Validate a template name: no path separators, no traversal.
/// Returns the normalized (trimmed) name for consistent use by all callers.
pub(crate) fn validate_template_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("模板名不合法（不能含路径分隔符）".into());
    }
    Ok(name.to_string())
}

/// Save the current project as a reusable user template.
#[tauri::command]
pub fn tb_save_template(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let project = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    crate::commands::templates::save_user_template_at(&project.root, &user_template_dir(), &name)
}

/// List user-saved templates.
#[tauri::command]
pub fn tb_list_templates() -> Vec<TemplateInfo> {
    crate::commands::templates::list_user_templates_at(&user_template_dir())
}

/// Delete a user-saved template.
#[tauri::command]
pub fn tb_delete_template(name: String) -> Result<(), String> {
    crate::commands::templates::delete_user_template_at(&user_template_dir(), &name)
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

/// Create a new file inside the project. `.tex` files can be seeded from a
/// small built-in template (article/ctexart/report/beamer/minimal); other
/// extensions start empty. Refuses existing paths and path traversal.
#[tauri::command]
pub fn tb_new_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    template: Option<String>,
) -> Result<(), String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let rel = proj.relative_path(&path);
    if rel.contains(':') || rel.starts_with('/') || rel.starts_with('\\') {
        return Err("非法路径".to_string());
    }
    if rel.is_empty() || rel == "." {
        return Err("文件名为空".to_string());
    }
    if proj.resolve(&rel).is_none() {
        return Err("非法路径".to_string());
    }
    let full = proj.root.join(&rel);
    if full.exists() {
        return Err(format!("文件已存在: {rel}"));
    }
    let content: String = match template.as_deref() {
        Some(t) if t == "article" => TEMPLATE_ARTICLE.to_string(),
        Some(t) if t == "ctexart" => TEMPLATE_CTEXART.to_string(),
        Some(t) if t == "report" => TEMPLATE_REPORT.to_string(),
        Some(t) if t == "beamer" => TEMPLATE_BEAMER.to_string(),
        Some(t) if t == "minimal" => TEMPLATE_MINIMAL.to_string(),
        _ => String::new(),
    };
    // use write_file so symlink escape is canonical-guarded (a project
    // symlink dir pointing outside must not make the write land outside)
    proj.write_file(&rel, &content)?;
    emit_project_changed(&app);
    Ok(())
}

const TEMPLATE_ARTICLE: &str = "\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\title{Title}\n\\author{Author}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\section{Introduction}\n\nWrite here.\n\n\\end{document}\n";

const TEMPLATE_CTEXART: &str = "\\documentclass{ctexart}\n\\title{标题}\n\\author{作者}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\section{引言}\n\n在此书写内容。\n\n\\end{document}\n";

const TEMPLATE_REPORT: &str = "\\documentclass[12pt,a4paper]{report}\n\\usepackage[utf8]{inputenc}\n\\title{Report Title}\n\\author{Author}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\\tableofcontents\n\n\\chapter{Introduction}\n\nWrite here.\n\n\\end{document}\n";

const TEMPLATE_BEAMER: &str = "\\documentclass{beamer}\n\\usetheme{metropolis}\n\\title{Presentation Title}\n\\author{Author}\n\\date{\\today}\n\n\\begin{document}\n\\begin{frame}\n  \\titlepage\n\\end{frame}\n\n\\begin{frame}{Outline}\n  \\tableofcontents\n\\end{frame}\n\n\\section{Introduction}\n\\begin{frame}{Introduction}\n  Content here.\n\\end{frame}\n\n\\end{document}\n";

const TEMPLATE_MINIMAL: &str =
    "\\documentclass{article}\n\\begin{document}\nHello, world!\n\\end{document}\n";

/// A `\label{key}` found in the project (for ref/cite autocompletion).
#[derive(serde::Serialize)]
pub struct RefLabel {
    pub key: String,
    pub file: String,
    pub line: usize,
}

/// Index of every label and bib entry in the project, used by the Monaco
/// `\ref`/`\cite` completion providers.
#[tauri::command]
pub fn tb_ref_index(state: State<'_, AppState>) -> Result<RefIndex, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let mut labels: Vec<RefLabel> = Vec::new();
    for rel in proj.tex_files() {
        let Ok(content) = proj.read_file(&rel) else {
            continue;
        };
        for (key, line) in crate::core::rules::refs::scan_labels(&content) {
            labels.push(RefLabel {
                key,
                file: proj.relative_path(&rel),
                line,
            });
        }
    }
    let mut bib: Vec<crate::core::bib::BibEntry> = Vec::new();
    for rel in proj.bib_files() {
        let Ok(content) = proj.read_file(&rel) else {
            continue;
        };
        let entries = crate::core::bib::parse_bib(&content);
        // attach the entry's location for Ctrl+Click navigation: the line
        // where `@<type>{<key>,` appears (entry_type + key on one line)
        for mut e in entries {
            if let Some((idx, _)) = content.lines().enumerate().find(|(_, l)| {
                l.contains(&format!("@{}", e.entry_type)) && l.contains(&format!("{{{},", e.key))
            }) {
                e.file = Some(rel.clone());
                e.line = Some(idx + 1);
            }
            bib.push(e);
        }
    }
    Ok(RefIndex { labels, bib })
}

#[derive(serde::Serialize)]
pub struct RefIndex {
    pub labels: Vec<RefLabel>,
    pub bib: Vec<crate::core::bib::BibEntry>,
}

/// One TODO/FIXME/HACK marker found inside a LaTeX comment.
#[derive(serde::Serialize)]
pub struct TodoHit {
    pub file: String,
    pub line: usize,
    pub text: String,
}

/// Scan every `.tex` file for TODO / FIXME / HACK / XXX markers inside
/// comments (`% ... TODO ...`). Returns hits sorted by file then line.
#[tauri::command]
pub fn tb_scan_todos(state: State<'_, AppState>) -> Result<Vec<TodoHit>, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let mut out: Vec<TodoHit> = Vec::new();
    const KEYWORDS: [&str; 4] = ["TODO", "FIXME", "HACK", "XXX"];
    for rel in proj.tex_files() {
        let Ok(content) = proj.read_file(&rel) else {
            continue;
        };
        for (i, line) in content.lines().enumerate() {
            // only markers inside comments: everything from the first `%`
            let Some(pct) = line.find('%') else { continue };
            let after = &line[pct + 1..];
            let trimmed = after.trim();
            if trimmed.is_empty() {
                continue;
            }
            for kw in KEYWORDS {
                if let Some(pos) = trimmed.find(kw) {
                    out.push(TodoHit {
                        file: proj.relative_path(&rel),
                        line: i + 1,
                        text: trimmed[pos..].to_string(),
                    });
                    break;
                }
            }
        }
    }
    Ok(out)
}

/// Every compilable document root in the project (files containing
/// `\documentclass`) — the multi-document compile-target dropdown.
#[tauri::command]
pub fn tb_list_roots(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    Ok(proj.document_roots())
}

/// SyncTeX forward search: map (tex file, line) to the PDF page number.
/// Prefers the system `synctex` CLI (handles the compact MiKTeX/TeX Live
/// v1 format), falls back to parsing `<build>/<main stem>.synctex.gz`
/// (classic format produced by tectonic).
#[tauri::command]
pub fn tb_synctex_forward(
    state: State<'_, AppState>,
    file: String,
    line: usize,
) -> Result<Option<u32>, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let build_dir = proj.root.join(".texbutler").join("build");
    // Use the LAST COMPILED OUTPUT (pdf_path recorded by the compiler) so a
    // multi-document project locates the PDF that actually corresponds to
    // the file being edited — `main.tex` is not necessarily the target.
    // Fall back to main.tex's stem when nothing has been compiled yet.
    let pdf_path = state
        .last_result
        .read()
        .ok()
        .and_then(|g| g.as_ref().and_then(|r| r.pdf_path.clone()))
        .map(|p| std::path::PathBuf::from(p))
        // guard against a stale result from a previously opened project:
        // only trust PDFs inside THIS project's build dir
        .filter(|p| p.exists() && p.starts_with(&build_dir))
        .unwrap_or_else(|| {
            let main_rel = proj.relative_path(&proj.main_file);
            let stem = main_rel.trim_end_matches(".tex");
            build_dir.join(format!("{stem}.pdf"))
        });

    // 1) system synctex CLI (MiKTeX / TeX Live ship it); the synctex.gz
    // records absolute paths, so pass the absolute source path. The path
    // is validated to stay inside the project (no traversal into the CLI).
    let rel = proj.relative_path(&file);
    if pdf_path.exists() && proj.resolve(&rel).is_some() {
        let abs = proj.root.join(&rel);
        if let Some(page) =
            crate::core::synctex::system_forward("synctex", &pdf_path, &abs.to_string_lossy(), line)
        {
            return Ok(Some(page));
        }
    }
    // 2) classic .synctex.gz parse (tectonic) — same stem as the PDF
    let gz_path = pdf_path.with_extension("synctex.gz");
    if let Ok(gz) = std::fs::read(&gz_path) {
        if let Some(page) = crate::core::synctex::forward_search(&gz, &rel, line) {
            return Ok(Some(page));
        }
    }
    Ok(None)
}

/// Export a project file to Markdown or Word. Returns the exported file
/// path (written next to the source file, `<stem>.md` / `<stem>.docx`).
#[tauri::command]
pub fn tb_export(
    state: State<'_, AppState>,
    file: String,
    format: String,
) -> Result<String, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
    let rel = proj.relative_path(&file);
    let src = proj.read_file(&rel)?;
    let md = crate::core::export::to_markdown(&src);
    // output path next to the source, validated to stay inside the project
    let stem = rel.trim_end_matches(".tex");
    let out_rel = proj
        .resolve(&format!("{stem}.md"))
        .ok_or_else(|| "非法导出路径".to_string())?;
    match format.to_ascii_lowercase().as_str() {
        "md" | "markdown" => {
            let out_canon = proj.canonical_inside(&proj.root.join(&out_rel))?;
            std::fs::write(&out_canon, md).map_err(|e| e.to_string())?;
            // return the readable (non-canonical) path — canonicalize adds
            // a `\\\\?\\` prefix on Windows that is ugly and would not
            // round-trip through resolve()
            Ok(proj.root.join(&out_rel).to_string_lossy().to_string())
        }
        "docx" | "word" => {
            let bytes = crate::core::export::to_docx(&md)?;
            let out_rel = proj
                .resolve(&format!("{stem}.docx"))
                .ok_or_else(|| "非法导出路径".to_string())?;
            let out_canon = proj.canonical_inside(&proj.root.join(&out_rel))?;
            std::fs::write(&out_canon, bytes).map_err(|e| e.to_string())?;
            Ok(proj.root.join(&out_rel).to_string_lossy().to_string())
        }
        other => Err(format!("不支持的导出格式: {other}（支持 md / docx）")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_compress_pipeline_works_on_real_png() {
        // regression probe: import-compress chain (open -> resize -> write)
        // must succeed on a legitimately-encoded PNG
        let png = Path::new("D:/reasonix program/idea/tex/assets/e2e/big-test.png");
        if !png.exists() {
            eprintln!("probe png missing — skipping (generated by PowerShell)");
            return;
        }
        let img = image::open(png).expect("image::open must decode the PNG");
        let (w, h) = img.dimensions();
        let scale = (2048.0_f32 / w.max(h) as f32).min(1.0);
        assert!(scale < 1.0, "4.4MB random PNG should exceed 2048px edge");
        let resized = img.resize(
            ((w as f32) * scale).max(1.0) as u32,
            ((h as f32) * scale).max(1.0) as u32,
            image::imageops::FilterType::Lanczos3,
        );
        let mut buf = Vec::new();
        resized
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .expect("PNG encode must succeed");
        // PNG is lossless: random-noise fixtures can't shrink, but the
        // resize must have cut the pixel count (dimensions <= 2048 edge)
        assert!(
            resized.width() <= 2048 && resized.height() <= 2048,
            "resize must cap the long edge at 2048px, got {}x{}",
            resized.width(),
            resized.height()
        );
        assert!(!buf.is_empty(), "encoded PNG must not be empty");
    }

    #[test]
    fn parses_simple_bib_entry() {
        let src = "@article{smith2024,\n  title = {A Study on Chinese Typesetting},\n  author = {Smith, John and Li, Wei},\n  year = {2024},\n  journal = {J. Typography}\n}\n";
        let entries = crate::core::bib::parse_bib(src);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "smith2024");
        assert_eq!(entries[0].entry_type, "article");
        assert_eq!(entries[0].title, "A Study on Chinese Typesetting");
        assert!(entries[0].author.contains("Li, Wei"));
        assert_eq!(entries[0].year, "2024");
    }

    #[test]
    fn parses_multiple_entries_and_skips_comments() {
        let src = "@comment{a note}\n@book{knuth1984,\n  title = {The TeXbook},\n  author = {Knuth, Donald},\n  year = {1984}\n}\n@inproceedings{li2020, title={X}, year={2020}}\n";
        let entries = crate::core::bib::parse_bib(src);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "knuth1984");
        assert_eq!(entries[0].entry_type, "book");
        assert_eq!(entries[1].key, "li2020");
        assert_eq!(entries[1].year, "2020");
    }

    #[test]
    fn handles_string_quoted_fields_and_nested_braces() {
        let src = "@article{nested2023,\n  title = {Nested {Braces} Inside},\n  author = \"Doe, Jane\",\n  year = {2023}\n}\n";
        let entries = crate::core::bib::parse_bib(src);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Nested {Braces} Inside");
        assert_eq!(entries[0].author, "Doe, Jane");
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(crate::core::bib::parse_bib("").is_empty());
        assert!(crate::core::bib::parse_bib("no entries here").is_empty());
    }

    #[test]
    fn skips_string_and_preamble_entries() {
        let src = "@string{jour = {Journal of X}}\n@article{key2020, title={T}, year={2020}}\n@preamble{\"\\\\newcommand\"}\n";
        let entries = crate::core::bib::parse_bib(src);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "key2020");
        assert_eq!(entries[0].title, "T");
    }

    #[test]
    fn field_boundary_ignores_subtitle() {
        let src =
            "@article{b2021,\n  title = {Real Title},\n  subtitle = {Sub},\n  year = {2021}\n}\n";
        let entries = crate::core::bib::parse_bib(src);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Real Title");
        assert_eq!(entries[0].year, "2021");
    }
}
