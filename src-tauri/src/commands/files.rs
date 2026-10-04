//! File management inside the open project: folders, rename/move, delete
//! (to a recoverable project trash), reveal in the OS file manager and
//! PDF export. Every path is validated to stay inside the project; the
//! private `.texbutler` / `.git` folders can never be touched.

use crate::commands::project::emit_project_changed;
use crate::core::project::Project;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Normalize and validate a user-supplied project-relative path.
pub fn clean_rel(project: &Project, raw: &str) -> Result<String, String> {
    let rel = project.relative_path(raw.trim()).replace('\\', "/");
    let rel = rel.trim_matches('/').to_string();
    if rel.is_empty() || rel == "." {
        return Err("路径为空".into());
    }
    if rel.contains(':') {
        return Err(format!("非法路径: {rel}"));
    }
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("非法路径: {rel}"));
        }
        if part.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) {
            return Err(format!("名称包含非法字符: {part}"));
        }
    }
    let first = rel.split('/').next().unwrap_or("");
    if first == ".texbutler" || first == ".git" {
        return Err("不能操作 TeXButler/Git 的内部文件夹".into());
    }
    if project.resolve(&rel).is_none() {
        return Err(format!("路径越界: {rel}"));
    }
    Ok(rel)
}

fn exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// Run `f` with the open project mutably, then rescan its file tree.
fn with_project_mut<T>(state: &State<'_, AppState>, f: impl FnOnce(&mut Project) -> Result<T, String>) -> Result<T, String> {
    let mut guard = state.project.write().map_err(|e| e.to_string())?;
    let proj = guard.as_mut().ok_or_else(|| "尚未打开项目".to_string())?;
    let out = f(proj)?;
    let _ = proj.scan();
    Ok(out)
}

#[tauri::command]
pub fn tb_create_dir(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<String, String> {
    let rel = with_project_mut(&state, |proj| {
        let rel = clean_rel(proj, &path)?;
        let full = proj.root.join(&rel);
        if exists(&full) {
            return Err(format!("已存在同名文件或文件夹: {rel}"));
        }
        proj.canonical_inside(&full)?;
        std::fs::create_dir_all(&full).map_err(|e| format!("创建文件夹失败: {e}"))?;
        Ok(rel)
    })?;
    emit_project_changed(&app);
    Ok(rel)
}

#[derive(serde::Serialize)]
pub struct RenameResult {
    pub from: String,
    pub to: String,
    pub main_file: String,
}

/// Rename or move a file/folder (`to` may be in another folder; missing
/// parent folders are created). The main file follows the rename.
#[tauri::command]
pub fn tb_rename_path(app: AppHandle, state: State<'_, AppState>, from: String, to: String) -> Result<RenameResult, String> {
    let result = with_project_mut(&state, |proj| {
        let from_rel = clean_rel(proj, &from)?;
        let to_rel = clean_rel(proj, &to)?;
        if from_rel == to_rel {
            return Err("新旧路径相同".into());
        }
        if to_rel.starts_with(&format!("{from_rel}/")) {
            return Err("不能把文件夹移动到它自己的子文件夹中".into());
        }
        let src = proj.root.join(&from_rel);
        let dst = proj.root.join(&to_rel);
        if !exists(&src) {
            return Err(format!("找不到: {from_rel}"));
        }
        proj.canonical_inside(&src)?;
        // only a case change of the same entry may "collide" on Windows
        if exists(&dst) && !from_rel.eq_ignore_ascii_case(&to_rel) {
            return Err(format!("目标已存在: {to_rel}"));
        }
        proj.canonical_inside(&dst)?;
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目标文件夹失败: {e}"))?;
        }
        std::fs::rename(&src, &dst).map_err(|e| format!("重命名失败: {e}"))?;
        // keep the main file pointing at the moved document
        let main = proj.main_file.replace('\\', "/");
        let new_main = if main == from_rel {
            Some(to_rel.clone())
        } else {
            main.strip_prefix(&format!("{from_rel}/")).map(|rest| format!("{to_rel}/{rest}"))
        };
        if let Some(new_main) = new_main {
            proj.set_main_file(&new_main)?;
        }
        Ok(RenameResult { from: from_rel, to: to_rel, main_file: proj.main_file.clone() })
    })?;
    emit_project_changed(&app);
    Ok(result)
}

#[derive(serde::Serialize)]
pub struct DeleteResult {
    pub path: String,
    /// Trash batch id, pass to `tb_restore_deleted` to undo.
    pub trash_id: String,
}

