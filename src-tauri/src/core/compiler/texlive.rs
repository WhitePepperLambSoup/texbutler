//! System TeX Live / MiKTeX fallback driver.
//!
//! Detects `xelatex` (preferred: best Chinese ctex support) then `lualatex`
//! on PATH. Compiles with:
//!   -interaction=nonstopmode -halt-on-error -file-line-error
//! and runs twice (cross-references / TOC); a third pass is optional.

use super::{CompileError, CompileResult, Compiler, EngineUsed};
use crate::core::project::Project;
use crate::core::{Issue, IssueKind, Severity};
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) const NO_ENGINE_OUTPUT_MARKER: &str = "texbutler:no-engine-output";

fn tail(text: &str, max_chars: usize) -> &str {
    if text.chars().count() <= max_chars {
        return text;
    }
    let start = text
        .char_indices()
        .rev()
        .nth(max_chars.saturating_sub(1))
        .map(|(idx, _)| idx)
        .unwrap_or(0);
    &text[start..]
}

fn is_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    Path::new(path).is_absolute()
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'/' || bytes[2] == b'\\'))
}

fn parsed_failure_issues(log_text: &str, console_text: &str) -> Vec<Issue> {
    let mut issues = crate::core::log_parser::parse_log_str(log_text);
    let console_issues = crate::core::log_parser::parse_log_str(console_text);
    if issues.is_empty() {
        issues = console_issues;
    } else if !issues.iter().any(|issue| issue.severity == Severity::Error) {
        issues.extend(
            console_issues
                .into_iter()
                .filter(|issue| issue.severity == Severity::Error),
        );
    }
    for issue in &mut issues {
        if issue.line == Some(0) {
            issue.line = None;
        }
    }
    issues
}

/// Build a useful failure issue from the persisted log and the engine's
/// console output. The helper is pure so it can be tested without TeX Live.
pub(crate) fn synthesize_failure_issues(
    main: &Path,
    engine_name: &str,
    exit_code: Option<i32>,
    log_text: &str,
    console_text: &str,
) -> Vec<Issue> {
    let mut issues = parsed_failure_issues(log_text, console_text);
    let main_rel = main.to_string_lossy().replace('\\', "/");
    for issue in &mut issues {
        if let Some(file) = issue.file.as_deref() {
            let file = file.replace('\\', "/");
            if is_absolute_path(&file) && file.ends_with(&format!("/{main_rel}")) {
                issue.file = Some(main_rel.clone());
            }
        }
    }
    if !issues.is_empty() {
        return issues;
    }

    let raw = if console_text.trim().is_empty() {
        format!("{NO_ENGINE_OUTPUT_MARKER}\nengine={engine_name} exit_code={exit_code:?}")
    } else {
        format!(
            "engine={engine_name} exit_code={exit_code:?}\n{}",
            tail(console_text, 12_000)
        )
    };
    vec![Issue::new(
        Severity::Error,
        IssueKind::CompileError,
        format!("{engine_name} 编译失败（退出码异常），但未能从日志中解析出具体错误。请检查控制台输出或 main.log。"),
    )
    .with_file(main_rel)
    .with_raw(raw)]
}

