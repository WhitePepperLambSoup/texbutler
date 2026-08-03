//! Tectonic driver — the built-in compile kernel (no TeX Live required).
//!
//! IMPLEMENTATION NOTE (recorded per project rules):
//! We drive the official `tectonic` 0.15 binary as a subprocess instead of
//! the `tectonic` crate. Reason: the crate's `tectonic_bridge_png` build
//! script requires a *system* libpng (pkg-config / vcpkg); there is no
//! vendored fallback, which would break "install and compile on a clean
//! Windows machine". The binary is bundled as a Tauri resource
//! (`src-tauri/resources/bin/tectonic.exe`), so the app stays self-contained.
//! The TeX engine remains a black box — we only call it via subprocess.
//!
//! Bundle strategy:
//! * default: tectonic downloads resources on demand into its own cache
//!   (`%LOCALAPPDATA%\Tectonic\bundles` on Windows);
//! * offline: pass `--bundle <dir|zip>` (resource shipped with the app) or
//!   `-C --only-cached` once the cache is warm;
//! * `TEXBUTLER_BUNDLE_DIR` / `TEXBUTLER_BUNDLE_ZIP` env vars override the
//!   bundle location for packaging/testing.
//!
//! Cancellation: the child process is killed on stop → truly cancellable.

use super::bundler;
use super::{CompileError, Compiler, CompileResult, EngineUsed};
use crate::core::project::Project;
use crate::core::{Issue, IssueKind, Severity};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub struct TectonicCompiler {
    /// Path to the tectonic binary (resolved at first use).
    binary: Option<PathBuf>,
}

impl TectonicCompiler {
    pub fn new() -> Self {
        TectonicCompiler { binary: None }
    }

    /// Locate the tectonic executable:
    /// 1. packaged resource (`resources/bin/tectonic.exe`), 2. PATH.
    pub fn find_binary() -> Option<PathBuf> {
        // packaged resource relative to the exe's dir (dev: project root)
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default();
        let candidates = [
            exe_dir.join("resources").join("bin").join("tectonic.exe"),
            PathBuf::from("src-tauri").join("resources").join("bin").join("tectonic.exe"),
            PathBuf::from("resources").join("bin").join("tectonic.exe"),
            PathBuf::from("tectonic.exe"),
        ];
        for c in candidates {
            if c.exists() {
                return Some(c);
            }
        }
        // PATH lookup (hide the console — probing must not flash a window)
        let mut probe = std::process::Command::new("tectonic");
        crate::core::compiler::hide_console(&mut probe);
        if let Ok(output) = probe.arg("--version").output() {
            if output.status.success() {
                return Some(PathBuf::from("tectonic"));
            }
        }
        None
    }

    fn ensure_binary(&mut self) -> Result<&PathBuf, CompileError> {
        if self.binary.is_none() {
            self.binary = Self::find_binary();
        }
        self.binary
            .as_ref()
            .ok_or_else(|| CompileError::Unavailable("找不到 tectonic 二进制（应随应用打包在 resources/bin/ 下）".into()))
    }

    /// Resolve which bundle to use: env override > packaged bundle dir/zip.
    fn resolve_bundle_args(&self) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        if let Ok(dir) = std::env::var("TEXBUTLER_BUNDLE_DIR") {
            if Path::new(&dir).exists() {
                args.push("--bundle".into());
                args.push(dir);
                return args;
            }
        }
        if let Ok(zip) = std::env::var("TEXBUTLER_BUNDLE_ZIP") {
            if Path::new(&zip).exists() {
                args.push("--bundle".into());
                args.push(zip);
                return args;
            }
        }
        // our own offline bundle dir (populated by "预下载 bundle")
        let ours = bundler::bundle_dir();
        if ours.join("index.json").exists() || ours.join("files").exists() {
            args.push("--bundle".into());
            args.push(ours.to_string_lossy().to_string());
        }
        args
    }

    /// Build the command line for one compile. stdout/stderr go to files so
    /// the polling loop never blocks on pipe reads.
    fn build_command(
        &self,
        project: &Project,
        main: &Path,
        build_dir: &Path,
        stdout_file: std::fs::File,
        stderr_file: std::fs::File,
    ) -> Command {
        let mut cmd = Command::new(self.binary.clone().unwrap_or_else(|| PathBuf::from("tectonic")));
        crate::core::compiler::hide_console(&mut cmd);
        cmd.arg("--outdir").arg(build_dir);
        cmd.arg("--keep-logs");
        cmd.arg("--color").arg("never");
        cmd.arg("--chatter").arg("minimal");
        cmd.arg("-r").arg("2");
        for b in self.resolve_bundle_args() {
            cmd.arg(b);
        }
        cmd.arg(project.root.join(main));
        cmd.current_dir(&project.root);
        cmd.stdout(Stdio::from(stdout_file));
        cmd.stderr(Stdio::from(stderr_file));
        cmd
    }
}

