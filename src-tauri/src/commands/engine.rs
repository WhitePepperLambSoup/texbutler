//! Compile-engine onboarding (detect engines, install Tectonic for the
//! current user) and the in-app updater (download the release installer,
//! then launch it).

use crate::core::compiler::tectonic::TectonicCompiler;
use crate::core::compiler::texlive::SystemTexliveCompiler;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// Pinned Tectonic release (same as scripts/download-tectonic.ps1).
pub const TECTONIC_VERSION: &str = "0.15.0";
const TECTONIC_URL: &str = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-pc-windows-msvc.zip";
const TECTONIC_SHA256: &str = "1d6bb76f049c8a3774f6e9d66e4b04e1a8c3dcb37527b6b41b7e894328e7bf29";
/// Only installers published by this repository may be downloaded.
const RELEASE_PREFIX: &str = "https://github.com/WhitePepperLambSoup/texbutler/releases/download/";

#[derive(serde::Serialize)]
pub struct EngineStatus {
    /// Path of the tectonic binary that would be used, if any.
    pub tectonic: Option<String>,
    /// The per-user install location (where "安装 Tectonic" puts it).
    pub tectonic_user_path: Option<String>,
    /// Detected system engine (xelatex/lualatex) and its path.
    pub system_engine: Option<String>,
    pub system_path: Option<String>,
    pub can_compile: bool,
}

