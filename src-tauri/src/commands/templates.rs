//! LaTeX template marketplace: a curated list of real university thesis
//! templates (GitHub-verified). Small templates ship inside the app bundle
//! (embedded at compile time via include_dir, preserving directory trees);
//! large ones are downloaded on demand from codeload.github.com into the
//! user data directory.
use crate::core::project::Project;
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Embedded template tree (`assets/templates/` at compile time).
static TEMPLATES: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../assets/templates");

const MAX_DOWNLOAD_BYTES: u64 = 500 * 1024 * 1024; // 500 MB safety cap
static NEXT_IMPORT_TEMP: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Deserialize, Clone)]
pub struct MarketTemplate {
    pub id: String,
    pub name: String,
    pub category: String,
    pub repo: String,
    pub desc: String,
    pub stars: u64,
    pub size_kb: u64,
    pub mode: String, // "builtin" | "remote"
    pub builtin: bool,
}

#[derive(Serialize)]
pub struct MarketTemplateView {
    #[serde(flatten)]
    pub t: MarketTemplate,
    /// true when the template files are already present locally
    pub ready: bool,
    /// "ok" once the download passed the structure verification, else null
    pub verified: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TemplateSource {
    User,
    Market,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ImportedTemplate {
    pub target_dir: String,
    pub main_file: String,
}

pub enum ResolvedTemplate<'a> {
    Directory(&'a Path),
    SingleFile(&'a Path),
    Embedded(&'a Dir<'a>),
    Builtin(&'static str),
}

/// Path where user-downloaded marketplace templates live.
pub fn market_download_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("texbutler")
        .join("market-templates")
}

fn load_catalog() -> Result<Vec<MarketTemplate>, String> {
    let file = TEMPLATES
        .get_file("templates.json")
        .ok_or_else(|| "模板清单缺失（内置资源损坏）".to_string())?;
    let content = file
        .contents_utf8()
        .ok_or_else(|| "模板清单不是 UTF-8".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(content).map_err(|e| format!("模板清单解析失败: {e}"))?;
    let arr = v["templates"]
        .as_array()
        .ok_or_else(|| "模板清单格式错误".to_string())?;
    let mut out = Vec::new();
    for item in arr {
        out.push(
            serde_json::from_value(item.clone()).map_err(|e| format!("模板条目解析失败: {e}"))?,
        );
    }
    Ok(out)
}

/// List every marketplace template with its local readiness state.
#[tauri::command]
pub fn tb_list_market_templates() -> Result<Vec<MarketTemplateView>, String> {
    let catalog = load_catalog()?;
    let dl_dir = market_download_dir();
    Ok(catalog
        .into_iter()
        .map(|t| {
            // the three classic built-ins live in the Rust binary; the other
            // builtin ids are embedded template dirs
            let legacy_builtin = matches!(t.id.as_str(), "article" | "ctexart" | "article-en");
            let ready = if legacy_builtin {
                true
            } else if t.builtin {
                TEMPLATES.get_dir(&t.id).is_some()
            } else {
                dl_dir.join(&t.id).exists()
            };
            let verified = if legacy_builtin {
                Some("ok".to_string()) // classic built-ins ship verified
            } else if ready && !t.builtin {
                let marker = dl_dir.join(&t.id).join(".texbutler-verified");
                if marker.exists() {
                    std::fs::read_to_string(&marker)
                        .ok()
                        .filter(|s| !s.trim().is_empty())
                } else {
                    None
                }
            } else if t.builtin && TEMPLATES.get_dir(&t.id).is_some() {
                Some("ok".to_string()) // embedded templates pass at build time
            } else {
                None
            };
            MarketTemplateView { t, ready, verified }
        })
        .collect())
}

/// Download a marketplace template (codeload zip) into the user directory.
#[tauri::command]
pub async fn tb_download_template(id: String) -> Result<String, String> {
    let catalog = load_catalog()?;
    let t = catalog
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("模板不存在: {id}"))?;
    if t.repo.is_empty() {
        return Err("该模板已内置，无需下载".into());
    }
    // resolve the default branch via the GitHub API (cheap, cached per run)
    let branch = default_branch(&t.repo).await?;
    let url = format!(
        "https://codeload.github.com/{}/zip/refs/heads/{}",
        t.repo, branch
    );
    let dl_dir = market_download_dir();
    let target = dl_dir.join(&t.id);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("清理旧模板失败: {e}"))?;
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("创建模板目录失败: {e}"))?;

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("模板下载失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("模板下载失败（HTTP {}）", resp.status().as_u16()));
    }
    let content = resp
        .bytes()
        .await
        .map_err(|e| format!("模板读取失败: {e}"))?;
    if content.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "模板包过大（{} MB），超过 500 MB 上限",
            content.len() / 1024 / 1024
        ));
    }
    // stream-free path: zip in memory, extract entries under a safe root
    let reader = std::io::Cursor::new(content.to_vec());
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("压缩包解析失败: {e}"))?;
    // zip entries come as `<repo>-<branch>/...` — strip the single root dir
    let mut total_written: u64 = 0;
    const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GB zip-bomb cap
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("压缩包读取失败: {e}"))?;
        let name = entry.name().to_string();
        let rel = match name.split_once('/') {
            Some((_, rest)) if !rest.is_empty() => rest,
            _ => {
                // the zip root dir itself, or a prefix-less entry that
                // would silently drop the file — surface it, don't swallow
                if !name.ends_with('/') {
                    eprintln!("template zip entry without directory prefix skipped: {name}");
                }
                continue;
            }
        };
        // traversal defense: reject any ../, absolute, or drive-relative
        // (C:evil) component — a `:` prefix on Windows would otherwise
        // redirect the write to another drive
        if rel.contains(':')
            || rel.split(['/', '\\']).any(|c| c == "..")
            || Path::new(&rel).is_absolute()
        {
            return Err(format!("压缩包含非法路径: {rel}"));
        }
        let out = target.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("解压失败: {e}"))?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("解压失败: {e}"))?;
            }
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf)
                .map_err(|e| format!("解压读取失败: {e}"))?;
            total_written += buf.len() as u64;
            if total_written > MAX_EXTRACTED_BYTES {
                return Err("压缩包解压后体积超限（2 GB），已中止".into());
            }
            std::fs::write(&out, buf).map_err(|e| format!("解压写入失败: {e}"))?;
        }
    }
    // structure verification: the template must contain at least one .tex
    // file with \documentclass, or it cannot seed a compilable project
    let tex_files = collect_tex_rel(&target);
    let has_root = tex_files.iter().any(|rel| {
        std::fs::read_to_string(target.join(rel))
            .map(|s| s.contains("\\documentclass"))
            .unwrap_or(false)
    });
    if !has_root {
        let mut cleanup = String::new();
        if let Err(e) = std::fs::remove_dir_all(&target) {
            cleanup = format!("（清理失败: {e}，残留目录将在下次下载时重建）");
        }
        return Err(format!(
            "模板结构无效：仓库内未找到含 \\documentclass 的主 .tex 文件（已删除下载内容{cleanup}）"
        ));
    }
    // verified marker: the structure check passed; UI shows "已验证"
    let marker = target.join(".texbutler-verified");
    std::fs::write(&marker, "ok").ok();
    Ok(target.to_string_lossy().to_string())
}

