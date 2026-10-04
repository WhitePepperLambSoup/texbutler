//! Project-wide tools: search & replace, local file history, Git status,
//! the label/citation report and SyncTeX positions (forward + reverse).

use crate::commands::files::current_pdf;
use crate::commands::project::emit_project_changed;
use crate::core::search::{ReplaceResult, SearchOptions, SearchResult};
use crate::state::AppState;
use tauri::{AppHandle, State};

fn project(state: &State<'_, AppState>) -> Result<crate::core::project::Project, String> {
    let guard = state.project.read().map_err(|e| e.to_string())?;
    guard.as_ref().cloned().ok_or_else(|| "尚未打开项目".to_string())
}

// ---------------------------------------------------------------- search

#[tauri::command]
pub async fn tb_search_project(state: State<'_, AppState>, options: SearchOptions) -> Result<SearchResult, String> {
    let proj = project(&state)?;
    tokio::task::spawn_blocking(move || crate::core::search::search(&proj, &options))
        .await
        .map_err(|e| e.to_string())?
}

/// Replace every match in the given files (all text files when `files` is
/// None). Each changed file's previous content is kept in local history,
/// so the whole operation can be undone per file from "文件历史".
#[tauri::command]
pub async fn tb_replace_in_project(
    app: AppHandle,
    state: State<'_, AppState>,
    options: SearchOptions,
    replacement: String,
    files: Option<Vec<String>>,
) -> Result<ReplaceResult, String> {
    let proj = project(&state)?;
    let result = tokio::task::spawn_blocking(move || -> Result<ReplaceResult, String> {
        let re = crate::core::search::build_regex(&options)?;
        let targets = match files {
            Some(list) => list
                .into_iter()
                .map(|f| crate::commands::files::clean_rel(&proj, &f))
                .collect::<Result<Vec<_>, _>>()?,
            None => crate::core::search::text_files(&proj),
        };
        let mut out = ReplaceResult { files_changed: Vec::new(), replacements: 0 };
        for rel in targets {
            let Ok(content) = proj.read_file(&rel) else { continue };
            let (next, n) = crate::core::search::replace_text(&content, &re, &replacement, options.regex);
            if n == 0 || next == content {
                continue;
            }
            crate::core::history::record(&proj, &rel, &content, true)?;
            proj.write_file(&rel, &next)?;
            out.replacements += n;
            out.files_changed.push(rel);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())??;
    if !result.files_changed.is_empty() {
        emit_project_changed(&app);
    }
    Ok(result)
}

// --------------------------------------------------------------- history

#[tauri::command]
pub fn tb_history_list(state: State<'_, AppState>, file: String) -> Result<Vec<crate::core::history::HistoryEntry>, String> {
    let proj = project(&state)?;
    crate::core::history::list(&proj, &file)
}

#[tauri::command]
pub fn tb_history_read(state: State<'_, AppState>, file: String, id: String) -> Result<String, String> {
    let proj = project(&state)?;
    crate::core::history::read(&proj, &file, &id)
}

/// Force a snapshot of the current disk content (before a restore, so the
/// restore itself can be undone).
#[tauri::command]
pub fn tb_history_snapshot(state: State<'_, AppState>, file: String) -> Result<Option<String>, String> {
    let proj = project(&state)?;
    let content = proj.read_file(&file)?;
    crate::core::history::record(&proj, &file, &content, true)
}

// ------------------------------------------------------------------- git

#[tauri::command]
pub async fn tb_git_status(state: State<'_, AppState>) -> Result<crate::core::git::GitStatus, String> {
    let root = project(&state)?.root;
    tokio::task::spawn_blocking(move || crate::core::git::status(&root))
        .await
        .map_err(|e| e.to_string())
}

// ------------------------------------------------------- reference report

#[tauri::command]
pub fn tb_reference_report(state: State<'_, AppState>) -> Result<crate::core::refs_report::ReferenceReport, String> {
    let proj = project(&state)?;
    let tex: Vec<(String, String)> = proj
        .tex_files()
        .into_iter()
        .filter_map(|rel| {
            let rel = proj.relative_path(&rel).replace('\\', "/");
            proj.read_file(&rel).ok().map(|c| (rel, c))
        })
        .collect();
    let mut bib = Vec::new();
    for rel in proj.bib_files() {
        let Ok(content) = proj.read_file(&rel) else { continue };
        let rel = rel.replace('\\', "/");
        for e in crate::core::bib::parse_bib(&content) {
            let line = content
                .lines()
                .position(|l| l.contains(&format!("@{}", e.entry_type)) && l.contains(&format!("{{{},", e.key)))
                .map(|i| i + 1);
            bib.push((e.key.clone(), Some(rel.clone()), line, e.title.clone()));
        }
    }
    Ok(crate::core::refs_report::build(&tex, &bib))
}

// --------------------------------------------------------------- synctex

/// Forward search with the exact position (scroll the PDF to the line).
#[tauri::command]
pub fn tb_synctex_forward_pos(
    state: State<'_, AppState>,
    file: String,
    line: usize,
) -> Result<Option<crate::core::synctex::PdfPos>, String> {
    let proj = project(&state)?;
    let pdf = current_pdf(&state, &proj);
    if !pdf.exists() {
        return Ok(None);
    }
    let rel = crate::commands::files::clean_rel(&proj, &file)?;
    let abs = proj.root.join(&rel);
    if let Some(pos) = crate::core::synctex::system_forward_pos("synctex", &pdf, &abs.to_string_lossy(), line) {
        return Ok(Some(pos));
    }
    // no CLI: page only, from the built-in parser
    let gz = std::fs::read(pdf.with_extension("synctex.gz")).ok();
    Ok(gz
        .and_then(|gz| crate::core::synctex::forward_search(&gz, &rel, line))
        .map(|page| crate::core::synctex::PdfPos { page, x: 0.0, y: 0.0, w: 0.0, h: 0.0 }))
}

#[derive(serde::Serialize)]
pub struct ReverseHit {
    /// Project-relative source file.
    pub file: String,
    pub line: usize,
}

/// Reverse search: a point on a PDF page (big points from the top-left)
/// → the source line that produced it.
#[tauri::command]
pub fn tb_synctex_reverse(state: State<'_, AppState>, page: u32, x: f64, y: f64) -> Result<Option<ReverseHit>, String> {
    let proj = project(&state)?;
    let pdf = current_pdf(&state, &proj);
    if !pdf.exists() || page == 0 {
        return Ok(None);
    }
    let hit = crate::core::synctex::system_reverse("synctex", &pdf, page, x, y).or_else(|| {
        std::fs::read(pdf.with_extension("synctex.gz"))
            .ok()
            .and_then(|gz| crate::core::synctex::reverse_search(&gz, page, x, y))
    });
    let Some(hit) = hit else { return Ok(None) };
    // engines record absolute (sometimes `./`-relative) paths
    let raw = hit.file.replace('\\', "/");
    let raw = raw.trim_start_matches("./");
    let root = proj.root.to_string_lossy().replace('\\', "/");
    let rel = if let Some(stripped) = strip_prefix_ci(raw, &format!("{}/", root.trim_end_matches('/'))) {
        stripped.to_string()
    } else if proj.resolve(raw).map(|p| p.exists()).unwrap_or(false) {
        raw.to_string()
    } else {
        return Ok(None); // a file outside the project (class/package source)
    };
    Ok(Some(ReverseHit { file: rel, line: hit.line }))
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    // `get` (not slicing): a CJK folder name must not panic on a char boundary
    s.get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .and_then(|_| s.get(prefix.len()..))
}
