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

pub fn copy_tree_checked(src: &Path, dst: &Path, excluded_entries: &[&str]) -> Result<(), String> {
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
        if excluded_entries
            .iter()
            .any(|excluded| name == std::ffi::OsStr::new(excluded))
        {
            continue;
        }
        let to = dst.join(&name);
        if metadata.is_dir() {
            copy_tree_checked(&from, &to, excluded_entries)?;
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
            &[
                ".git",
                ".texbutler",
                ".texbutler-verified",
                "target",
                "node_modules",
            ],
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum DestinationEntry {
    Missing,
    ReusableDirectory,
    Conflict,
}

#[cfg(test)]
fn inspect_merge_conflicts_with<F>(
    stage: &Path,
    destination: &Path,
    mut inspect_target: F,
) -> Result<Vec<MergeEntry>, String>
where
    F: FnMut(&Path) -> Result<DestinationEntry, String>,
{
    fn inspect<F>(
        stage: &Path,
        destination: &Path,
        relative: &Path,
        probe_destination: bool,
        entries: &mut Vec<MergeEntry>,
        conflicts: &mut Vec<String>,
        inspect_target: &mut F,
    ) -> Result<(), String>
    where
        F: FnMut(&Path) -> Result<DestinationEntry, String>,
    {
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
            let destination_entry = if probe_destination {
                inspect_target(&target)?
            } else {
                DestinationEntry::Missing
            };
            if destination_entry == DestinationEntry::Conflict
                || (!is_dir && destination_entry == DestinationEntry::ReusableDirectory)
            {
                conflicts.push(child_relative.to_string_lossy().replace('\\', "/"));
            }
            entries.push(MergeEntry {
                relative: child_relative.clone(),
                is_dir,
            });
            if is_dir {
                inspect(
                    stage,
                    destination,
                    &child_relative,
                    destination_entry == DestinationEntry::ReusableDirectory,
                    entries,
                    conflicts,
                    inspect_target,
                )?;
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
        true,
        &mut entries,
        &mut conflicts,
        &mut inspect_target,
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

#[cfg(test)]
fn inspect_merge_conflicts(stage: &Path, destination: &Path) -> Result<Vec<MergeEntry>, String> {
    inspect_merge_conflicts_with(
        stage,
        destination,
        |target| match std::fs::symlink_metadata(target) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                Ok(DestinationEntry::ReusableDirectory)
            }
            Ok(_) => Ok(DestinationEntry::Conflict),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(DestinationEntry::Missing)
            }
            Err(error) => Err(format!("could not inspect template destination: {error}")),
        },
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ObjectIdentity {
    volume: u64,
    index: u64,
}

#[cfg(unix)]
fn object_identity(handle: &std::fs::File) -> Option<ObjectIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = handle.metadata().ok()?;
    Some(ObjectIdentity {
        volume: metadata.dev(),
        index: metadata.ino(),
    })
}

#[cfg(windows)]
fn object_identity(handle: &std::fs::File) -> Option<ObjectIdentity> {
    use std::ffi::c_void;
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct ByHandleFileInformation {
        file_attributes: u32,
        creation_time: FileTime,
        last_access_time: FileTime,
        last_write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            file: *mut c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    // SAFETY: `handle` remains alive for the call and Windows writes the full
    // BY_HANDLE_FILE_INFORMATION value only when the function succeeds.
    let succeeded = unsafe {
        GetFileInformationByHandle(handle.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if succeeded == 0 {
        return None;
    }
    let information = unsafe { information.assume_init() };
    Some(ObjectIdentity {
        volume: u64::from(information.volume_serial_number),
        index: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
    })
}

#[cfg(not(any(unix, windows)))]
fn object_identity(_handle: &std::fs::File) -> Option<ObjectIdentity> {
    None
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
mod relative_directory_io {
    use std::ffi::{c_void, OsStr};
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: *mut c_void,
        object_name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_quality_of_service: *mut c_void,
    }

    #[repr(C)]
    struct IoStatusBlock {
        status_or_pointer: *mut c_void,
        information: usize,
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtCreateFile(
            file_handle: *mut *mut c_void,
            desired_access: u32,
            object_attributes: *mut ObjectAttributes,
            io_status_block: *mut IoStatusBlock,
            allocation_size: *mut i64,
            file_attributes: u32,
            share_access: u32,
            create_disposition: u32,
            create_options: u32,
            ea_buffer: *mut c_void,
            ea_length: u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }

    const DELETE: u32 = 0x0001_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_LIST_DIRECTORY: u32 = 0x0000_0001;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
    const FILE_OPEN: u32 = 0x0000_0001;
    const FILE_CREATE: u32 = 0x0000_0002;
    const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
    const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
    const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x0000_4000;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;

    fn nt_create_relative(
        parent: &std::fs::File,
        name: &OsStr,
        desired_access: u32,
        file_attributes: u32,
        disposition: u32,
        options: u32,
    ) -> io::Result<std::fs::File> {
        let mut name: Vec<u16> = name.encode_wide().collect();
        let byte_len = name
            .len()
            .checked_mul(std::mem::size_of::<u16>())
            .and_then(|length| u16::try_from(length).ok())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "entry name is too long"))?;
        let mut unicode = UnicodeString {
            length: byte_len,
            maximum_length: byte_len,
            buffer: name.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root_directory: parent.as_raw_handle().cast(),
            object_name: &mut unicode,
            attributes: OBJ_CASE_INSENSITIVE,
            security_descriptor: std::ptr::null_mut(),
            security_quality_of_service: std::ptr::null_mut(),
        };
        let mut status_block = IoStatusBlock {
            status_or_pointer: std::ptr::null_mut(),
            information: 0,
        };
        let mut raw_handle = std::ptr::null_mut();
        let status = unsafe {
            NtCreateFile(
                &mut raw_handle,
                desired_access,
                &mut attributes,
                &mut status_block,
                std::ptr::null_mut(),
                file_attributes,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                disposition,
                options,
                std::ptr::null_mut(),
                0,
            )
        };
        if status < 0 {
            let error = unsafe { RtlNtStatusToDosError(status) };
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        Ok(unsafe { std::fs::File::from_raw_handle(raw_handle.cast()) })
    }

    pub fn open_child(parent: &std::fs::File, name: &OsStr) -> io::Result<std::fs::File> {
        nt_create_relative(
            parent,
            name,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_ATTRIBUTE_NORMAL,
            FILE_OPEN,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT,
        )
    }

    pub fn create_directory(parent: &std::fs::File, name: &OsStr) -> io::Result<std::fs::File> {
        nt_create_relative(
            parent,
            name,
            DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_ATTRIBUTE_DIRECTORY,
            FILE_CREATE,
            FILE_DIRECTORY_FILE
                | FILE_SYNCHRONOUS_IO_NONALERT
                | FILE_OPEN_FOR_BACKUP_INTENT
                | FILE_OPEN_REPARSE_POINT,
        )
    }

    pub fn create_file(parent: &std::fs::File, name: &OsStr) -> io::Result<std::fs::File> {
        nt_create_relative(
            parent,
            name,
            GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_ATTRIBUTE_NORMAL,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
        )
    }
}

#[cfg(unix)]
mod relative_directory_io {
    use std::ffi::{c_char, c_int, c_uint, CString, OsStr};
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::{AsRawFd, FromRawFd};

    extern "C" {
        fn openat(dirfd: c_int, path: *const c_char, flags: c_int, mode: c_uint) -> c_int;
        fn mkdirat(dirfd: c_int, path: *const c_char, mode: c_uint) -> c_int;
    }

    const O_RDONLY: c_int = 0;
    const O_WRONLY: c_int = 1;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_CREAT: c_int = 0x40;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_EXCL: c_int = 0x80;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_NOFOLLOW: c_int = 0x20_000;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_CLOEXEC: c_int = 0x8_0000;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    const O_CREAT: c_int = 0x0200;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    const O_EXCL: c_int = 0x0800;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    const O_NOFOLLOW: c_int = 0x0100;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    const O_CLOEXEC: c_int = 0x100_0000;

    fn child_name(name: &OsStr) -> io::Result<CString> {
        CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "entry name contains NUL"))
    }

    fn open_child_with_flags(
        parent: &std::fs::File,
        name: &OsStr,
        flags: c_int,
        mode: c_uint,
    ) -> io::Result<std::fs::File> {
        let name = child_name(name)?;
        let fd = unsafe { openat(parent.as_raw_fd(), name.as_ptr(), flags, mode) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    pub fn open_child(parent: &std::fs::File, name: &OsStr) -> io::Result<std::fs::File> {
        open_child_with_flags(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC, 0)
    }

    pub fn create_directory(parent: &std::fs::File, name: &OsStr) -> io::Result<std::fs::File> {
        let name_c = child_name(name)?;
        let status = unsafe { mkdirat(parent.as_raw_fd(), name_c.as_ptr(), 0o777) };
        if status < 0 {
            return Err(io::Error::last_os_error());
        }
        open_child(parent, name)
    }

    pub fn create_file(parent: &std::fs::File, name: &OsStr) -> io::Result<std::fs::File> {
        open_child_with_flags(
            parent,
            name,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            0o666,
        )
    }
}

struct TrustedDirectory {
    handle: std::fs::File,
    identity: ObjectIdentity,
}

impl TrustedDirectory {
    fn from_handle(handle: std::fs::File) -> Result<Self, String> {
        let metadata = handle
            .metadata()
            .map_err(|error| format!("could not inspect template directory handle: {error}"))?;
        if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
            return Err("template destination is not a trusted directory".into());
        }
        let identity = object_identity(&handle)
            .ok_or_else(|| "could not identify template destination directory".to_string())?;
        Ok(Self { handle, identity })
    }

    fn open_validated(project: &Project, path: &Path) -> Result<Self, String> {
        project.canonical_inside(path)?;
        let trusted = Self::from_handle(open_directory_handle(path)?)?;
        trusted.validate_path(project, path)?;
        Ok(trusted)
    }

    fn validate_path(&self, project: &Project, path: &Path) -> Result<(), String> {
        project.canonical_inside(path)?;
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|error| format!("could not inspect template destination: {error}"))?;
        if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
            return Err("template import destination changed during import".into());
        }
        let current = Self::from_handle(open_directory_handle(path)?)?;
        if current.identity != self.identity {
            return Err("template import destination changed during import".into());
        }
        Ok(())
    }

    fn try_clone(&self) -> Result<Self, String> {
        Self::from_handle(
            self.handle
                .try_clone()
                .map_err(|error| format!("could not retain template directory: {error}"))?,
        )
    }

    fn inspect_child(
        &self,
        name: &std::ffi::OsStr,
    ) -> Result<(DestinationEntry, Option<Self>), String> {
        match relative_directory_io::open_child(&self.handle, name) {
            Ok(handle) => {
                let metadata = handle
                    .metadata()
                    .map_err(|error| format!("could not inspect template destination: {error}"))?;
                if metadata.is_dir() && !metadata_is_reparse_point(&metadata) {
                    let directory = Self::from_handle(handle)?;
                    Ok((DestinationEntry::ReusableDirectory, Some(directory)))
                } else {
                    Ok((DestinationEntry::Conflict, None))
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok((DestinationEntry::Missing, None))
            }
            Err(_) => Ok((DestinationEntry::Conflict, None)),
        }
    }
}

fn open_directory_handle(path: &Path) -> Result<std::fs::File, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        return std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| format!("could not retain template directory ownership: {error}"));
    }

    #[cfg(not(windows))]
    std::fs::File::open(path)
        .map_err(|error| format!("could not retain template directory ownership: {error}"))
}

#[cfg(windows)]
fn create_directory_handle_with_share(
    path: &Path,
    share_delete: bool,
) -> std::io::Result<std::fs::File> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: *mut c_void,
        object_name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_quality_of_service: *mut c_void,
    }

    #[repr(C)]
    struct IoStatusBlock {
        status_or_pointer: *mut c_void,
        information: usize,
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtCreateFile(
            file_handle: *mut *mut c_void,
            desired_access: u32,
            object_attributes: *mut ObjectAttributes,
            io_status_block: *mut IoStatusBlock,
            allocation_size: *mut i64,
            file_attributes: u32,
            share_access: u32,
            create_disposition: u32,
            create_options: u32,
            ea_buffer: *mut c_void,
            ea_length: u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }

    const DELETE: u32 = 0x0001_0000;
    const FILE_LIST_DIRECTORY: u32 = 0x0000_0001;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
    const FILE_CREATE: u32 = 0x0000_0002;
    const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
    const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x0000_4000;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;

    let parent_path = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "directory has no parent")
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "directory has no name")
    })?;
    let parent = open_directory_handle(parent_path).map_err(std::io::Error::other)?;
    let mut name: Vec<u16> = file_name.encode_wide().collect();
    let byte_len = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "directory name is too long",
            )
        })?;
    let mut unicode = UnicodeString {
        length: byte_len,
        maximum_length: byte_len,
        buffer: name.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle().cast(),
        object_name: &mut unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut status_block = IoStatusBlock {
        status_or_pointer: std::ptr::null_mut(),
        information: 0,
    };
    let mut raw_handle = std::ptr::null_mut();
    // SAFETY: all pointers reference initialized values for the duration of
    // the synchronous call. NtCreateFile returns an owned handle on success.
    let status = unsafe {
        NtCreateFile(
            &mut raw_handle,
            DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &mut attributes,
            &mut status_block,
            std::ptr::null_mut(),
            FILE_ATTRIBUTE_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | if share_delete { FILE_SHARE_DELETE } else { 0 },
            FILE_CREATE,
            FILE_DIRECTORY_FILE
                | FILE_SYNCHRONOUS_IO_NONALERT
                | FILE_OPEN_FOR_BACKUP_INTENT
                | FILE_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
            0,
        )
    };
    if status < 0 {
        // SAFETY: converting an NTSTATUS to its Win32 error code has no side
        // effects and accepts every status value.
        let error = unsafe { RtlNtStatusToDosError(status) };
        return Err(std::io::Error::from_raw_os_error(error as i32));
    }
    // SAFETY: successful NtCreateFile returned a unique owned HANDLE.
    Ok(unsafe { std::fs::File::from_raw_handle(raw_handle.cast()) })
}