/// Delete a file/folder by moving it into `.texbutler/trash/<id>/` (never a
/// permanent delete — the toast offers "撤销" and the trash stays in the
/// project until the user empties it from the file manager).
#[tauri::command]
pub fn tb_delete_path(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<DeleteResult, String> {
    let result = with_project_mut(&state, |proj| {
        let rel = clean_rel(proj, &path)?;
        let src = proj.root.join(&rel);
        if !exists(&src) {
            return Err(format!("找不到: {rel}"));
        }
        proj.canonical_inside(&src)?;
        let id = now_ms().to_string();
        let dst = proj.root.join(".texbutler").join("trash").join(&id).join(&rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&src, &dst).map_err(|e| format!("删除失败: {e}"))?;
        // deleting the main document: fall back to auto-detection
        let main = proj.main_file.replace('\\', "/");
        if main == rel || main.starts_with(&format!("{rel}/")) {
            let _ = std::fs::remove_file(proj.root.join(".texbutler").join("main.txt"));
            let _ = proj.scan();
            proj.detect_main();
        }
        Ok(DeleteResult { path: rel, trash_id: id })
    })?;
    emit_project_changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn tb_restore_deleted(app: AppHandle, state: State<'_, AppState>, path: String, trash_id: String) -> Result<String, String> {
    if trash_id.is_empty() || !trash_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("非法的回收站编号".into());
    }
    let rel = with_project_mut(&state, |proj| {
        let rel = clean_rel(proj, &path)?;
        let src = proj.root.join(".texbutler").join("trash").join(&trash_id).join(&rel);
        let dst = proj.root.join(&rel);
        if !exists(&src) {
            return Err("回收站中找不到该项目".into());
        }
        if exists(&dst) {
            return Err(format!("原位置已有同名文件: {rel}"));
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&src, &dst).map_err(|e| format!("恢复失败: {e}"))?;
        Ok(rel)
    })?;
    emit_project_changed(&app);
    Ok(rel)
}

/// The PDF of the last compile (falls back to the main document's PDF).
pub fn current_pdf(state: &State<'_, AppState>, proj: &Project) -> PathBuf {
    let build = proj.build_dir();
    state
        .last_result
        .read()
        .ok()
        .and_then(|g| g.as_ref().and_then(|r| r.pdf_path.clone()))
        .map(PathBuf::from)
        .filter(|p| p.exists() && p.starts_with(&build))
        .unwrap_or_else(|| {
            let main_rel = proj.relative_path(&proj.main_file);
            build.join(format!("{}.pdf", main_rel.trim_end_matches(".tex")))
        })
}

/// Show a file/folder in Explorer. `output: true` opens the build folder
/// (compiled PDF, logs). `dry_run` returns the target without launching
/// anything (used by the end-to-end tests).
#[tauri::command]
pub fn tb_reveal_path(
    state: State<'_, AppState>,
    path: Option<String>,
    output: Option<bool>,
    dry_run: Option<bool>,
) -> Result<String, String> {
    let target = {
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
        if output.unwrap_or(false) {
            // before the first compile there is no build folder yet: show the project
            let pdf = current_pdf(&state, proj);
            let build = proj.build_dir();
            if pdf.exists() {
                pdf
            } else if build.is_dir() {
                build
            } else {
                proj.root.clone()
            }
        } else {
            match path.as_deref() {
                Some(p) if !p.trim().is_empty() => proj.root.join(clean_rel(proj, p)?),
                _ => proj.root.clone(),
            }
        }
    };
    // project roots may carry forward slashes; Explorer's /select, needs one style
    #[cfg(windows)]
    let target = PathBuf::from(target.to_string_lossy().replace('/', "\\"));
    if !exists(&target) {
        return Err(format!("找不到: {}", target.display()));
    }
    let shown = target.to_string_lossy().to_string();
    if dry_run.unwrap_or(false) {
        return Ok(shown);
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("explorer");
        if target.is_dir() {
            cmd.arg(&target);
        } else {
            cmd.arg(format!("/select,{}", target.display()));
        }
        cmd.spawn().map_err(|e| format!("无法打开资源管理器: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(&target).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if target.is_dir() { target.clone() } else { target.parent().map(|p| p.to_path_buf()).unwrap_or_default() };
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(shown)
}

/// Copy the compiled PDF to a location chosen in the save dialog.
#[tauri::command]
pub fn tb_save_pdf_as(state: State<'_, AppState>, dest: String) -> Result<String, String> {
    let src = {
        let guard = state.project.read().map_err(|e| e.to_string())?;
        let proj = guard.as_ref().ok_or_else(|| "尚未打开项目".to_string())?;
        current_pdf(&state, proj)
    };
    if !src.exists() {
        return Err("还没有编译出 PDF".into());
    }
    let dest = PathBuf::from(dest);
    if !dest.is_absolute() || dest.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("pdf")) != Some(true) {
        return Err("请选择一个 .pdf 保存位置".into());
    }
    if dest.parent().map(|p| !p.is_dir()).unwrap_or(true) {
        return Err("目标文件夹不存在".into());
    }
    std::fs::copy(&src, &dest).map_err(|e| format!("保存失败: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_rel_rejects_traversal_internal_dirs_and_bad_names() {
        let root = std::env::temp_dir().join(format!("tb-files-clean-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("main.tex"), "x").unwrap();
        let p = Project::open(&root).unwrap();
        assert_eq!(clean_rel(&p, "chapters\\a.tex/").unwrap(), "chapters/a.tex");
        for bad in ["", ".", "../x", "a/../../x", ".texbutler/trash", ".git/config", "C:/x", "a?.tex", "a//b"] {
            assert!(clean_rel(&p, bad).is_err(), "{bad} should be rejected");
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
