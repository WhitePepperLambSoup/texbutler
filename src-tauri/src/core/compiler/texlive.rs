//! System TeX Live / MiKTeX fallback driver.
//!
//! Detects `xelatex` (preferred: best Chinese ctex support) then `lualatex`
//! on PATH. Compiles with:
//!   -interaction=nonstopmode -halt-on-error -file-line-error
//! and runs twice (cross-references / TOC); a third pass is optional.

use super::{CompileError, Compiler, CompileResult, EngineUsed};
use crate::core::project::Project;
use crate::core::{Issue, IssueKind, Severity};
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct SystemTexliveCompiler {
    /// Resolved engine binary path (None until detected).
    engine: Option<PathBuf>,
    /// Which engine was detected ("xelatex" or "lualatex").
    engine_name: &'static str,
    /// Number of passes (default 2; 3 for complex docs).
    passes: u32,
}

impl SystemTexliveCompiler {
    pub fn new() -> Self {
        SystemTexliveCompiler {
            engine: None,
            engine_name: "xelatex",
            passes: 2,
        }
    }

    pub fn with_passes(mut self, passes: u32) -> Self {
        self.passes = passes.max(1);
        self
    }

    fn detect() -> Option<(PathBuf, &'static str)> {
        for (name, label) in [("xelatex", "xelatex"), ("lualatex", "lualatex")] {
            let mut cmd = Command::new(name);
            crate::core::compiler::hide_console(&mut cmd);
            if let Ok(output) = cmd.arg("--version").output() {
                if output.status.success() {
                    return Some((PathBuf::from(name), label));
                }
            }
        }
        // Also try common Windows install paths (MiKTeX default).
        for cand in [
            r"C:\Program Files\MiKTeX\miktex\bin\x64\xelatex.exe",
            r"C:\Users\Public\MiKTeX\miktex\bin\x64\xelatex.exe",
        ] {
            let p = PathBuf::from(cand);
            if p.exists() {
                return Some((p, "xelatex"));
            }
        }
        None
    }
}

impl Compiler for SystemTexliveCompiler {
    fn name(&self) -> &str {
        "system-texlive"
    }

    fn available(&self) -> bool {
        self.engine.is_some() || Self::detect().is_some()
    }

