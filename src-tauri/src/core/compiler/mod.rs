//! Compiler abstraction, scheduler and shared compile types.

pub mod bundler;
pub mod tectonic;
pub mod texlive;

use crate::core::project::Project;
use crate::core::settings::EnginePreference;
use crate::core::{Issue, round_f64};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Which engine actually produced the PDF.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineUsed {
    Tectonic,
    SystemTexlive,
}

impl EngineUsed {
    pub fn label(&self) -> &'static str {
        match self {
            EngineUsed::Tectonic => "Tectonic (内置内核)",
            EngineUsed::SystemTexlive => "系统 TeX Live / MiKTeX",
        }
    }
}

/// Result of one compile run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileResult {
    pub ok: bool,
    pub pdf_path: Option<PathBuf>,
    pub log_path: PathBuf,
    /// Structured issues parsed from the .log.
    pub issues: Vec<Issue>,
    pub engine: EngineUsed,
    /// True when the scheduler fell back from tectonic to system texlive.
    pub fell_back: bool,
}

impl CompileResult {
    pub fn failed(log_path: PathBuf, engine: EngineUsed, message: &str) -> Self {
        CompileResult {
            ok: false,
            pdf_path: None,
            log_path,
            issues: vec![Issue::new(
                crate::core::Severity::Error,
                crate::core::IssueKind::CompileError,
                message,
            )],
            engine,
            fell_back: false,
        }
    }
}

/// Errors that prevent compilation from even starting.
#[derive(Debug, thiserror::Error)]
pub enum CompileError {
    #[error("编译器不可用: {0}")]
    Unavailable(String),
    #[error("项目配置错误: {0}")]
    Project(String),
    #[error("编译失败: {0}")]
    Compile(String),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
}

/// Abstract compiler driver.
pub trait Compiler: Send + Sync {
    fn name(&self) -> &str;
    /// Environment detection (bundle present / texlive on PATH).
    fn available(&self) -> bool;
    /// Run one compile of `project.main_file` (relative path) and return
    /// the result. Must be cancellation-friendly (checks a stop flag).
    fn compile(
        &self,
        project: &Project,
        main: &Path,
        stop: &dyn Fn() -> bool,
    ) -> Result<CompileResult, CompileError>;
}

/// Scheduler: tectonic by default; falls back to system texlive when
/// tectonic is unavailable or when its compile fails with a suspected
/// package-compatibility problem. The actual engine is recorded in
/// `CompileResult.engine` so the UI can show it.
pub struct CompilerScheduler {
    pub tectonic: tectonic::TectonicCompiler,
    pub texlive: texlive::SystemTexliveCompiler,
    pub preference: EnginePreference,
}

impl CompilerScheduler {
    pub fn new(preference: EnginePreference) -> Self {
        Self::new_with_passes(preference, 2)
    }

    /// `texlive_passes`: number of engine passes for the system driver.
    pub fn new_with_passes(preference: EnginePreference, texlive_passes: u32) -> Self {
        CompilerScheduler {
            tectonic: tectonic::TectonicCompiler::new(),
            texlive: texlive::SystemTexliveCompiler::new().with_passes(texlive_passes),
            preference,
        }
    }

    /// Main entry: compile the project's main file.
    pub fn compile(
        &self,
        project: &Project,
        main: &Path,
        stop: &dyn Fn() -> bool,
    ) -> CompileResult {
        let use_tectonic = match self.preference {
            EnginePreference::Tectonic => true,
            EnginePreference::SystemTexlive => false,
            EnginePreference::Auto => self.tectonic.available(),
        };

        if use_tectonic && self.tectonic.available() {
            match self.tectonic.compile(project, main, stop) {
                Ok(res) if res.ok => return res,
                Ok(res) => {
                    // tectonic ran but failed — fall back if system texlive
                    // exists; merge issues so the user sees everything.
                    if self.texlive.available() {
                        let mut fb = self
                            .texlive
                            .compile(project, main, stop)
                            .unwrap_or_else(|e| CompileResult::failed(project.log_path(), EngineUsed::SystemTexlive, &e.to_string()));
                        // keep tectonic issues too (they may be more precise)
                        let mut all = res.issues;
                        all.extend(fb.issues);
                        fb.issues = all;
                        fb.fell_back = true;
                        return fb;
                    }
                    let mut res = res;
                    res.fell_back = false;
                    // informational note goes LAST so real errors stay first
                    res.issues.push(Issue::new(
                        crate::core::Severity::Info,
                        crate::core::IssueKind::CompileError,
                        "Tectonic 编译失败且未检测到系统 texlive 可兜底。以下为 tectonic 的错误。",
                    ));
                    res
                }
                Err(e) => {
                    // tectonic errored out (e.g. bundle download failed) —
                    // degrade to system texlive when available.
                    if self.texlive.available() {
                        let mut fb = self.texlive.compile(project, main, stop).unwrap_or_else(|e2| {
                            CompileResult::failed(project.log_path(), EngineUsed::SystemTexlive, &e2.to_string())
                        });
                        fb.fell_back = true;
                        // informational note goes LAST so real errors stay first
                        fb.issues.push(Issue::new(
                            crate::core::Severity::Info,
                            crate::core::IssueKind::CompileError,
                            format!("Tectonic 不可用（{}），已自动切换到系统 TeX Live / MiKTeX。", e),
                        ));
                        fb
                    } else {
                        CompileResult::failed(
                            project.log_path(),
                            EngineUsed::Tectonic,
                            &format!("Tectonic 编译失败: {e}"),
                        )
                    }
                }
            }
        } else if self.texlive.available() {
            match self.texlive.compile(project, main, stop) {
                Ok(res) => res,
                Err(e) => CompileResult::failed(project.log_path(), EngineUsed::SystemTexlive, &e.to_string()),
            }
        } else {
            CompileResult::failed(
                project.log_path(),
                EngineUsed::Tectonic,
                "没有可用的编译内核：Tectonic bundle 未就绪，且系统 PATH 中找不到 xelatex/lualatex。请安装 TeX Live/MiKTeX，或在设置中下载 Tectonic bundle。",
            )
        }
    }
}

/// Round-trip helper shared by drivers: format a duration without garbage.
pub fn format_secs(secs: f64) -> String {
    format!("{:.1}s", round_f64(secs, 1))
}

/// Hide the console window of child processes on Windows
/// (`CREATE_NO_WINDOW`), so compiling does not flash a black shell box.
/// No-op on other platforms.
#[cfg(windows)]
pub(crate) fn hide_console(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Hide the console window of child processes (no-op outside Windows).
#[cfg(not(windows))]
pub(crate) fn hide_console(_cmd: &mut std::process::Command) {}