#[tauri::command]
pub async fn tb_engine_status() -> Result<EngineStatus, String> {
    tokio::task::spawn_blocking(|| {
        let tectonic = TectonicCompiler::find_binary().map(|p| p.to_string_lossy().to_string());
        let system = SystemTexliveCompiler::detect();
        EngineStatus {
            can_compile: tectonic.is_some() || system.is_some(),
            tectonic,
            tectonic_user_path: TectonicCompiler::user_install_path().map(|p| p.to_string_lossy().to_string()),
            system_engine: system.as_ref().map(|(_, label)| label.to_string()),
            system_path: system.map(|(p, _)| p.to_string_lossy().to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Stream `url` to `dest`, emitting `{ stage, downloaded, total }` on
/// `event`. Returns the SHA-256 of the downloaded bytes.
async fn download(app: &AppHandle, url: &str, dest: &Path, event: &str, stage: &str) -> Result<(String, u64), String> {
    let resp = reqwest::Client::new()
        .get(url)
        .header("User-Agent", "texbutler")
        .timeout(std::time::Duration::from_secs(1800))
        .send()
        .await
        .map_err(|e| format!("下载失败（网络）: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = 0u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if downloaded - last_emit > 256 * 1024 || downloaded == total {
            last_emit = downloaded;
            let _ = app.emit(event, serde_json::json!({ "stage": stage, "downloaded": downloaded, "total": total }));
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if total > 0 && downloaded != total {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("下载不完整: {downloaded}/{total} 字节"));
    }
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok((hex(&hasher.finalize()), downloaded))
}

/// Download the pinned Tectonic release, verify its SHA-256 and install
/// `tectonic.exe` into the per-user folder. Returns the installed path.
#[tauri::command]
pub async fn tb_install_tectonic(app: AppHandle) -> Result<String, String> {
    let target = TectonicCompiler::user_install_path().ok_or("找不到用户数据目录")?;
    let dir = target.parent().ok_or("路径无效")?.to_path_buf();
    let zip_path = std::env::temp_dir().join("texbutler-tectonic").join(format!("tectonic-{TECTONIC_VERSION}.zip"));
    let (sha, _) = download(&app, TECTONIC_URL, &zip_path, "tb://install-progress", "download").await?;
    if sha != TECTONIC_SHA256 {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!("校验失败：下载文件的 SHA-256 不匹配（{sha}），已拒绝安装"));
    }
    let _ = app.emit("tb://install-progress", serde_json::json!({ "stage": "extract", "downloaded": 0, "total": 0 }));
    let installed = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("压缩包无效: {e}"))?;
        let mut entry = archive.by_name("tectonic.exe").map_err(|_| "压缩包中没有 tectonic.exe".to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let tmp = dir.join("tectonic.exe.part");
        let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        drop(out);
        let target = dir.join("tectonic.exe");
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&zip_path);
        Ok(target)
    })
    .await
    .map_err(|e| e.to_string())??;
    // smoke test: the binary must run
    let mut cmd = std::process::Command::new(&installed);
    crate::core::compiler::hide_console(&mut cmd);
    let ok = cmd.arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    if !ok {
        return Err("Tectonic 已下载，但无法运行（可能被安全软件拦截）".into());
    }
    let _ = app.emit("tb://install-progress", serde_json::json!({ "stage": "done", "downloaded": 0, "total": 0 }));
    Ok(installed.to_string_lossy().to_string())
}

/// Validate an installer URL from the release API.
pub fn valid_installer_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    url.starts_with(RELEASE_PREFIX)
        && !url[RELEASE_PREFIX.len()..].contains("..")
        && (lower.ends_with("-setup.exe") || lower.ends_with(".msi"))
}

fn update_dir() -> PathBuf {
    std::env::temp_dir().join("texbutler-update")
}

/// Download a release installer (progress on `tb://update-progress`).
#[tauri::command]
pub async fn tb_download_update(app: AppHandle, url: String, size: Option<u64>) -> Result<String, String> {
    if !valid_installer_url(&url) {
        return Err("只允许下载 TeXButler 官方发布的安装包".into());
    }
    let name = url.rsplit('/').next().unwrap_or("TeXButler-setup.exe").to_string();
    let dest = update_dir().join(&name);
    let (_, bytes) = download(&app, &url, &dest, "tb://update-progress", "download").await?;
    if let Some(expected) = size {
        if expected > 0 && expected != bytes {
            let _ = std::fs::remove_file(&dest);
            return Err(format!("安装包大小不符：{bytes}/{expected}"));
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

/// Launch a downloaded installer and quit so it can replace the app.
#[tauri::command]
pub fn tb_install_update(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    let dir = update_dir();
    let canon = std::fs::canonicalize(&path).map_err(|_| "安装包不存在".to_string())?;
    let dir_canon = std::fs::canonicalize(&dir).map_err(|_| "安装包不存在".to_string())?;
    let name = canon.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
    if !canon.starts_with(&dir_canon) || !(name.ends_with("-setup.exe") || name.ends_with(".msi")) {
        return Err("只能运行由更新程序下载的安装包".into());
    }
    let mut cmd = if name.ends_with(".msi") {
        let mut c = std::process::Command::new("msiexec");
        c.arg("/i").arg(&canon);
        c
    } else {
        std::process::Command::new(&canon)
    };
    cmd.spawn().map_err(|e| format!("无法启动安装程序: {e}"))?;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        handle.exit(0);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_official_installers_are_accepted() {
        assert!(valid_installer_url(
            "https://github.com/WhitePepperLambSoup/texbutler/releases/download/v0.8.0/TeXButler_0.8.0_x64-setup.exe"
        ));
        assert!(valid_installer_url(
            "https://github.com/WhitePepperLambSoup/texbutler/releases/download/v0.8.0/TeXButler_0.8.0_x64_en-US.msi"
        ));
        for bad in [
            "https://github.com/evil/texbutler/releases/download/v1/TeXButler-setup.exe",
            "https://github.com/WhitePepperLambSoup/texbutler/releases/download/v1/../../x/TeXButler-setup.exe",
            "https://github.com/WhitePepperLambSoup/texbutler/releases/download/v1/readme.txt",
            "http://github.com/WhitePepperLambSoup/texbutler/releases/download/v1/TeXButler-setup.exe",
        ] {
            assert!(!valid_installer_url(bad), "{bad}");
        }
    }
}