/// Collect `.tex` files relative to `root` (forward slashes).
fn collect_tex_rel(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let n = entry.file_name().to_string_lossy().to_string();
                if n.starts_with('.') || n == "target" || n == "node_modules" {
                    continue;
                }
                stack.push(p);
            } else if p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("tex"))
                == Some(true)
            {
                if let Ok(rel) = p.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    out
}
async fn default_branch(repo: &str) -> Result<String, String> {
    let url = format!("https://api.github.com/repos/{repo}");
    let resp = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "texbutler")
        .send()
        .await
        .map_err(|e| format!("GitHub 查询失败: {e}"))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("GitHub 响应解析失败: {e}"))?;
    json["default_branch"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("GitHub 未返回仓库信息: {repo}"))
}

pub fn normalize_project_relative_dir(project: &Project, raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw == "." || raw.contains(':') {
        return Err("invalid template import directory".into());
    }

    let path = Path::new(raw);
    if path.is_absolute() {
        return Err("invalid template import directory".into());
    }
    for component in path.components() {
        if matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        ) {
            return Err("invalid template import directory".into());
        }
    }

    let target = project
        .resolve(raw)
        .ok_or_else(|| "template import directory escapes the project".to_string())?;
    project.canonical_inside(&target)?;
    match std::fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(format!(
                "template import directory already exists: {}",
                target.display()
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "could not inspect template import directory: {error}"
            ))
        }
    }

    Ok(path.to_string_lossy().replace('\\', "/"))
}

pub fn import_temp_sibling(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| {
            format!(
                "template import parent does not exist: {}",
                target.display()
            )
        })?;
    let target_name = target
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "invalid template import directory".to_string())?
        .to_string_lossy();

    loop {
        let counter = NEXT_IMPORT_TEMP.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(
            ".{target_name}.texbutler-import-{}-{counter}",
            std::process::id(),
        ));
        match std::fs::symlink_metadata(&temp) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(temp),
            Err(error) => {
                return Err(format!(
                    "could not inspect temporary import directory: {error}"
                ))
            }
        }
    }
}

pub fn remove_created_dir(path: &Path) {
    if std::fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn remove_created_empty_parents(created: &[PathBuf]) {
    for path in created.iter().rev() {
        let _ = std::fs::remove_dir(path);
    }
}

fn create_missing_target_parents(project: &Project, target: &Path) -> Result<Vec<PathBuf>, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "invalid template import directory".to_string())?;
    let relative_parent = parent
        .strip_prefix(&project.root)
        .map_err(|_| "template import directory escapes the project".to_string())?;
    let mut current = project.root.clone();
    let mut created = Vec::new();

    for component in relative_parent.components() {
        let std::path::Component::Normal(name) = component else {
            remove_created_empty_parents(&created);
            return Err("invalid template import directory".into());
        };
        current.push(name);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                remove_created_empty_parents(&created);
                return Err(format!(
                    "template import parent is not a directory: {}",
                    current.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Err(error) = std::fs::create_dir(&current) {
                    remove_created_empty_parents(&created);
                    return Err(format!(
                        "could not create template import directory: {error}"
                    ));
                }
                created.push(current.clone());
            }
            Err(error) => {
                remove_created_empty_parents(&created);
                return Err(format!(
                    "could not inspect template import directory: {error}"
                ));
            }
        }
    }
    if let Err(error) = project.canonical_inside(target) {
        remove_created_empty_parents(&created);
        return Err(error);
    }
    Ok(created)
}

