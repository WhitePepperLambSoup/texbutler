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

use std::path::{Path, PathBuf};

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

/// Locate a bundled `bundle.zip` shipped next to the executable
/// (`resources/bundle/bundle.zip` — or the tauri resource target dir).
/// NOTE: the `TEXBUTLER_BUNDLE_ZIP` env var is handled by the tectonic
/// driver directly (`--bundle zip`) and must NOT be unpacked here.
pub fn find_bundled_zip() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default();
    let candidates = [
        exe_dir.join("resources").join("bundle").join("bundle.zip"),
        exe_dir.join("bundle").join("bundle.zip"),
        PathBuf::from("src-tauri").join("resources").join("bundle").join("bundle.zip"),
        PathBuf::from("resources").join("bundle").join("bundle.zip"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Whether the tectonic cache is already warm (has downloaded files).
fn cache_warm() -> bool {
    let files = tectonic_cache_root().join("files");
    if files.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&files) {
            if rd.count() > 0 {
                return true;
            }
        }
    }
    false
}

/// Unpack a bundled `bundle.zip` into the tectonic cache so compiling works
/// fully offline for every user, not just the machine that pre-downloaded.
/// Called lazily before the first compile; no-op when the cache is warm or
/// no bundled zip is present. Returns how many files were unpacked.
pub fn ensure_unpacked_bundle() -> Result<u64, String> {
    if cache_warm() {
        return Ok(0);
    }
    let Some(zip_path) = find_bundled_zip() else {
        return Ok(0);
    };
    unpack_zip(&zip_path, &tectonic_cache_root())
}

/// Extract every file of a zip into `target` (zip-slip protected).
pub fn unpack_zip(zip_path: &Path, target: &Path) -> Result<u64, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("bundle.zip 读取失败: {e}"))?;
    let mut unpacked = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        // zip-slip defence: reject any component that could escape `target` —
        // `..`, absolute paths (`/x`, `\x`), Windows drive prefixes (`C:/x`)
        let p = Path::new(&name);
        let unsafe_component = p.components().any(|c| match c {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => true,
            _ => false,
        });
        if unsafe_component {
            return Err(format!("bundle.zip 包含非法路径: {name}"));
        }
        let out_path = target.join(&name);
        // belt & braces: the resolved path must stay inside the target
        if !out_path.starts_with(target) {
            return Err(format!("bundle.zip 包含越界路径: {name}"));
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        unpacked += 1;
    }
    Ok(unpacked)
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

    #[test]
    fn unpack_zip_extracts_files_and_rejects_traversal() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("tb-unpack-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // build a small zip with a normal file and a traversal entry
        let zip_path = tmp.join("test.zip");
        let mut zw = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        zw.start_file("files/ab/hello.txt", zip::write::SimpleFileOptions::default()).unwrap();
        zw.write_all(b"hello").unwrap();
        zw.start_file("../evil.txt", zip::write::SimpleFileOptions::default()).unwrap();
        zw.write_all(b"evil").unwrap();
        zw.finish().unwrap();

        let target = tmp.join("out");
        // traversal entry must abort the whole unpack
        let err = unpack_zip(&zip_path, &target).unwrap_err();
        assert!(err.contains("evil"), "应拒绝路径遍历: {err}");
        assert!(!target.join("evil.txt").exists());

        // drive-prefix and rooted entries must also be rejected
        for evil in ["C:/evil.txt", "/rooted.txt"] {
            let zip3 = tmp.join(format!("evil-{}.zip", evil.replace(['/', ':'], "_")));
            let mut zw3 = zip::ZipWriter::new(std::fs::File::create(&zip3).unwrap());
            zw3.start_file(evil, zip::write::SimpleFileOptions::default()).unwrap();
            zw3.write_all(b"evil").unwrap();
            zw3.finish().unwrap();
            let err = unpack_zip(&zip3, &target).unwrap_err();
            assert!(err.contains("非法") || err.contains("越界"), "{evil} 应被拒绝: {err}");
        }

        // clean zip unpacks fine
        let zip2 = tmp.join("test2.zip");
        let mut zw2 = zip::ZipWriter::new(std::fs::File::create(&zip2).unwrap());
        zw2.start_file("files/ab/hello.txt", zip::write::SimpleFileOptions::default()).unwrap();
        zw2.write_all(b"hello").unwrap();
        zw2.finish().unwrap();
        let n = unpack_zip(&zip2, &target).unwrap();
        assert_eq!(n, 1);
        assert_eq!(std::fs::read_to_string(target.join("files/ab/hello.txt")).unwrap(), "hello");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