fn synthesize_failure_issues_for_project(
    project: &Project,
    main: &Path,
    engine_name: &str,
    exit_code: Option<i32>,
    log_text: &str,
    console_text: &str,
) -> Vec<Issue> {
    let main_rel = main.to_string_lossy().replace('\\', "/");
    let mut issues = parsed_failure_issues(log_text, console_text);
    if issues.is_empty() {
        return synthesize_failure_issues(main, engine_name, exit_code, log_text, console_text);
    }
    for issue in &mut issues {
        let Some(file) = issue.file.as_deref() else {
            continue;
        };
        let Some(resolved) = project.resolve(file) else {
            issue.file = Some(main_rel.clone());
            continue;
        };
        let Some(relative) = resolved.strip_prefix(&project.root).ok() else {
            issue.file = Some(main_rel.clone());
            continue;
        };
        issue.file = Some(relative.to_string_lossy().replace('\\', "/"));
    }
    issues
}

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
            None => Self::detect().map(|(p, n)| (p, n)).ok_or_else(|| {
                CompileError::Unavailable("未在 PATH 中找到 xelatex 或 lualatex".into())
            })?,
        };
        let main_path = project.root.join(main);

        if !main_path.exists() {
            return Err(CompileError::Project(format!(
                "主文件不存在: {}",
                main_path.display()
            )));
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

        let main_stem = main_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let produced_log = build_dir.join(format!("{main_stem}.log"));
        let log_path = project.log_path();
        let _ = std::fs::remove_file(&produced_log);
        if log_path != produced_log {
            let _ = std::fs::remove_file(&log_path);
        }
        let mut last_status: Option<std::process::ExitStatus>;
        let mut console_text = String::new();

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
                .arg("-synctex=1")
                .env("TEXINPUTS", &texinputs)
                .arg(&main_path)
                .current_dir(&build_dir);
            let out = cmd.output()?;
            last_status = Some(out.status);
            console_text.push_str(&String::from_utf8_lossy(&out.stdout));
            console_text.push_str(&String::from_utf8_lossy(&out.stderr));
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
                .arg("-synctex=1")
                .env("TEXINPUTS", &texinputs)
                .arg(&main_path)
                .current_dir(&build_dir);
            let out = cmd.output()?;
            last_status = Some(out.status);
            console_text.push_str(&String::from_utf8_lossy(&out.stdout));
            console_text.push_str(&String::from_utf8_lossy(&out.stderr));
            if !out.status.success() {
                break;
            }
        }

        // xelatex writes main.log into -output-directory
        if produced_log.exists() {
            std::fs::copy(&produced_log, &log_path).ok();
        } else if !console_text.is_empty() {
            std::fs::write(&log_path, console_text.as_bytes()).ok();
        }

        let pdf = build_dir.join(format!("{main_stem}.pdf"));
        let ok = last_status.map(|s| s.success()).unwrap_or(false) && pdf.exists();
        let log_text = if produced_log.exists() {
            std::fs::read_to_string(&produced_log).unwrap_or_default()
        } else {
            String::new()
        };
        let issues = if !ok {
            synthesize_failure_issues_for_project(
                project,
                main,
                engine_name,
                last_status.and_then(|s| s.code()),
                &log_text,
                &console_text,
            )
        } else {
            crate::core::log_parser::parse_log_str(&log_text)
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
    fn failure_diagnostics_use_console_when_log_has_no_parseable_error() {
        let issues = synthesize_failure_issues(
            Path::new("q2_en.tex"),
            "xelatex",
            Some(1),
            "This is a stale log with no errors",
            "C:/tmp/q2_en.tex:7: Undefined control sequence.\n! Undefined control sequence.\n",
        );
        assert_eq!(issues[0].file.as_deref(), Some("q2_en.tex"));
        assert_eq!(issues[0].line, Some(7));
        assert!(issues[0]
            .raw
            .as_deref()
            .unwrap()
            .contains("Undefined control sequence"));
    }

    #[test]
    fn failure_diagnostics_mark_empty_engine_output_without_fake_line() {
        let issues = synthesize_failure_issues(Path::new("q2_en.tex"), "xelatex", Some(1), "", "");
        assert_eq!(issues[0].file.as_deref(), Some("q2_en.tex"));
        assert_eq!(issues[0].line, None);
        assert!(issues[0]
            .raw
            .as_deref()
            .unwrap()
            .starts_with(NO_ENGINE_OUTPUT_MARKER));
    }

    #[test]
    fn failure_diagnostics_merge_console_error_when_log_only_has_warning() {
        let issues = synthesize_failure_issues(
            Path::new("q2_en.tex"),
            "xelatex",
            Some(1),
            "Overfull \\hbox (2pt too wide) in paragraph at lines 3--4\n",
            "q2_en.tex:7: Undefined control sequence.\n",
        );

        assert!(issues.iter().any(|issue| issue.severity == Severity::Warning));
        assert!(issues.iter().any(|issue| {
            issue.severity == Severity::Error
                && issue.line == Some(7)
                && issue
                    .raw
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Undefined control sequence")
        }));
    }

    #[test]
    fn failure_diagnostics_normalize_nested_project_path() {
        let root = std::env::temp_dir().join(format!("tb-texlive-normalize-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let project = Project::create(&root, "p").unwrap();
        let nested = project.root.join("chapters").join("intro.tex");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        std::fs::write(&nested, "content").unwrap();
        let console = format!(
            "{}:12: Undefined control sequence.\n",
            nested.to_string_lossy().replace('\\', "/")
        );

        let issues = synthesize_failure_issues_for_project(
            &project,
            Path::new("main.tex"),
            "xelatex",
            Some(1),
            "",
            &console,
        );

        assert_eq!(issues[0].file.as_deref(), Some("chapters/intro.tex"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failure_diagnostics_keep_nested_file_named_like_main() {
        let root = std::env::temp_dir().join(format!("tb-texlive-nested-main-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let project = Project::create(&root, "p").unwrap();
        let nested = project.root.join("chapters").join("main.tex");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        std::fs::write(&nested, "content").unwrap();
        let console = format!(
            "{}:12: Undefined control sequence.\n",
            nested.to_string_lossy().replace('\\', "/")
        );

        let issues = synthesize_failure_issues_for_project(
            &project,
            Path::new("main.tex"),
            "xelatex",
            Some(1),
            "",
            &console,
        );

        assert_eq!(issues[0].file.as_deref(), Some("chapters/main.tex"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failure_diagnostics_replace_external_path_with_main_file() {
        let root = std::env::temp_dir().join(format!("tb-texlive-external-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let project = Project::create(&root, "p").unwrap();

        let issues = synthesize_failure_issues_for_project(
            &project,
            Path::new("main.tex"),
            "xelatex",
            Some(1),
            "",
            "C:/outside/other.tex:4: Undefined control sequence.\n",
        );

        assert_eq!(issues[0].file.as_deref(), Some("main.tex"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failure_diagnostics_clear_zero_line_number() {
        let issues = synthesize_failure_issues(
            Path::new("q2_en.tex"),
            "xelatex",
            Some(1),
            "",
            "q2_en.tex:0: Undefined control sequence.\n",
        );

        assert_eq!(issues[0].line, None);
    }

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
        assert!(result
            .pdf_path
            .as_ref()
            .map(|p| p.exists())
            .unwrap_or(false));
        assert_eq!(result.engine, EngineUsed::SystemTexlive);
    }
}