#[cfg(windows)]
fn create_directory_handle(path: &Path) -> std::io::Result<std::fs::File> {
    create_directory_handle_with_share(path, true)
}

#[cfg(not(windows))]
fn create_directory_handle(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::create_dir(path)?;
    std::fs::File::open(path)
}

#[cfg(test)]
fn create_file_handle(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        const DELETE: u32 = 0x0001_0000;
        const GENERIC_WRITE: u32 = 0x4000_0000;
        const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        return std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .access_mode(GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path);
    }

    #[cfg(not(windows))]
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

fn open_file_identity_handle(path: &Path) -> Result<std::fs::File, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        return std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| format!("could not inspect template entry identity: {error}"));
    }

    #[cfg(not(windows))]
    std::fs::File::open(path)
        .map_err(|error| format!("could not inspect template entry identity: {error}"))
}

#[derive(Clone, Copy)]
enum OwnedObjectKind {
    File,
    Directory,
}

#[cfg(windows)]
fn delete_owned_handle(handle: &std::fs::File) -> bool {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileDispositionInfo {
        delete_file: i32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileInformationByHandle(
            file: *mut c_void,
            information_class: u32,
            information: *const c_void,
            information_size: u32,
        ) -> i32;
    }

    const FILE_DISPOSITION_INFO: u32 = 4;
    const FILE_DISPOSITION_INFO_EX: u32 = 21;
    const FILE_DISPOSITION_FLAG_DELETE: u32 = 0x0000_0001;
    const FILE_DISPOSITION_FLAG_POSIX_SEMANTICS: u32 = 0x0000_0002;
    const FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE: u32 = 0x0000_0010;

    let flags = FILE_DISPOSITION_FLAG_DELETE
        | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
        | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
    // SAFETY: both information buffers have the exact layout and size required
    // by SetFileInformationByHandle and the owned handle remains valid.
    let ex_succeeded = unsafe {
        SetFileInformationByHandle(
            handle.as_raw_handle().cast(),
            FILE_DISPOSITION_INFO_EX,
            (&flags as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    if ex_succeeded != 0 {
        return true;
    }
    let legacy = FileDispositionInfo { delete_file: 1 };
    unsafe {
        SetFileInformationByHandle(
            handle.as_raw_handle().cast(),
            FILE_DISPOSITION_INFO,
            (&legacy as *const FileDispositionInfo).cast(),
            std::mem::size_of::<FileDispositionInfo>() as u32,
        ) != 0
    }
}

#[cfg(windows)]
fn rename_owned_handle(handle: &std::fs::File, target: &Path) -> Result<(), std::io::Error> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileRenameInfoLayout {
        flags: u32,
        root_directory: *mut c_void,
        file_name_length: u32,
        file_name: [u16; 1],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileInformationByHandle(
            file: *mut c_void,
            information_class: u32,
            information: *const c_void,
            information_size: u32,
        ) -> i32;
    }

    const FILE_RENAME_INFO: u32 = 3;
    let mut name: Vec<u16> = target.as_os_str().encode_wide().collect();
    let name_bytes = match name.len().checked_mul(std::mem::size_of::<u16>()) {
        Some(length) => length,
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "rename target name is too long",
            ))
        }
    };
    let name_offset = std::mem::offset_of!(FileRenameInfoLayout, file_name);
    name.push(0);
    let buffer_name_bytes = match name.len().checked_mul(std::mem::size_of::<u16>()) {
        Some(length) => length,
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "rename target name is too long",
            ))
        }
    };
    let total = match name_offset.checked_add(buffer_name_bytes) {
        Some(length) if length <= u32::MAX as usize => length,
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "rename information is too large",
            ))
        }
    };
    let mut information = vec![0u8; total];
    // SAFETY: offsets come from the repr(C) layout above; the destination
    // buffer is sized for the fixed fields plus the complete UTF-16 name.
    unsafe {
        let base = information.as_mut_ptr();
        (base.add(std::mem::offset_of!(FileRenameInfoLayout, flags)) as *mut u32).write(0);
        (base.add(std::mem::offset_of!(FileRenameInfoLayout, root_directory)) as *mut *mut c_void)
            .write(std::ptr::null_mut());
        (base.add(std::mem::offset_of!(FileRenameInfoLayout, file_name_length)) as *mut u32)
            .write(name_bytes as u32);
        std::ptr::copy_nonoverlapping(name.as_ptr(), base.add(name_offset).cast(), name.len());
        let succeeded = SetFileInformationByHandle(
            handle.as_raw_handle().cast(),
            FILE_RENAME_INFO,
            information.as_ptr().cast(),
            total as u32,
        );
        if succeeded != 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

#[cfg(windows)]
fn create_owned_cleanup_container(path: &Path) -> Option<(OwnedObject, PathBuf)> {
    let parent = path.parent()?;
    loop {
        let nonce = NEXT_IMPORT_TEMP.fetch_add(1, Ordering::Relaxed);
        let container = parent.join(format!(".texbutler-cleanup-{}-{nonce}", std::process::id()));
        match create_directory_handle_with_share(&container, false) {
            Ok(handle) => {
                let owned = OwnedObject::from_new_handle_with_identity(
                    container.clone(),
                    handle,
                    OwnedObjectKind::Directory,
                    object_identity,
                )
                .ok()?;
                return Some((owned, container.join("owned")));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
}

#[cfg(not(windows))]
fn create_cleanup_container(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let parent = path.parent()?;
    loop {
        let nonce = NEXT_IMPORT_TEMP.fetch_add(1, Ordering::Relaxed);
        let container = parent.join(format!(".texbutler-cleanup-{}-{nonce}", std::process::id()));
        match std::fs::create_dir(&container) {
            Ok(()) => return Some((container.clone(), container.join("owned"))),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
}

struct OwnedObject {
    path: PathBuf,
    // Keeping the original object open prevents its OS identity from being
    // recycled while rollback decides whether the path still names it.
    handle: std::fs::File,
    identity: ObjectIdentity,
    kind: OwnedObjectKind,
}

impl OwnedObject {
    fn from_new_handle_with_identity(
        path: PathBuf,
        handle: std::fs::File,
        kind: OwnedObjectKind,
        identify: fn(&std::fs::File) -> Option<ObjectIdentity>,
    ) -> Result<Self, String> {
        let result = handle
            .metadata()
            .map_err(|error| format!("could not identify created template entry: {error}"))
            .and_then(|metadata| {
                let expected_type = match kind {
                    OwnedObjectKind::File => metadata.is_file(),
                    OwnedObjectKind::Directory => metadata.is_dir(),
                };
                if !expected_type || metadata_is_reparse_point(&metadata) {
                    return Err("created template entry has an unsafe object type".into());
                }
                identify(&handle)
                    .ok_or_else(|| "could not identify created template entry".to_string())
            });
        match result {
            Ok(identity) => Ok(Self {
                path,
                handle,
                identity,
                kind,
            }),
            Err(error) => {
                cleanup_unidentified_created_object(path, handle, kind);
                Err(error)
            }
        }
    }

    fn path_still_names_owned_object(&self) -> bool {
        let Ok(metadata) = std::fs::symlink_metadata(&self.path) else {
            return false;
        };
        if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
            return false;
        }
        let expected_type = match self.kind {
            OwnedObjectKind::File => metadata.is_file(),
            OwnedObjectKind::Directory => metadata.is_dir(),
        };
        if !expected_type {
            return false;
        }
        let current = match self.kind {
            OwnedObjectKind::File => open_file_identity_handle(&self.path),
            OwnedObjectKind::Directory => open_directory_handle(&self.path),
        };
        current.ok().and_then(|handle| object_identity(&handle)) == Some(self.identity)
    }

    fn remove_file_if_still_owned(self) {
        self.remove_file_if_owned_with(|| {});
    }

    fn remove_file_if_owned_with<F>(self, before_remove: F)
    where
        F: FnOnce(),
    {
        let path_was_owned = self.path_still_names_owned_object();
        before_remove();
        #[cfg(windows)]
        {
            let _ = path_was_owned;
            let _ = delete_owned_handle(&self.handle);
            return;
        }
        #[cfg(not(windows))]
        self.remove_via_portable_quarantine(path_was_owned, false);
    }

    fn remove_empty_directory_if_still_owned(self) {
        self.remove_empty_directory_if_owned_with(|| {});
    }

    fn remove_empty_directory_if_owned_with<F>(self, before_remove: F)
    where
        F: FnOnce(),
    {
        let path_was_owned = self.path_still_names_owned_object();
        before_remove();
        #[cfg(windows)]
        {
            let _ = path_was_owned;
            let _ = delete_owned_handle(&self.handle);
            return;
        }
        #[cfg(not(windows))]
        self.remove_via_portable_quarantine(path_was_owned, false);
    }

    fn remove_directory_tree_if_still_owned(self) {
        self.remove_directory_tree_if_owned_with(|| {});
    }

    fn remove_directory_tree_if_owned_with<F>(self, before_remove: F)
    where
        F: FnOnce(),
    {
        let path_was_owned = self.path_still_names_owned_object();
        before_remove();
        #[cfg(windows)]
        {
            let _ = path_was_owned;
            let Some((container, quarantined)) = create_owned_cleanup_container(&self.path) else {
                return;
            };
            if rename_owned_handle(&self.handle, &quarantined).is_err() {
                container.remove_empty_directory_if_still_owned();
                return;
            }
            drop(self.handle);
            let _ = std::fs::remove_dir_all(&quarantined);
            container.remove_empty_directory_if_still_owned();
            return;
        }
        #[cfg(not(windows))]
        self.remove_via_portable_quarantine(path_was_owned, true);
    }

    #[cfg(not(windows))]
    fn remove_via_portable_quarantine(self, path_was_owned: bool, recursive: bool) {
        if !path_was_owned {
            return;
        }
        let Some((container, quarantined)) = create_cleanup_container(&self.path) else {
            return;
        };
        if std::fs::rename(&self.path, &quarantined).is_err() {
            let _ = std::fs::remove_dir(&container);
            return;
        }
        let current = match self.kind {
            OwnedObjectKind::File => open_file_identity_handle(&quarantined),
            OwnedObjectKind::Directory => open_directory_handle(&quarantined),
        };
        if current.ok().and_then(|handle| object_identity(&handle)) != Some(self.identity) {
            if !self.path.exists() {
                let _ = std::fs::rename(&quarantined, &self.path);
            }
            let _ = std::fs::remove_dir(&container);
            return;
        }
        drop(self.handle);
        if recursive {
            let _ = std::fs::remove_dir_all(&quarantined);
        } else {
            match self.kind {
                OwnedObjectKind::File => {
                    let _ = std::fs::remove_file(&quarantined);
                }
                OwnedObjectKind::Directory => {
                    let _ = std::fs::remove_dir(&quarantined);
                }
            }
        }
        let _ = std::fs::remove_dir(&container);
    }
}

fn cleanup_unidentified_created_object(
    path: PathBuf,
    handle: std::fs::File,
    kind: OwnedObjectKind,
) {
    #[cfg(windows)]
    {
        let _ = (&path, kind);
        let _ = delete_owned_handle(&handle);
        return;
    }
    #[cfg(not(windows))]
    if let Some(identity) = object_identity(&handle) {
        let owned = OwnedObject {
            path,
            handle,
            identity,
            kind,
        };
        match kind {
            OwnedObjectKind::File => owned.remove_file_if_still_owned(),
            OwnedObjectKind::Directory => owned.remove_empty_directory_if_still_owned(),
        }
    }
}

#[cfg(test)]
fn create_owned_file_with_identity(
    path: &Path,
    identify: fn(&std::fs::File) -> Option<ObjectIdentity>,
) -> Result<OwnedObject, String> {
    let handle = create_file_handle(path)
        .map_err(|error| format!("could not create template file: {error}"))?;
    OwnedObject::from_new_handle_with_identity(
        path.to_path_buf(),
        handle,
        OwnedObjectKind::File,
        identify,
    )
}

#[cfg(test)]
fn create_owned_file(path: &Path) -> Result<OwnedObject, String> {
    create_owned_file_with_identity(path, object_identity)
}

#[cfg(test)]
fn create_owned_directory_with_identity(
    path: &Path,
    identify: fn(&std::fs::File) -> Option<ObjectIdentity>,
) -> Result<OwnedObject, String> {
    let handle = create_directory_handle(path)
        .map_err(|error| format!("could not create template directory: {error}"))?;
    OwnedObject::from_new_handle_with_identity(
        path.to_path_buf(),
        handle,
        OwnedObjectKind::Directory,
        identify,
    )
}

#[cfg(test)]
fn create_owned_directory(path: &Path) -> Result<OwnedObject, String> {
    create_owned_directory_with_identity(path, object_identity)
}

#[derive(Default)]
struct CreatedEntries {
    files: Vec<OwnedObject>,
    dirs: Vec<OwnedObject>,
}

impl CreatedEntries {
    fn rollback(&mut self) {
        while let Some(file) = self.files.pop() {
            file.remove_file_if_still_owned();
        }
        while let Some(dir) = self.dirs.pop() {
            dir.remove_empty_directory_if_still_owned();
        }
    }
}

struct TrustedMergePlan {
    entries: Vec<MergeEntry>,
    directories: std::collections::HashMap<PathBuf, TrustedDirectory>,
}

fn inspect_merge_conflicts_trusted(
    stage: &Path,
    destination: TrustedDirectory,
) -> Result<TrustedMergePlan, String> {
    fn inspect(
        stage: &Path,
        relative: &Path,
        destination: Option<TrustedDirectory>,
        entries: &mut Vec<MergeEntry>,
        conflicts: &mut Vec<String>,
        directories: &mut std::collections::HashMap<PathBuf, TrustedDirectory>,
    ) -> Result<(), String> {
        let source_dir = stage.join(relative);
        let mut children = std::fs::read_dir(&source_dir)
            .map_err(|error| format!("could not inspect staged template: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("could not inspect staged template: {error}"))?;
        children.sort_by_key(|entry| entry.file_name());

        for child in children {
            let name = child.file_name();
            let child_relative = relative.join(&name);
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

            let (destination_entry, child_directory) = match destination.as_ref() {
                Some(parent) => parent.inspect_child(&name)?,
                None => (DestinationEntry::Missing, None),
            };
            if destination_entry == DestinationEntry::Conflict
                || (!is_dir && destination_entry == DestinationEntry::ReusableDirectory)
            {
                conflicts.push(child_relative.to_string_lossy().replace('\\', "/"));
            }
            entries.push(MergeEntry {
                relative: child_relative.clone(),
                is_dir,
            });
            if is_dir {
                let next_directory = if destination_entry == DestinationEntry::ReusableDirectory {
                    let directory = child_directory.ok_or_else(|| {
                        "template destination directory handle was lost".to_string()
                    })?;
                    directories.insert(child_relative.clone(), directory.try_clone()?);
                    Some(directory)
                } else {
                    None
                };
                inspect(
                    stage,
                    &child_relative,
                    next_directory,
                    entries,
                    conflicts,
                    directories,
                )?;
            }
        }
        Ok(())
    }

    let mut entries = Vec::new();
    let mut conflicts = Vec::new();
    let mut directories = std::collections::HashMap::new();
    directories.insert(PathBuf::new(), destination.try_clone()?);
    inspect(
        stage,
        Path::new(""),
        Some(destination),
        &mut entries,
        &mut conflicts,
        &mut directories,
    )?;
    if conflicts.is_empty() {
        Ok(TrustedMergePlan {
            entries,
            directories,
        })
    } else {
        Err(format!(
            "template import conflicts with existing entries: {}",
            conflicts.join(", ")
        ))
    }
}

fn create_owned_file_relative(
    parent: &TrustedDirectory,
    name: &std::ffi::OsStr,
    path: &Path,
) -> Result<OwnedObject, String> {
    let handle = relative_directory_io::create_file(&parent.handle, name)
        .map_err(|error| format!("could not create template file: {error}"))?;
    OwnedObject::from_new_handle_with_identity(
        path.to_path_buf(),
        handle,
        OwnedObjectKind::File,
        object_identity,
    )
}

fn create_owned_directory_relative(
    parent: &TrustedDirectory,
    name: &std::ffi::OsStr,
    path: &Path,
) -> Result<OwnedObject, String> {
    let handle = relative_directory_io::create_directory(&parent.handle, name)
        .map_err(|error| format!("could not create template directory: {error}"))?;
    OwnedObject::from_new_handle_with_identity(
        path.to_path_buf(),
        handle,
        OwnedObjectKind::Directory,
        object_identity,
    )
}

fn merge_staged_tree_trusted_with<F, R>(
    stage: &Path,
    destination_path: &Path,
    mut plan: TrustedMergePlan,
    mut copier: F,
    mut retain_directory: R,
) -> Result<(), String>
where
    F: FnMut(&Path, &mut std::fs::File) -> Result<(), String>,
    R: FnMut(&OwnedObject) -> Result<TrustedDirectory, String>,
{
    let mut created = CreatedEntries::default();
    for entry in plan.entries {
        if entry.is_dir && plan.directories.contains_key(&entry.relative) {
            continue;
        }
        let parent_relative = entry.relative.parent().unwrap_or_else(|| Path::new(""));
        let name = entry
            .relative
            .file_name()
            .ok_or_else(|| "invalid staged template entry".to_string())?;
        let target_path = destination_path.join(&entry.relative);

        if entry.is_dir {
            let directory = {
                let parent = plan
                    .directories
                    .get(parent_relative)
                    .ok_or_else(|| "template destination parent handle is missing".to_string())?;
                match create_owned_directory_relative(parent, name, &target_path) {
                    Ok(directory) => directory,
                    Err(error) => {
                        created.rollback();
                        return Err(error);
                    }
                }
            };
            created.dirs.push(directory);
            let trusted = match retain_directory(created.dirs.last().expect("just pushed")) {
                Ok(trusted) => trusted,
                Err(error) => {
                    created.rollback();
                    return Err(error);
                }
            };
            plan.directories.insert(entry.relative, trusted);
        } else {
            let file = {
                let parent = plan
                    .directories
                    .get(parent_relative)
                    .ok_or_else(|| "template destination parent handle is missing".to_string())?;
                match create_owned_file_relative(parent, name, &target_path) {
                    Ok(file) => file,
                    Err(error) => {
                        created.rollback();
                        return Err(error);
                    }
                }
            };
            created.files.push(file);
            let target = &mut created.files.last_mut().expect("just pushed").handle;
            if let Err(error) = copier(&stage.join(&entry.relative), target) {
                created.rollback();
                return Err(error);
            }
        }
    }
    Ok(())
}

fn merge_staged_tree_trusted(
    project: &Project,
    stage: &Path,
    destination_path: &Path,
    destination: TrustedDirectory,
) -> Result<(), String> {
    destination.validate_path(project, destination_path)?;
    let plan = inspect_merge_conflicts_trusted(stage, destination)?;
    merge_staged_tree_trusted_with(
        stage,
        destination_path,
        plan,
        |source, target| {
            let mut source = std::fs::File::open(source)
                .map_err(|error| format!("could not open staged template file: {error}"))?;
            std::io::copy(&mut source, target)
                .map(|_| ())
                .map_err(|error| format!("could not copy template file: {error}"))
        },
        |directory| {
            TrustedDirectory::from_handle(
                directory
                    .handle
                    .try_clone()
                    .map_err(|error| format!("could not retain template directory: {error}"))?,
            )
        },
    )
}

#[cfg(test)]
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
                    match create_owned_directory(&target) {
                        Ok(directory) => created.dirs.push(directory),
                        Err(error) => {
                            created.rollback();
                            return Err(error);
                        }
                    }
                }
                Err(error) => {
                    created.rollback();
                    return Err(format!("could not inspect template destination: {error}"));
                }
            }
        } else {
            let target = match create_owned_file(&target) {
                Ok(target) => target,
                Err(error) => {
                    created.rollback();
                    return Err(error);
                }
            };
            created.files.push(target);
            let target_file = &mut created.files.last_mut().expect("just pushed").handle;
            if let Err(error) = copier(&stage.join(&entry.relative), target_file) {
                created.rollback();
                return Err(error);
            }
        }
    }
    Ok(())
}

fn join_relative(directory: &str, child: &str) -> String {
    if directory.is_empty() {
        child.to_string()
    } else {
        format!("{directory}/{child}")
    }
}

struct OwnedImportStage {
    path: PathBuf,
    owned: Option<OwnedObject>,
}

impl Drop for OwnedImportStage {
    fn drop(&mut self) {
        if let Some(owned) = self.owned.take() {
            owned.remove_directory_tree_if_still_owned();
        }
    }
}

fn ensure_real_import_directory(project: &Project, path: &Path, label: &str) -> Result<(), String> {
    loop {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "template import {label} may not be a symbolic link"
                ));
            }
            Ok(metadata) if metadata.is_dir() => {
                project.canonical_inside(path)?;
                return Ok(());
            }
            Ok(_) => {
                return Err(format!(
                    "template import {label} is not a directory: {}",
                    path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::create_dir(path) {
                    Ok(()) => {
                        if let Err(error) = project.canonical_inside(path) {
                            let _ = std::fs::remove_dir(path);
                            return Err(error);
                        }
                        return Ok(());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => {
                        return Err(format!("could not create template import {label}: {error}"));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "could not inspect template import {label}: {error}"
                ));
            }
        }
    }
}

fn create_import_stage_from_nonce(
    project: &Project,
    starting_nonce: u64,
) -> Result<OwnedImportStage, String> {
    create_import_stage_from_nonce_with_identity(project, starting_nonce, object_identity)
}

fn create_import_stage_from_nonce_with_identity(
    project: &Project,
    starting_nonce: u64,
    identify: fn(&std::fs::File) -> Option<ObjectIdentity>,
) -> Result<OwnedImportStage, String> {
    let metadata_dir = project.root.join(".texbutler");
    ensure_real_import_directory(project, &metadata_dir, "metadata directory")?;
    let backup_dir = project.backup_dir();
    ensure_real_import_directory(project, &backup_dir, "backup directory")?;

    let mut nonce = starting_nonce;
    loop {
        let stage = backup_dir.join(format!("import-stage-{}-{nonce}", std::process::id()));
        project.canonical_inside(&stage)?;
        match create_directory_handle(&stage) {
            Ok(handle) => {
                let owned = OwnedObject::from_new_handle_with_identity(
                    stage.clone(),
                    handle,
                    OwnedObjectKind::Directory,
                    identify,
                )?;
                if let Err(error) = project.canonical_inside(&stage) {
                    owned.remove_empty_directory_if_still_owned();
                    return Err(error);
                }
                return Ok(OwnedImportStage {
                    path: stage,
                    owned: Some(owned),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                nonce = nonce
                    .checked_add(1)
                    .ok_or_else(|| "template import stage nonce exhausted".to_string())?;
            }
            Err(error) => {
                return Err(format!("could not create template import stage: {error}"));
            }
        }
    }
}

fn merge_resolved_template_from_nonce(
    project: &Project,
    destination_dir: &str,
    source: ResolvedTemplate<'_>,
    starting_nonce: u64,
) -> Result<ImportedTemplate, String> {
    let destination_dir = normalize_existing_project_dir(project, destination_dir)?;
    let destination = project
        .resolve(&destination_dir)
        .ok_or_else(|| "template import directory escapes the project".to_string())?;
    let trusted_destination = TrustedDirectory::open_validated(project, &destination)?;
    let stage = create_import_stage_from_nonce(project, starting_nonce)?;
    let main_inside = {
        stage_resolved_template(source, &stage.path)?;
        let main_inside = detect_main_document(&stage.path)?;
        merge_staged_tree_trusted(project, &stage.path, &destination, trusted_destination)?;
        main_inside
    };
    Ok(ImportedTemplate {
        target_dir: destination_dir.clone(),
        main_file: join_relative(&destination_dir, &main_inside),
    })
}

pub fn merge_resolved_template(
    project: &Project,
    destination_dir: &str,
    source: ResolvedTemplate<'_>,
) -> Result<ImportedTemplate, String> {
    merge_resolved_template_from_nonce(
        project,
        destination_dir,
        source,
        NEXT_IMPORT_TEMP.fetch_add(1, Ordering::Relaxed),
    )
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
    copy_tree_checked(
        src,
        dst,
        &[".texbutler-verified", ".git", ".texbutler", "target", "node_modules"],
    )
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
    fn merge_rollback_preserves_file_that_replaced_owned_file() {
        let root = test_root("merge-replaced-file");
        let staged = root.join("staged");
        let destination = root.join("destination");
        let target = destination.join("paper.tex");
        let displaced = destination.join("owned-paper.tex");
        write_fixture(&staged.join("paper.tex"), b"staged\n");
        std::fs::create_dir_all(&destination).unwrap();
        let entries = inspect_merge_conflicts(&staged, &destination).unwrap();
        let injected = "injected after file replacement".to_string();

        let error = merge_staged_tree_with(&staged, &destination, &entries, |_from, to| {
            std::io::Write::write_all(to, b"owned\n").unwrap();
            std::fs::rename(&target, &displaced).unwrap();
            std::fs::write(&target, b"external\n").unwrap();
            Err(injected.clone())
        })
        .unwrap_err();

        assert_eq!(error, injected);
        assert_eq!(std::fs::read(&target).unwrap(), b"external\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_file_removal_preserves_replacement_created_after_verification() {
        let root = test_root("owned-file-post-verification-replacement");
        let target = root.join("owned.tex");
        let displaced = root.join("displaced.tex");
        std::fs::create_dir_all(&root).unwrap();
        let mut owned = create_owned_file(&target).unwrap();
        std::io::Write::write_all(&mut owned.handle, b"owned\n").unwrap();

        owned.remove_file_if_owned_with(|| {
            std::fs::rename(&target, &displaced).unwrap();
            std::fs::write(&target, b"replacement\n").unwrap();
        });

        assert_eq!(std::fs::read(&target).unwrap(), b"replacement\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_rollback_preserves_directory_that_replaced_owned_directory() {
        let root = test_root("merge-replaced-directory");
        let staged = root.join("staged");
        let destination = root.join("destination");
        let target = destination.join("created-directory");
        let displaced = destination.join("owned-directory");
        std::fs::create_dir_all(staged.join("created-directory")).unwrap();
        write_fixture(&staged.join("later.tex"), b"staged\n");
        std::fs::create_dir_all(&destination).unwrap();
        let entries = inspect_merge_conflicts(&staged, &destination).unwrap();
        let injected = "injected after directory replacement".to_string();

        let error = merge_staged_tree_with(&staged, &destination, &entries, |_from, _to| {
            std::fs::rename(&target, &displaced).unwrap();
            std::fs::create_dir(&target).unwrap();
            Err(injected.clone())
        })
        .unwrap_err();

        assert_eq!(error, injected);
        assert!(
            target.is_dir(),
            "replacement directory must survive rollback"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_stage_removal_preserves_replacement_created_after_verification() {
        let root = test_root("owned-stage-post-verification-replacement");
        let target = root.join("stage");
        let displaced = root.join("displaced-stage");
        let owned = create_owned_directory(&target).unwrap();
        write_fixture(&target.join("owned.txt"), b"owned\n");

        owned.remove_directory_tree_if_owned_with(|| {
            std::fs::rename(&target, &displaced).unwrap();
            write_fixture(&target.join("external.txt"), b"external\n");
        });

        assert_eq!(
            std::fs::read(target.join("external.txt")).unwrap(),
            b"external\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn missing_identity(_handle: &std::fs::File) -> Option<ObjectIdentity> {
        None
    }

    #[test]
    fn identity_acquisition_failure_cleans_new_file_and_directory() {
        let root = test_root("identity-failure-cleanup");
        let file = root.join("created.tex");
        let directory = root.join("created-directory");
        std::fs::create_dir_all(&root).unwrap();

        let file_error = match create_owned_file_with_identity(&file, missing_identity) {
            Ok(_) => panic!("file identity acquisition must fail"),
            Err(error) => error,
        };
        let directory_error =
            match create_owned_directory_with_identity(&directory, missing_identity) {
                Ok(_) => panic!("directory identity acquisition must fail"),
                Err(error) => error,
            };

        assert_eq!(file_error, "could not identify created template entry");
        assert_eq!(directory_error, "could not identify created template entry");
        assert!(
            !file.exists(),
            "failed file acquisition must not leave residue"
        );
        assert!(
            !directory.exists(),
            "failed directory acquisition must not leave residue"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn trusted_merge_directory_retention_failure_rolls_back_all_created_entries() {
        let root = test_root("trusted-directory-retention-failure");
        let stage = root.join("stage");
        let destination = root.join("project");
        write_fixture(&stage.join("a.tex"), b"created first\n");
        write_fixture(&stage.join("nested/main.tex"), b"nested\n");
        write_fixture(&destination.join("main.tex"), b"project\n");
        let project = Project::open(&destination).unwrap();
        let trusted = TrustedDirectory::open_validated(&project, &destination).unwrap();
        let plan = inspect_merge_conflicts_trusted(&stage, trusted).unwrap();
        let injected = "injected directory retention failure".to_string();

        let error = merge_staged_tree_trusted_with(
            &stage,
            &destination,
            plan,
            |source, target| {
                let mut source = std::fs::File::open(source).unwrap();
                std::io::copy(&mut source, target).unwrap();
                Ok(())
            },
            |_directory| Err(injected.clone()),
        )
        .unwrap_err();

        assert_eq!(error, injected);
        assert!(!destination.join("a.tex").exists());
        assert!(!destination.join("nested").exists());
        assert_eq!(
            std::fs::read(destination.join("main.tex")).unwrap(),
            b"project\n"
        );
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

    #[test]
    fn merge_collects_sibling_conflicts_when_staged_directory_hits_file() {
        let root = test_root("merge-directory-file-conflicts");
        let staged = root.join("staged");
        let destination = root.join("destination");
        write_fixture(&staged.join("blocked/child.tex"), b"child\n");
        write_fixture(&staged.join("sibling.tex"), b"new\n");
        write_fixture(&destination.join("blocked"), b"not a directory\n");
        write_fixture(&destination.join("sibling.tex"), b"existing\n");

        let error = inspect_merge_conflicts(&staged, &destination).unwrap_err();

        assert!(error.starts_with("template import conflicts with existing entries:"));
        assert!(error.contains("blocked"));
        assert!(error.contains("sibling.tex"));
        assert!(!error.contains("could not inspect template destination"));
        assert_eq!(
            std::fs::read(destination.join("blocked")).unwrap(),
            b"not a directory\n"
        );
        assert_eq!(
            std::fs::read(destination.join("sibling.tex")).unwrap(),
            b"existing\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_conflict_scanner_skips_target_children_below_non_directory() {
        let root = test_root("merge-conflict-probe-boundary");
        let staged = root.join("staged");
        let destination = root.join("destination");
        write_fixture(&staged.join("blocked/child.tex"), b"child\n");
        write_fixture(&staged.join("sibling.tex"), b"new\n");
        std::fs::create_dir_all(&destination).unwrap();
        let mut probed = Vec::new();

        let error = inspect_merge_conflicts_with(&staged, &destination, |target| {
            let relative = target.strip_prefix(&destination).unwrap().to_path_buf();
            assert_ne!(relative, PathBuf::from("blocked/child.tex"));
            probed.push(relative.clone());
            Ok(
                if relative == Path::new("blocked") || relative == Path::new("sibling.tex") {
                    DestinationEntry::Conflict
                } else {
                    DestinationEntry::Missing
                },
            )
        })
        .unwrap_err();

        assert!(error.contains("blocked"));
        assert!(error.contains("sibling.tex"));
        assert_eq!(
            probed,
            vec![PathBuf::from("blocked"), PathBuf::from("sibling.tex")]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_collects_file_to_directory_mismatch_with_sibling_conflicts() {
        let root = test_root("merge-file-directory-conflicts");
        let staged = root.join("staged");
        let destination = root.join("destination");
        write_fixture(&staged.join("blocked"), b"file\n");
        write_fixture(&staged.join("sibling.tex"), b"new\n");
        std::fs::create_dir_all(destination.join("blocked")).unwrap();
        write_fixture(&destination.join("sibling.tex"), b"existing\n");

        let error = inspect_merge_conflicts(&staged, &destination).unwrap_err();

        assert!(error.starts_with("template import conflicts with existing entries:"));
        assert!(error.contains("blocked"));
        assert!(error.contains("sibling.tex"));
        assert!(destination.join("blocked").is_dir());
        assert_eq!(
            std::fs::read(destination.join("sibling.tex")).unwrap(),
            b"existing\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_does_not_follow_conflicting_destination_symlink_subtree() {
        let root = test_root("merge-directory-symlink-conflicts");
        let staged = root.join("staged");
        let destination = root.join("destination");
        let outside = root.join("outside");
        write_fixture(&staged.join("blocked/child.tex"), b"child\n");
        write_fixture(&staged.join("sibling.tex"), b"new\n");
        write_fixture(&outside.join("child.tex"), b"outside\n");
        write_fixture(&destination.join("sibling.tex"), b"existing\n");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, destination.join("blocked")).unwrap();
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_dir(&outside, destination.join("blocked"))
        {
            if symlink_privilege_unavailable(&error) {
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            panic!("failed to create destination symlink: {error}");
        }

        let error = inspect_merge_conflicts(&staged, &destination).unwrap_err();

        assert!(error.starts_with("template import conflicts with existing entries:"));
        assert!(error.contains("blocked"));
        assert!(error.contains("sibling.tex"));
        assert!(!error.contains("blocked/child.tex"));
        assert_eq!(
            std::fs::read(outside.join("child.tex")).unwrap(),
            b"outside\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_preserves_stale_stage_and_uses_exclusive_sibling() {
        let root = test_root("merge-stale-stage");
        let project_root = root.join("project");
        let source_root = root.join("source");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&source_root.join("paper.tex"), b"\\documentclass{report}\n");
        let project = Project::open(&project_root).unwrap();
        let nonce = 9_000_000 + NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
        let stale = project
            .backup_dir()
            .join(format!("import-stage-{}-{nonce}", std::process::id()));
        write_fixture(&stale.join("stale.txt"), b"preserve\n");

        let imported = merge_resolved_template_from_nonce(
            &project,
            "",
            ResolvedTemplate::Directory(&source_root),
            nonce,
        )
        .unwrap();

        assert_eq!(imported.main_file, "paper.tex");
        assert_eq!(
            std::fs::read(stale.join("stale.txt")).unwrap(),
            b"preserve\n"
        );
        let stages = std::fs::read_dir(project.backup_dir())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("import-stage-")
            })
            .count();
        assert_eq!(stages, 1, "only the pre-existing stale stage may remain");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_rejects_outward_backup_symlink_without_touching_external_files() {
        let root = test_root("merge-backup-symlink");
        let project_root = root.join("project");
        let source_root = root.join("source");
        let outside = root.join("outside");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&source_root.join("paper.tex"), b"\\documentclass{report}\n");
        write_fixture(&outside.join("keep.txt"), b"outside\n");
        std::fs::create_dir_all(project_root.join(".texbutler")).unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, project_root.join(".texbutler/backup")).unwrap();
        #[cfg(windows)]
        if let Err(error) =
            std::os::windows::fs::symlink_dir(&outside, project_root.join(".texbutler/backup"))
        {
            if symlink_privilege_unavailable(&error) {
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            panic!("failed to create backup symlink: {error}");
        }
        let project = Project::open(&project_root).unwrap();

        let error = merge_resolved_template_from_nonce(
            &project,
            "",
            ResolvedTemplate::Directory(&source_root),
            9_100_000,
        )
        .unwrap_err();

        assert!(error.contains("symbolic link"));
        assert_eq!(
            std::fs::read(outside.join("keep.txt")).unwrap(),
            b"outside\n"
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
        assert!(!project_root.join("paper.tex").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_cleans_owned_stage_after_success_and_failure() {
        let root = test_root("merge-stage-cleanup");
        let project_root = root.join("project");
        let valid_source = root.join("valid-source");
        let invalid_source = root.join("invalid-source");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(
            &valid_source.join("paper.tex"),
            b"\\documentclass{report}\n",
        );
        write_fixture(&invalid_source.join("chapter.tex"), b"chapter\n");
        let project = Project::open(&project_root).unwrap();

        merge_resolved_template_from_nonce(
            &project,
            "",
            ResolvedTemplate::Directory(&valid_source),
            9_200_000,
        )
        .unwrap();
        assert!(merge_resolved_template_from_nonce(
            &project,
            "",
            ResolvedTemplate::Directory(&invalid_source),
            9_300_000,
        )
        .is_err());

        let residue = std::fs::read_dir(project.backup_dir())
            .unwrap()
            .flatten()
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("import-stage-")
            });
        assert!(
            !residue,
            "owned stages must be removed on success and failure"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owned_stage_drop_preserves_replaced_directory() {
        let root = test_root("merge-replaced-stage");
        let project_root = root.join("project");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        let project = Project::open(&project_root).unwrap();
        let stage = create_import_stage_from_nonce(&project, 9_400_000).unwrap();
        let stage_path = stage.path.clone();
        let displaced = project.backup_dir().join("displaced-stage");
        std::fs::rename(&stage_path, &displaced).unwrap();
        write_fixture(&stage_path.join("external.txt"), b"external\n");

        drop(stage);

        assert_eq!(
            std::fs::read(stage_path.join("external.txt")).unwrap(),
            b"external\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stage_identity_acquisition_failure_removes_created_stage() {
        let root = test_root("stage-identity-failure");
        let project_root = root.join("project");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        let project = Project::open(&project_root).unwrap();
        let nonce = 9_500_000 + NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
        let stage_path = project
            .backup_dir()
            .join(format!("import-stage-{}-{nonce}", std::process::id()));

        let error =
            match create_import_stage_from_nonce_with_identity(&project, nonce, missing_identity) {
                Ok(_) => panic!("stage identity acquisition must fail"),
                Err(error) => error,
            };

        assert_eq!(error, "could not identify created template entry");
        assert!(
            !stage_path.exists(),
            "failed stage acquisition must clean up"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn downloaded_template_marker_is_not_imported_or_reimported_as_a_conflict() {
        let root = test_root("merge-market-marker");
        let project_root = root.join("project");
        let first_download = root.join("market-first");
        let second_download = root.join("market-second");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&first_download.join(".texbutler-verified"), b"verified\n");
        write_fixture(
            &first_download.join("chapters/first.tex"),
            b"\\documentclass{article}\nfirst market file\n",
        );
        write_fixture(&second_download.join(".texbutler-verified"), b"verified\n");
        write_fixture(
            &second_download.join("chapters/second.tex"),
            b"\\documentclass{article}\nsecond market file\n",
        );
        let project = Project::open(&project_root).unwrap();

        let first = resolve_market_template("remote-first", &first_download).unwrap();
        merge_resolved_template(&project, "", first).unwrap();
        let second = resolve_market_template("remote-second", &second_download).unwrap();
        let second_result = merge_resolved_template(&project, "", second);
        let marker_exists = project_root.join(".texbutler-verified").exists();
        let first_exists = project_root.join("chapters/first.tex").exists();
        let second_exists = project_root.join("chapters/second.tex").exists();
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            second_result.is_ok(),
            "second import should not conflict: {second_result:?}"
        );
        assert!(
            !marker_exists,
            "verification metadata must remain outside the project"
        );
        assert!(first_exists && second_exists);
    }

    #[test]
    fn legacy_market_project_copy_omits_verification_marker() {
        let root = test_root("legacy-market-marker");
        let source = root.join("downloaded");
        let target = root.join("created-project");
        write_fixture(&source.join(".texbutler-verified"), b"verified\n");
        write_fixture(&source.join("main.tex"), b"\\documentclass{article}\n");

        copy_tree(&source, &target).unwrap();
        let marker_exists = target.join(".texbutler-verified").exists();
        let main_exists = target.join("main.tex").exists();
        let _ = std::fs::remove_dir_all(&root);

        assert!(!marker_exists, "legacy market copy must not expose verification metadata");
        assert!(main_exists);
    }

    #[test]
    fn merge_never_writes_through_a_destination_replaced_during_copy() {
        let root = test_root("merge-destination-replacement");
        let staged = root.join("staged");
        let project_root = root.join("project");
        let container = project_root.join("container");
        let destination = container.join("destination");
        let parked = root.join("container-parked");
        let outside = root.join("outside");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        write_fixture(&staged.join("a-first.tex"), b"first\n");
        write_fixture(&staged.join("b-second.tex"), b"second\n");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(outside.join("destination")).unwrap();
        let project = Project::open(&project_root).unwrap();
        let trusted_destination = TrustedDirectory::open_validated(&project, &destination).unwrap();
        let swapped = match std::fs::rename(&container, &parked) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => false,
            Err(error) => panic!("could not park destination ancestor: {error}"),
        };
        if !swapped {
            drop(trusted_destination);
            let escaped = container.join("destination/b-second.tex").exists();
            let _ = std::fs::remove_dir_all(&root);
            assert!(
                !escaped,
                "a pinned destination must reject ancestor replacement"
            );
            return;
        }
        std::fs::rename(&outside, &container).unwrap();

        let result =
            merge_staged_tree_trusted(&project, &staged, &destination, trusted_destination);

        let escaped = container.join("destination/b-second.tex").exists();
        let parked_second = parked.join("destination/b-second.tex").exists();
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            !escaped,
            "destination replacement must never redirect a template write outside (result={result:?})"
        );
        assert!(result.is_err() || parked_second);
    }

    #[test]
    fn normalize_existing_directory_accepts_only_real_project_directories() {
        let root = test_root("normalize-existing-directory");
        let project_root = root.join("project");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        std::fs::create_dir_all(project_root.join("contents/nested")).unwrap();
        write_fixture(&project_root.join("ordinary-file"), b"file\n");
        let project = Project::open(&project_root).unwrap();

        assert_eq!(normalize_existing_project_dir(&project, "").unwrap(), "");
        assert_eq!(normalize_existing_project_dir(&project, ".").unwrap(), "");
        assert_eq!(
            normalize_existing_project_dir(&project, "contents/nested").unwrap(),
            "contents/nested"
        );
        let absolute = project_root.to_string_lossy().to_string();
        for rejected in [
            "missing",
            "ordinary-file",
            "../outside",
            "C:/outside",
            absolute.as_str(),
        ] {
            assert!(
                normalize_existing_project_dir(&project, rejected).is_err(),
                "directory must be rejected: {rejected}"
            );
        }

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_existing_directory_rejects_internal_and_external_symlinks() {
        let root = test_root("normalize-directory-symlinks");
        let project_root = root.join("project");
        let outside = root.join("outside");
        write_fixture(
            &project_root.join("main.tex"),
            b"\\documentclass{article}\n",
        );
        std::fs::create_dir_all(project_root.join("inside")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                project_root.join("inside"),
                project_root.join("inside-link"),
            )
            .unwrap();
            std::os::unix::fs::symlink(&outside, project_root.join("outside-link")).unwrap();
        }
        #[cfg(windows)]
        {
            if let Err(error) = std::os::windows::fs::symlink_dir(
                project_root.join("inside"),
                project_root.join("inside-link"),
            ) {
                if symlink_privilege_unavailable(&error) {
                    std::fs::remove_dir_all(root).unwrap();
                    return;
                }
                panic!("failed to create internal directory symlink: {error}");
            }
            std::os::windows::fs::symlink_dir(&outside, project_root.join("outside-link")).unwrap();
        }
        let project = Project::open(&project_root).unwrap();

        assert!(normalize_existing_project_dir(&project, "inside-link").is_err());
        assert!(normalize_existing_project_dir(&project, "outside-link").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