pub fn copy_tree_checked(src: &Path, dst: &Path, excluded_dirs: &[&str]) -> Result<(), String> {
    let source_metadata = std::fs::symlink_metadata(src)
        .map_err(|error| format!("could not inspect template source directory: {error}"))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(format!(
            "template source is not a safe directory: {}",
            src.display()
        ));
    }

    std::fs::create_dir_all(dst)
        .map_err(|error| format!("could not create template import directory: {error}"))?;
    for entry in std::fs::read_dir(src)
        .map_err(|error| format!("could not read template directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("could not read template directory: {error}"))?;
        let from = entry.path();
        let metadata = std::fs::symlink_metadata(&from)
            .map_err(|error| format!("could not inspect template file: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "template may not contain symbolic links: {}",
                from.display()
            ));
        }

        let name = entry.file_name();
        let to = dst.join(&name);
        if metadata.is_dir() {
            if excluded_dirs
                .iter()
                .any(|excluded| name == std::ffi::OsStr::new(excluded))
            {
                continue;
            }
            copy_tree_checked(&from, &to, excluded_dirs)?;
        } else if metadata.is_file() {
            std::fs::copy(&from, &to)
                .map_err(|error| format!("could not copy template file: {error}"))?;
        } else {
            return Err(format!(
                "template contains an unsupported file: {}",
                from.display()
            ));
        }
    }
    Ok(())
}

pub fn detect_main_document(root: &Path) -> Result<String, String> {
    let staged = Project::open(root)?;
    let roots = staged.document_roots();
    if roots.iter().any(|root| root == "main.tex") {
        return Ok("main.tex".to_string());
    }
    roots
        .into_iter()
        .next()
        .ok_or_else(|| "template has no .tex document containing \\documentclass".to_string())
}

fn stage_resolved_template(source: ResolvedTemplate<'_>, stage: &Path) -> Result<(), String> {
    match source {
        ResolvedTemplate::Directory(directory) => copy_tree_checked(
            directory,
            stage,
            &[".git", ".texbutler", "target", "node_modules"],
        ),
        ResolvedTemplate::SingleFile(file) => {
            let metadata = std::fs::symlink_metadata(file)
                .map_err(|error| format!("could not inspect template file: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "template source is not a safe file: {}",
                    file.display()
                ));
            }
            std::fs::copy(file, stage.join("main.tex"))
                .map(|_| ())
                .map_err(|error| format!("could not copy template file: {error}"))
        }
        ResolvedTemplate::Embedded(directory) => extract_embedded_dir(directory, stage),
        ResolvedTemplate::Builtin(body) => std::fs::write(stage.join("main.tex"), body)
            .map_err(|error| format!("could not write built-in template: {error}")),
    }
}

fn normalize_existing_project_dir(project: &Project, raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.contains(':') {
        return Err("invalid template import directory".into());
    }
    let normalized = if raw.is_empty() || raw == "." {
        String::new()
    } else {
        let path = Path::new(raw);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err("invalid template import directory".into());
        }
        path.to_string_lossy().replace('\\', "/")
    };

    let destination = project
        .resolve(&normalized)
        .ok_or_else(|| "template import directory escapes the project".to_string())?;
    project.canonical_inside(&destination)?;
    let metadata = std::fs::symlink_metadata(&destination)
        .map_err(|error| format!("could not inspect template import directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "template import destination is not a directory: {}",
            destination.display()
        ));
    }
    Ok(normalized)
}

#[derive(Debug)]
struct MergeEntry {
    relative: PathBuf,
    is_dir: bool,
}

