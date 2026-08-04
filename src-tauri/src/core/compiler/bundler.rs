//! Bundle localisation: making the tectonic resource bundle available
//! offline so the app can compile without network access.
//!
//! Strategy (binary-driver model):
//! * tectonic manages its own download cache at
//!   `%LOCALAPPDATA%\TectonicProject\Tectonic\{files,formats,...}` (Windows,
//!   tectonic 0.15 layout — note there is NO `bundles` subdirectory). Files
//!   are downloaded on demand on first compile.
//! * "预下载 bundle" (`download_bundle`) compiles a tiny warm-up document
//!   once, pulling the format + core macro files (incl. ctex/fandol fonts
//!   for Chinese) into the cache. After that, `-C --only-cached` compiles
//!   fully offline.
//! * Distributions may ship a pre-warmed cache (or a flat bundle directory
//!   / zip) and point to it via `TEXBUTLER_BUNDLE_DIR` / `TEXBUTLER_BUNDLE_ZIP`;
//!   the tectonic driver picks those up automatically.

use std::path::PathBuf;

/// tectonic's own bundle cache root on this machine.
/// NOTE: tectonic 0.15 layout is `TectonicProject\Tectonic\{files,formats,...}`
/// — there is NO `bundles` subdirectory in this version.
pub fn tectonic_cache_root() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("TectonicProject")
        .join("Tectonic")
}

/// Our own offline bundle dir (flat file layout for `--bundle <dir>`).
pub fn bundle_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("texbutler")
        .join("bundle")
}

/// True when a usable cache already exists (warm or pre-shipped).
pub fn bundle_available() -> bool {
    let root = tectonic_cache_root();
    if root.join("files").is_dir() {
        if let Ok(rd) = std::fs::read_dir(root.join("files")) {
            if rd.count() > 0 {
                return true;
            }
        }
    }
    // our own flat bundle dir (populated from a shipped archive)
    bundle_dir().is_dir()
}

/// Download the tectonic bundle into the cache by compiling a tiny warm-up
/// document (blocking; call from a worker thread).
pub fn download_bundle() -> Result<u64, String> {
    let binary = crate::core::compiler::tectonic::TectonicCompiler::find_binary()
        .ok_or_else(|| "找不到 tectonic 二进制".to_string())?;
    let work = std::env::temp_dir().join("texbutler-bundle-warmup");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let tex = work.join("warmup.tex");
    std::fs::write(
        &tex,
        "\\documentclass[UTF8]{ctexart}\n\\usepackage{graphicx}\n\\usepackage{float}\n\\usepackage{xcolor}\n\\begin{document}\n预热 bundle …\n\\end{document}\n",
    )
    .map_err(|e| e.to_string())?;

    let before = cache_bytes();
    let mut cmd = std::process::Command::new(&binary);
    crate::core::compiler::hide_console(&mut cmd);
    let out = cmd
        .arg("--outdir")
        .arg(&work)
        .arg("--color")
        .arg("never")
        .arg("--chatter")
        .arg("minimal")
        .arg(&tex)
        .current_dir(&work)
        .output()
        .map_err(|e| format!("预热编译启动失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "预热编译失败（退出码 {}）: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let after = cache_bytes();
    Ok(after.saturating_sub(before))
}

fn cache_bytes() -> u64 {
    let root = tectonic_cache_root();
    let mut total = 0u64;
    fn walk(dir: &std::path::Path, total: &mut u64) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, total);
                } else if let Ok(m) = e.metadata() {
                    *total += m.len();
                }
            }
        }
    }
    walk(&root, &mut total);
    total
}

/// Total size of the current cache (for the settings UI).
pub fn cache_size_bytes() -> u64 {
    cache_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_root_is_under_local_app_data() {
        let p = tectonic_cache_root();
        assert!(p.to_string_lossy().contains("Tectonic"));
    }

    #[test]
    fn bundle_dir_has_texbutler() {
        assert!(bundle_dir().to_string_lossy().contains("texbutler"));
    }
}