    fn compile(
        &self,
        project: &Project,
        main: &Path,
        stop: &dyn Fn() -> bool,
    ) -> Result<CompileResult, CompileError> {
        // Resolve engine: use cached detection if present, else re-detect.
        let (engine, engine_name) = match &self.engine {
            Some(e) => (e.clone(), self.engine_name),
            None => Self::detect()
                .map(|(p, n)| (p, n))
                .ok_or_else(|| CompileError::Unavailable("未在 PATH 中找到 xelatex 或 lualatex".into()))?,
        };
        let main_path = project.root.join(main);

        if !main_path.exists() {
            return Err(CompileError::Project(format!("主文件不存在: {}", main_path.display())));
        }

        let build_dir = project.build_dir();
        std::fs::create_dir_all(&build_dir)?;

        // Run the engine with the build dir as cwd; TeX resolves `\input`
        // relative to the *main file's* dir, so pass an absolute path while
        // keeping `-output-directory` pointing at the build dir.
        // MiKTeX quirk: with `-output-directory` the engine resolves `\input`
        // relative to the OUTPUT dir, breaking multi-file projects. Instead we
        // run with cwd = build dir and add the project root + main file dir to
        // TEXINPUTS (platform path separator; empty trailing element keeps the
        // engine's default search paths). Any user-configured TEXINPUTS is
        // preserved (prepended paths win in TeX's search order).
        let main_dir = main_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        let user_texinputs = std::env::var("TEXINPUTS").unwrap_or_default();
        let texinputs = std::env::join_paths([project.root.clone(), main_dir])
            .map(|p| {
                let sep = if cfg!(windows) { ";" } else { ":" };
                format!("{}{sep}{user_texinputs}", p.to_string_lossy())
            })
            .unwrap_or_else(|_| user_texinputs);

        let mut last_status: Option<std::process::ExitStatus>;
        let mut all_logs: Vec<u8> = Vec::new();

        let mut passes = self.passes;
        // If the doc has no \input/\include/\bibliography, one pass suffices;
        // but two passes are cheap and fix TOC/cross-refs — keep default 2,
        // allow 3 when requested.
        let first_pass_ok = {
            let mut cmd = Command::new(&engine);
            crate::core::compiler::hide_console(&mut cmd);
            cmd.arg("-interaction=nonstopmode")
                .arg("-halt-on-error")
                .arg("-file-line-error")
                .env("TEXINPUTS", &texinputs)
                .arg(&main_path)
                .current_dir(&build_dir);
            let out = cmd.output()?;
            last_status = Some(out.status);
            all_logs.extend_from_slice(&out.stdout);
            all_logs.extend_from_slice(&out.stderr);
            out.status.success()
        };

        if !first_pass_ok {
            // halt-on-error: stop after first failure, don't loop.
            passes = 0;
        }

        for _ in 1..passes {
            if stop() {
                return Err(CompileError::Compile("编译已被用户取消".into()));
            }
            let mut cmd = Command::new(&engine);
            crate::core::compiler::hide_console(&mut cmd);
            cmd.arg("-interaction=nonstopmode")
                .arg("-halt-on-error")
                .arg("-file-line-error")
                .env("TEXINPUTS", &texinputs)
                .arg(&main_path)
                .current_dir(&build_dir);
            let out = cmd.output()?;
            last_status = Some(out.status);
            all_logs.extend_from_slice(&out.stdout);
            all_logs.extend_from_slice(&out.stderr);
            if !out.status.success() {
                break;
            }
        }

        let log_path = project.log_path();
        // xelatex writes main.log into -output-directory
        let main_stem = main_path.file_stem().unwrap_or_default().to_string_lossy();
        let produced_log = build_dir.join(format!("{main_stem}.log"));
        if produced_log.exists() {
            std::fs::copy(&produced_log, &log_path).ok();
        } else if !all_logs.is_empty() {
            std::fs::write(&log_path, &all_logs).ok();
        }

        let pdf = build_dir.join(format!("{main_stem}.pdf"));
        let ok = last_status.map(|s| s.success()).unwrap_or(false) && pdf.exists();
        let issues = if log_path.exists() {
            crate::core::log_parser::parse_log(&log_path)
        } else {
            vec![]
        };

        // Synthesize an issue when the engine failed but the log parser
        // produced nothing useful.
        let issues = if !ok && issues.is_empty() {
            vec![Issue::new(
                Severity::Error,
                IssueKind::CompileError,
                format!("{engine_name} 编译失败（退出码异常），但未能从日志中解析出具体错误。请检查控制台输出或 main.log。"),
            )]
        } else {
            issues
        };

        Ok(CompileResult {
            ok,
            pdf_path: if ok { Some(pdf) } else { None },
            log_path,
            issues,
            engine: EngineUsed::SystemTexlive,
            fell_back: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::project::Project;

    #[test]
    fn detect_returns_something_on_ci_with_tex() {
        // Not asserting presence — just make sure the function is callable
        // and never panics.
        let _ = SystemTexliveCompiler::detect();
    }

    /// Real end-to-end: compile the multi-file sample with the system engine.
    /// Ignored by default — requires xelatex/lualatex on PATH (run manually
    /// with `cargo test -- --ignored texlive`).
    #[test]
    #[ignore = "requires system TeX Live / MiKTeX on PATH"]
    fn compiles_multi_file_sample_project() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("sample-multi");
        let proj = Project::open(&root).expect("open sample-multi");
        let compiler = SystemTexliveCompiler::new().with_passes(1);
        let result = compiler
            .compile(&proj, Path::new("main.tex"), &|| false)
            .expect("compile should run");
        assert!(result.ok, "multi-file compile failed: {:?}", result.issues);
        assert!(result.pdf_path.as_ref().map(|p| p.exists()).unwrap_or(false));
        assert_eq!(result.engine, EngineUsed::SystemTexlive);
    }
}