fn inspect_merge_conflicts(stage: &Path, destination: &Path) -> Result<Vec<MergeEntry>, String> {
    fn inspect(
        stage: &Path,
        destination: &Path,
        relative: &Path,
        entries: &mut Vec<MergeEntry>,
        conflicts: &mut Vec<String>,
    ) -> Result<(), String> {
        let source_dir = stage.join(relative);
        let mut children = std::fs::read_dir(&source_dir)
            .map_err(|error| format!("could not inspect staged template: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("could not inspect staged template: {error}"))?;
        children.sort_by_key(|entry| entry.file_name());

        for child in children {
            let child_relative = relative.join(child.file_name());
            let source = child.path();
            let source_metadata = std::fs::symlink_metadata(&source)
                .map_err(|error| format!("could not inspect staged template: {error}"))?;
            if source_metadata.file_type().is_symlink() {
                return Err(format!(
                    "template may not contain symbolic links: {}",
                    source.display()
                ));
            }
            let is_dir = source_metadata.is_dir();
            if !is_dir && !source_metadata.is_file() {
                return Err(format!(
                    "template contains an unsupported file: {}",
                    source.display()
                ));
            }

            let target = destination.join(&child_relative);
            match std::fs::symlink_metadata(&target) {
                Ok(target_metadata) => {
                    let reusable_directory = is_dir
                        && target_metadata.is_dir()
                        && !target_metadata.file_type().is_symlink();
                    if !reusable_directory {
                        conflicts.push(child_relative.to_string_lossy().replace('\\', "/"));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("could not inspect template destination: {error}"))
                }
            }
            entries.push(MergeEntry {
                relative: child_relative.clone(),
                is_dir,
            });
            if is_dir {
                inspect(stage, destination, &child_relative, entries, conflicts)?;
            }
        }
        Ok(())
    }

    let mut entries = Vec::new();
    let mut conflicts = Vec::new();
    inspect(
        stage,
        destination,
        Path::new(""),
        &mut entries,
        &mut conflicts,
    )?;
    if conflicts.is_empty() {
        Ok(entries)
    } else {
        Err(format!(
            "template import conflicts with existing entries: {}",
            conflicts.join(", ")
        ))
    }
}

#[derive(Default)]
struct CreatedEntries {
    files: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
}

impl CreatedEntries {
    fn rollback(&mut self) {
        for file in self.files.iter().rev() {
            let _ = std::fs::remove_file(file);
        }
        for dir in self.dirs.iter().rev() {
            let _ = std::fs::remove_dir(dir);
        }
    }
}

fn merge_staged_tree_with<F>(
    stage: &Path,
    destination: &Path,
    entries: &[MergeEntry],
    mut copier: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &mut std::fs::File) -> Result<(), String>,
{
    let mut created = CreatedEntries::default();
    for entry in entries {
        let target = destination.join(&entry.relative);
        if entry.is_dir {
            match std::fs::symlink_metadata(&target) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    created.rollback();
                    return Err(format!(
                        "template import destination changed during import: {}",
                        entry.relative.display()
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if let Err(error) = std::fs::create_dir(&target) {
                        created.rollback();
                        return Err(format!("could not create template directory: {error}"));
                    }
                    created.dirs.push(target);
                }
                Err(error) => {
                    created.rollback();
                    return Err(format!("could not inspect template destination: {error}"));
                }
            }
        } else {
            let mut target_file = match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
            {
                Ok(file) => file,
                Err(error) => {
                    created.rollback();
                    return Err(format!("could not create template file: {error}"));
                }
            };
            created.files.push(target);
            if let Err(error) = copier(&stage.join(&entry.relative), &mut target_file) {
                drop(target_file);
                created.rollback();
                return Err(error);
            }
        }
    }
    Ok(())
}

fn merge_staged_tree(
    stage: &Path,
    destination: &Path,
    entries: &[MergeEntry],
) -> Result<(), String> {
    merge_staged_tree_with(stage, destination, entries, |source, target| {
        let mut source = std::fs::File::open(source)
            .map_err(|error| format!("could not open staged template file: {error}"))?;
        std::io::copy(&mut source, target)
            .map(|_| ())
            .map_err(|error| format!("could not copy template file: {error}"))
    })
}

fn join_relative(directory: &str, child: &str) -> String {
    if directory.is_empty() {
        child.to_string()
    } else {
        format!("{directory}/{child}")
    }
}

pub fn merge_resolved_template(
    project: &Project,
    destination_dir: &str,
    source: ResolvedTemplate<'_>,
) -> Result<ImportedTemplate, String> {
    let destination_dir = normalize_existing_project_dir(project, destination_dir)?;
    let destination = project
        .resolve(&destination_dir)
        .ok_or_else(|| "template import directory escapes the project".to_string())?;
    let stage = project.backup_dir().join(format!(
        "import-stage-{}-{}",
        std::process::id(),
        NEXT_IMPORT_TEMP.fetch_add(1, Ordering::Relaxed),
    ));
    let result = (|| {
        std::fs::create_dir_all(&stage).map_err(|error| error.to_string())?;
        stage_resolved_template(source, &stage)?;
        let main_inside = detect_main_document(&stage)?;
        let entries = inspect_merge_conflicts(&stage, &destination)?;
        merge_staged_tree(&stage, &destination, &entries)?;
        Ok(ImportedTemplate {
            target_dir: destination_dir.clone(),
            main_file: join_relative(&destination_dir, &main_inside),
        })
    })();
    remove_created_dir(&stage);
    result
}

pub fn import_resolved_template(
    project: &Project,
    target_dir: &str,
    source: ResolvedTemplate<'_>,
) -> Result<ImportedTemplate, String> {
    let normalized_target = normalize_project_relative_dir(project, target_dir)?;
    let target = project
        .resolve(&normalized_target)
        .ok_or_else(|| "template import directory escapes the project".to_string())?;
    let created_parents = create_missing_target_parents(project, &target)?;
    let temp = match import_temp_sibling(&target) {
        Ok(temp) => temp,
        Err(error) => {
            remove_created_empty_parents(&created_parents);
            return Err(error);
        }
    };

    let result = (|| {
        std::fs::create_dir(&temp)
            .map_err(|error| format!("could not create temporary import directory: {error}"))?;
        match source {
            ResolvedTemplate::Directory(directory) => {
                copy_tree_checked(
                    directory,
                    &temp,
                    &[".git", ".texbutler", "target", "node_modules"],
                )?;
            }
            ResolvedTemplate::SingleFile(file) => {
                let metadata = std::fs::symlink_metadata(file)
                    .map_err(|error| format!("could not inspect template file: {error}"))?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!(
                        "template source is not a safe file: {}",
                        file.display()
                    ));
                }
                std::fs::copy(file, temp.join("main.tex"))
                    .map_err(|error| format!("could not copy template file: {error}"))?;
            }
            ResolvedTemplate::Embedded(directory) => extract_embedded_dir(directory, &temp)?,
            ResolvedTemplate::Builtin(body) => {
                std::fs::write(temp.join("main.tex"), body)
                    .map_err(|error| format!("could not write built-in template: {error}"))?;
            }
        }

        let main_inside = detect_main_document(&temp)?;
        std::fs::rename(&temp, &target)
            .map_err(|error| format!("could not finalize template import: {error}"))?;
        Ok(ImportedTemplate {
            target_dir: normalized_target.clone(),
            main_file: format!("{normalized_target}/{main_inside}"),
        })
    })();

    if result.is_err() {
        remove_created_dir(&temp);
        remove_created_empty_parents(&created_parents);
    }
    result
}