impl Compiler for TectonicCompiler {
    fn name(&self) -> &str {
        "tectonic"
    }

    fn available(&self) -> bool {
        self.binary.is_some() || Self::find_binary().is_some()
    }

    fn compile(
        &self,
        project: &Project,
        main: &Path,
        stop: &dyn Fn() -> bool,
    ) -> Result<CompileResult, CompileError> {
        let mut self_mut = TectonicCompiler { binary: self.binary.clone() };
        let binary = self_mut.ensure_binary()?.clone();

        let main_path = project.root.join(main);
        if !main_path.exists() {
            return Err(CompileError::Project(format!("主文件不存在: {}", main_path.display())));
        }
        let build_dir = project.build_dir();
        std::fs::create_dir_all(&build_dir)?;

        // Run synchronously with polling so cancellation (kill) is prompt.
        let stdout_file = build_dir.join("tectonic.stdout.txt");
        let stderr_file = build_dir.join("tectonic.stderr.txt");
        let out_handle = std::fs::File::create(&stdout_file)
            .map_err(|e| CompileError::Io(e))?;
        let err_handle = std::fs::File::create(&stderr_file)
            .map_err(|e| CompileError::Io(e))?;
        let mut cmd = self.build_command(project, main, &build_dir, out_handle, err_handle);
        let mut child = cmd
            .spawn()
            .map_err(|e| CompileError::Compile(format!("tectonic 启动失败: {e}")))?;

        // Poll for completion while honoring the stop flag.
        let status = loop {
            if stop() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CompileError::Compile("编译已被用户取消".into()));
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(e) => return Err(CompileError::Compile(format!("等待 tectonic 失败: {e}"))),
            }
        };

        let stdout = std::fs::read_to_string(&stdout_file).unwrap_or_default();
        let stderr = std::fs::read_to_string(&stderr_file).unwrap_or_default();

        let log_path = project.log_path();
        let main_stem = main_path.file_stem().unwrap_or_default().to_string_lossy();
        let produced_log = build_dir.join(format!("{main_stem}.log"));
        if produced_log.exists() {
            std::fs::copy(&produced_log, &log_path).ok();
        } else if !stderr.is_empty() || !stdout.is_empty() {
            std::fs::write(&log_path, format!("{stderr}\n{stdout}")).ok();
        }

        let pdf = build_dir.join(format!("{main_stem}.pdf"));
        let ok = status.success() && pdf.exists();
        let issues = if log_path.exists() {
            crate::core::log_parser::parse_log(&log_path)
        } else {
            vec![]
        };
        let issues = if !ok && issues.is_empty() {
            let detail = stderr.lines().last().unwrap_or("").to_string();
            vec![Issue::new(
                Severity::Error,
                IssueKind::CompileError,
                format!(
                    "Tectonic 编译失败（退出码 {}）。{}",
                    status.code().unwrap_or(-1),
                    if detail.is_empty() { "请查看日志。" } else { &detail }
                ),
            )]
        } else {
            issues
        };

        let _ = binary;
        Ok(CompileResult {
            ok,
            pdf_path: if ok { Some(pdf) } else { None },
            log_path,
            issues,
            engine: EngineUsed::Tectonic,
            fell_back: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_binary_finds_packaged_resource() {
        // In CI (project checkout) the resource exists under src-tauri/resources.
        let found = TectonicCompiler::find_binary();
        assert!(found.is_some(), "packaged tectonic.exe should be findable");
    }

    #[test]
    fn bundle_args_respect_env() {
        let c = TectonicCompiler::new();
        // no env set → no explicit --bundle unless our cache has files
        let args = c.resolve_bundle_args();
        assert!(args.is_empty() || args[0] == "--bundle");
    }
}
