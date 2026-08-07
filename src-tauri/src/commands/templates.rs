//! LaTeX template marketplace: a curated list of real university thesis
//! templates (GitHub-verified). Small templates ship inside the app bundle
//! (embedded at compile time via include_dir, preserving directory trees);
//! large ones are downloaded on demand from codeload.github.com into the
//! user data directory.
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Embedded template tree (`assets/templates/` at compile time).
static TEMPLATES: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../assets/templates");

const MAX_DOWNLOAD_BYTES: u64 = 500 * 1024 * 1024; // 500 MB safety cap

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
            MarketTemplateView { t, ready }
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
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("压缩包读取失败: {e}"))?;
        let name = entry.name().to_string();
        let rel = match name.split_once('/') {
            Some((_, rest)) if !rest.is_empty() => rest,
            _ => continue, // the root dir itself
        };
        // traversal defense: reject any ../ or absolute component
        if rel.split(['/', '\\']).any(|c| c == "..") || Path::new(&rel).is_absolute() {
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
            std::fs::write(&out, buf).map_err(|e| format!("解压写入失败: {e}"))?;
        }
    }
    Ok(target.to_string_lossy().to_string())
}

/// GitHub API default-branch lookup (public repos, unauthenticated is fine).
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