pub(crate) fn save_user_template_at(
    project_root: &Path,
    template_root: &Path,
    name: &str,
) -> Result<(), String> {
    let name = crate::commands::project::validate_template_name(name)?;
    std::fs::create_dir_all(template_root)
        .map_err(|error| format!("could not create template directory: {error}"))?;
    let root_metadata = std::fs::symlink_metadata(template_root)
        .map_err(|error| format!("could not inspect template directory: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(format!(
            "template directory is not a safe directory: {}",
            template_root.display()
        ));
    }

    let target = template_root.join(&name);
    let legacy = template_root.join(format!("{name}.tex"));
    for collision in [&target, &legacy] {
        match std::fs::symlink_metadata(collision) {
            Ok(_) => return Err(format!("template already exists: {}", collision.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not inspect template destination: {error}")),
        }
    }

    let temporary_template = import_temp_sibling(&target)?;
    let result = (|| {
        std::fs::create_dir(&temporary_template)
            .map_err(|error| format!("could not create temporary template directory: {error}"))?;
        copy_tree_checked(
            project_root,
            &temporary_template,
            &[".texbutler", ".git", "node_modules", "target"],
        )?;
        detect_main_document(&temporary_template)?;
        std::fs::rename(&temporary_template, &target)
            .map_err(|error| format!("could not finalize saved template: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        remove_created_dir(&temporary_template);
    }
    result
}

pub(crate) fn list_user_templates_at(
    template_root: &Path,
) -> Vec<crate::commands::project::TemplateInfo> {
    use std::collections::BTreeMap;

    let Ok(entries) = std::fs::read_dir(template_root) else {
        return Vec::new();
    };
    let mut templates = BTreeMap::new();
    let entries: Vec<_> = entries.flatten().collect();

    for entry in &entries {
        let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if crate::commands::project::validate_template_name(&id).is_ok() {
            templates.insert(
                id.clone(),
                crate::commands::project::TemplateInfo {
                    name: format!("{id}（我的模板）"),
                    id,
                    source: "user".into(),
                },
            );
        }
    }

    for entry in entries {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension != "tex")
                .unwrap_or(true)
        {
            continue;
        }
        let id = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if crate::commands::project::validate_template_name(&id).is_ok() {
            templates
                .entry(id.clone())
                .or_insert_with(|| crate::commands::project::TemplateInfo {
                    name: format!("{id}（我的模板）"),
                    id,
                    source: "user".into(),
                });
        }
    }

    templates.into_values().collect()
}

pub(crate) fn delete_user_template_at(template_root: &Path, name: &str) -> Result<(), String> {
    let name = crate::commands::project::validate_template_name(name)?;
    let directory = template_root.join(&name);
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("template entries may not be symbolic links".into());
            }
            if !metadata.is_dir() {
                return Err(format!(
                    "template directory is invalid: {}",
                    directory.display()
                ));
            }
            return std::fs::remove_dir_all(&directory)
                .map_err(|error| format!("could not delete template: {error}"));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("could not inspect template: {error}")),
    }

    let legacy = template_root.join(format!("{name}.tex"));
    let metadata = std::fs::symlink_metadata(&legacy).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "模板不存在".to_string()
        } else {
            format!("could not inspect template: {error}")
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err("template entries may not be symbolic links".into());
    }
    if !metadata.is_file() {
        return Err(format!("legacy template is invalid: {}", legacy.display()));
    }
    std::fs::remove_file(&legacy).map_err(|error| format!("could not delete template: {error}"))
}

fn resolve_user_template<'a>(
    directory: &'a Path,
    legacy: &'a Path,
) -> Result<ResolvedTemplate<'a>, String> {
    let directory_metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("could not inspect user template: {error}")),
    };
    let legacy_metadata = match std::fs::symlink_metadata(legacy) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("could not inspect user template: {error}")),
    };

    if directory_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_symlink())
        || legacy_metadata
            .as_ref()
            .is_some_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("template entries may not be symbolic links".into());
    }
    if let Some(metadata) = directory_metadata {
        if !metadata.is_dir() {
            return Err(format!(
                "user template directory is invalid: {}",
                directory.display()
            ));
        }
        return Ok(ResolvedTemplate::Directory(directory));
    }
    if let Some(metadata) = legacy_metadata {
        if !metadata.is_file() {
            return Err(format!(
                "legacy user template is invalid: {}",
                legacy.display()
            ));
        }
        return Ok(ResolvedTemplate::SingleFile(legacy));
    }
    Err("模板不存在".into())
}

fn resolve_market_template<'a>(
    template_id: &str,
    downloaded: &'a Path,
) -> Result<ResolvedTemplate<'a>, String> {
    if let Some(embedded) = TEMPLATES.get_dir(template_id) {
        return Ok(ResolvedTemplate::Embedded(embedded));
    }

    match std::fs::symlink_metadata(downloaded) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "market template is not a safe directory: {}",
                    downloaded.display()
                ));
            }
            let marker = downloaded.join(".texbutler-verified");
            let marker_metadata = std::fs::symlink_metadata(&marker)
                .map_err(|_| "market template has not been verified".to_string())?;
            if marker_metadata.file_type().is_symlink() || !marker_metadata.is_file() {
                return Err("market template has not been verified".into());
            }
            return Ok(ResolvedTemplate::Directory(downloaded));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("could not inspect market template: {error}")),
    }

    let core_template_id = if template_id == "ctexart" {
        "article"
    } else {
        template_id
    };
    crate::core::project::templates()
        .into_iter()
        .find(|(id, _, _)| *id == core_template_id)
        .map(|(_, _, body)| ResolvedTemplate::Builtin(body))
        .ok_or_else(|| format!("market template is not ready: {template_id}"))
}

#[tauri::command]
pub fn tb_import_project_template(
    state: tauri::State<'_, crate::state::AppState>,
    target_dir: String,
    template_id: String,
    source: TemplateSource,
) -> Result<ImportedTemplate, String> {
    let project = {
        let guard = state.project.read().map_err(|error| error.to_string())?;
        guard
            .as_ref()
            .ok_or_else(|| "尚未打开项目".to_string())?
            .clone()
    };

    match source {
        TemplateSource::User => {
            let id = crate::commands::project::validate_template_name(&template_id)?;
            let template_root = crate::commands::project::user_template_dir();
            let directory = template_root.join(&id);
            let legacy = template_root.join(format!("{id}.tex"));
            let resolved = resolve_user_template(&directory, &legacy)?;
            merge_resolved_template(&project, &target_dir, resolved)
        }
        TemplateSource::Market => {
            let id = template_id.trim();
            if !load_catalog()?.iter().any(|template| template.id == id) {
                return Err(format!("market template does not exist: {id}"));
            }
            let downloaded = market_download_dir().join(id);
            let resolved = resolve_market_template(id, &downloaded)?;
            merge_resolved_template(&project, &target_dir, resolved)
        }
    }
}

/// Copy a marketplace template (embedded or downloaded) into a new project.
/// Returns the project directory.
#[tauri::command]
pub fn tb_create_from_market_template(
    parent: String,
    name: String,
    template_id: String,
) -> Result<String, String> {
    crate::core::project::validate_project_name(&name)?;
    let id = template_id.trim();
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("模板名不合法（不能含路径分隔符）".into());
    }
    let dir = Path::new(&parent).join(&name);
    if dir.exists() {
        return Err(format!("目录已存在: {}", dir.display()));
    }
    if let Some(embedded) = TEMPLATES.get_dir(&id) {
        extract_embedded_dir(embedded, &dir)?;
        std::fs::create_dir_all(dir.join(".texbutler")).ok();
        return Ok(dir.to_string_lossy().to_string());
    }
    let dl_src = market_download_dir().join(&id);
    if dl_src.exists() {
        copy_tree(&dl_src, &dir)?;
        std::fs::create_dir_all(dir.join(".texbutler")).ok();
        return Ok(dir.to_string_lossy().to_string());
    }
    Err(format!("模板未就绪: {id}（请先在模板市场下载）"))
}

/// Recursively extract an embedded template dir into `dst`.
fn extract_embedded_dir(src: &Dir<'_>, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in src.entries() {
        match entry {
            include_dir::DirEntry::Dir(d) => {
                let name = d.path().file_name().unwrap_or_default();
                extract_embedded_dir(d, &dst.join(name))?;
            }
            include_dir::DirEntry::File(f) => {
                let name = f.path().file_name().unwrap_or_default();
                let content = f.contents();
                std::fs::write(dst.join(name), content).map_err(|e| format!("写出失败: {e}"))?;
            }
        }
    }
    Ok(())
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("复制失败: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::project::Project;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(1);

    fn test_root(label: &str) -> PathBuf {
        let id = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "texbutler-template-{label}-{}-{id}",
            std::process::id(),
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_fixture(path: &Path, content: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn save_user_template_copies_assets_and_excludes_internal_dirs() {
        let root = test_root("save-tree");
        let project = root.join("project");
        let templates = root.join("templates");
        write_fixture(&project.join("main.tex"), b"\\documentclass{article}\n");
        write_fixture(&project.join("refs.bib"), b"@book{x,title={X}}\n");
        write_fixture(&project.join("figures/a.png"), b"png");
        for excluded in [
            ".texbutler/build/out.pdf",
            ".git/config",
            "node_modules/x/index.js",
            "target/debug/x",
        ] {
            write_fixture(&project.join(excluded), b"excluded");
        }

        save_user_template_at(&project, &templates, "paper").unwrap();

        assert!(templates.join("paper/main.tex").is_file());
        assert!(templates.join("paper/refs.bib").is_file());
        assert!(templates.join("paper/figures/a.png").is_file());
        for excluded in [".texbutler", ".git", "node_modules", "target"] {
            assert!(!templates.join("paper").join(excluded).exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn save_user_template_rejects_existing_directory_or_legacy_file() {
        let root = test_root("save-collision");
        let project = root.join("project");
        let templates = root.join("templates");
        write_fixture(&project.join("main.tex"), b"\\documentclass{article}\n");
        write_fixture(&templates.join("legacy.tex"), b"\\documentclass{article}\n");
        std::fs::create_dir_all(templates.join("directory")).unwrap();

        assert!(save_user_template_at(&project, &templates, "legacy").is_err());
        assert!(save_user_template_at(&project, &templates, "directory").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_user_templates_merges_directory_and_legacy_entries_without_duplicates() {
        let root = test_root("list-templates");
        let templates = root.join("templates");
        write_fixture(
            &templates.join("alpha/main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&templates.join("alpha.tex"), b"\\documentclass{article}\n");
        write_fixture(&templates.join("beta.tex"), b"\\documentclass{article}\n");

        let items = list_user_templates_at(&templates);
        let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["alpha", "beta"]);
        assert!(items.iter().all(|item| item.source == "user"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_user_template_removes_exact_resolved_entry() {
        let root = test_root("delete-template");
        let templates = root.join("templates");
        write_fixture(
            &templates.join("directory/main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&templates.join("legacy.tex"), b"\\documentclass{article}\n");
        write_fixture(&templates.join("keep.tex"), b"\\documentclass{article}\n");

        delete_user_template_at(&templates, "directory").unwrap();
        delete_user_template_at(&templates, "legacy").unwrap();

        assert!(!templates.join("directory").exists());
        assert!(!templates.join("legacy.tex").exists());
        assert!(templates.join("keep.tex").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_single_file_import_becomes_main_tex() {
        let root = test_root("legacy-import");
        let project_root = root.join("project");
        let legacy = root.join("sample.tex");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&legacy, b"\\documentclass{report}\n");
        let project = Project::open(&project_root).unwrap();

        let imported =
            import_resolved_template(&project, "sample", ResolvedTemplate::SingleFile(&legacy))
                .unwrap();

        assert_eq!(imported.main_file, "sample/main.tex");
        assert_eq!(
            std::fs::read(project_root.join("sample/main.tex")).unwrap(),
            b"\\documentclass{report}\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    fn symlink_privilege_unavailable(error: &std::io::Error) -> bool {
        error.kind() == std::io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(1314)
    }

    #[test]
    fn import_rejects_absolute_traversal_and_existing_targets() {
        let root = test_root("reject-target");
        let project_root = root.join("project");
        let source_root = root.join("source");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&source_root.join("main.tex"), b"\\documentclass{article}\n");
        std::fs::create_dir_all(project_root.join("notes")).unwrap();
        let project = Project::open(&project_root).unwrap();

        for bad in ["D:/escape", "/escape", "../escape", "notes"] {
            assert!(
                import_resolved_template(&project, bad, ResolvedTemplate::Directory(&source_root),)
                    .is_err(),
                "target must be rejected: {bad}"
            );
        }

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_cleans_created_parent_when_nested_target_validation_fails() {
        let root = test_root("cleanup-created-parent");
        let project_root = root.join("project");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&project_root.join("existing-file"), b"blocked");
        let project = Project::open(&project_root).unwrap();
        let target = project_root
            .join("new-parent")
            .join("..")
            .join("existing-file")
            .join("template");

        assert!(create_missing_target_parents(&project, &target).is_err());
        assert!(!project_root.join("new-parent").exists());
        assert_eq!(
            std::fs::read(project_root.join("existing-file")).unwrap(),
            b"blocked"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_returns_project_relative_target_and_main_file() {
        let root = test_root("relative-result");
        let project_root = root.join("project");
        let source_root = root.join("source");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&source_root.join("main.tex"), b"\\documentclass{report}\n");
        write_fixture(&source_root.join("chapters/a.tex"), b"chapter\n");
        let project = Project::open(&project_root).unwrap();

        let imported = import_resolved_template(
            &project,
            "thesis",
            ResolvedTemplate::Directory(&source_root),
        )
        .unwrap();

        assert_eq!(imported.target_dir, "thesis");
        assert_eq!(imported.main_file, "thesis/main.tex");
        assert_eq!(
            std::fs::read(project_root.join("thesis/chapters/a.tex")).unwrap(),
            b"chapter\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_rejects_tree_without_document_root_and_cleans_temp() {
        let root = test_root("cleanup");
        let project_root = root.join("project");
        let source_root = root.join("source");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&source_root.join("chapter.tex"), b"plain chapter\n");
        let project = Project::open(&project_root).unwrap();

        assert!(import_resolved_template(
            &project,
            "broken",
            ResolvedTemplate::Directory(&source_root),
        )
        .is_err());
        assert!(!project_root.join("broken").exists());
        let residue = std::fs::read_dir(&project_root)
            .unwrap()
            .flatten()
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("texbutler-import")
            });
        assert!(!residue, "failed import must remove its temporary sibling");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_preserves_project_root_and_unrelated_files() {
        let root = test_root("preserve-root");
        let project_root = root.join("project");
        let source_root = root.join("source");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&project_root.join("keep.txt"), b"unchanged");
        write_fixture(
            &source_root.join("paper.tex"),
            b"\\documentclass{article}\n",
        );
        let project = Project::open(&project_root).unwrap();

        let imported = import_resolved_template(
            &project,
            "papers/demo",
            ResolvedTemplate::Directory(&source_root),
        )
        .unwrap();

        assert_eq!(
            std::fs::read(project_root.join("keep.txt")).unwrap(),
            b"unchanged"
        );
        assert!(project_root
            .join(&imported.target_dir)
            .starts_with(&project_root));
        assert!(project_root
            .join(&imported.main_file)
            .starts_with(&project_root));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_rejects_source_and_target_symlinks() {
        let root = test_root("reject-symlinks");
        let project_root = root.join("project");
        let source_root = root.join("source");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&source_root.join("main.tex"), b"\\documentclass{article}\n");
        let project = Project::open(&project_root).unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink("main.tex", source_root.join("linked.tex")).unwrap();
        #[cfg(windows)]
        if let Err(error) =
            std::os::windows::fs::symlink_file("main.tex", source_root.join("linked.tex"))
        {
            if symlink_privilege_unavailable(&error) {
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            panic!("failed to create source symlink: {error}");
        }

        assert!(import_resolved_template(
            &project,
            "source-link",
            ResolvedTemplate::Directory(&source_root),
        )
        .is_err());
        assert!(!project_root.join("source-link").exists());
        std::fs::remove_file(source_root.join("linked.tex")).unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("outside"), project_root.join("dangling")).unwrap();
        #[cfg(windows)]
        if let Err(error) =
            std::os::windows::fs::symlink_dir(root.join("outside"), project_root.join("dangling"))
        {
            if symlink_privilege_unavailable(&error) {
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            panic!("failed to create target symlink: {error}");
        }

        assert!(import_resolved_template(
            &project,
            "dangling/target",
            ResolvedTemplate::Directory(&source_root),
        )
        .is_err());
        assert!(!project_root.join("dangling/target").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_imports_into_existing_directory_and_reuses_subdirectories() {
        let root = test_root("merge-current");
        let project_root = root.join("project");
        let source_root = root.join("source");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&project_root.join("contents/existing.tex"), b"keep\n");
        write_fixture(&source_root.join("paper.tex"), b"\\documentclass{report}\n");
        write_fixture(&source_root.join("contents/new.tex"), b"new\n");
        let project = Project::open(&project_root).unwrap();

        let imported =
            merge_resolved_template(&project, "", ResolvedTemplate::Directory(&source_root))
                .unwrap();

        assert_eq!(imported.target_dir, "");
        assert_eq!(imported.main_file, "paper.tex");
        assert_eq!(
            std::fs::read(project_root.join("contents/existing.tex")).unwrap(),
            b"keep\n"
        );
        assert_eq!(
            std::fs::read(project_root.join("contents/new.tex")).unwrap(),
            b"new\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_conflict_writes_nothing() {
        let root = test_root("merge-conflict");
        let project_root = root.join("project");
        let source_root = root.join("source");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&project_root.join("contents/keep.tex"), b"original\n");
        write_fixture(&source_root.join("paper.tex"), b"\\documentclass{report}\n");
        write_fixture(&source_root.join("contents/keep.tex"), b"replacement\n");
        write_fixture(
            &source_root.join("created-before-conflict.tex"),
            b"must-not-appear\n",
        );
        let project = Project::open(&project_root).unwrap();

        let error =
            merge_resolved_template(&project, "", ResolvedTemplate::Directory(&source_root))
                .unwrap_err();
        assert!(error.contains("contents/keep.tex"));
        assert_eq!(
            std::fs::read(project_root.join("contents/keep.tex")).unwrap(),
            b"original\n"
        );
        assert!(!project_root.join("created-before-conflict.tex").exists());
        assert!(!project_root.join("paper.tex").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_copy_failure_rolls_back_only_entries_it_created() {
        let root = test_root("merge-copy-failure");
        let staged = root.join("staged");
        let destination = root.join("destination");
        write_fixture(&staged.join("created/file.tex"), b"new\n");
        write_fixture(&staged.join("existing/new.tex"), b"new\n");
        std::fs::create_dir_all(destination.join("existing")).unwrap();
        let entries = inspect_merge_conflicts(&staged, &destination).unwrap();
        let injected = "injected copy failure".to_string();

        let error = merge_staged_tree_with(&staged, &destination, &entries, |from, to| {
            if from.ends_with("new.tex") {
                return Err(injected.clone());
            }
            let mut from = std::fs::File::open(from).unwrap();
            std::io::copy(&mut from, to)
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .unwrap_err();

        assert_eq!(error, injected);
        assert!(destination.join("existing").is_dir());
        assert!(!destination.join("existing/new.tex").exists());
        assert!(!destination.join("created/file.tex").exists());
        assert!(!destination.join("created").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_create_race_preserves_file_not_owned_by_import() {
        let root = test_root("merge-create-race");
        let staged = root.join("staged");
        let destination = root.join("destination");
        write_fixture(&staged.join("paper.tex"), b"new\n");
        std::fs::create_dir_all(&destination).unwrap();
        let entries = inspect_merge_conflicts(&staged, &destination).unwrap();
        std::fs::write(destination.join("paper.tex"), b"external\n").unwrap();

        let error = merge_staged_tree_with(&staged, &destination, &entries, |_from, _to| {
            panic!("copier must not run without exclusive ownership")
        })
        .unwrap_err();

        assert!(error.contains("could not create template file"));
        assert_eq!(
            std::fs::read(destination.join("paper.tex")).unwrap(),
            b"external\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
