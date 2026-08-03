//! Real end-to-end AI tests: they compile real .tex files with the bundled
//! tectonic, call the REAL configured AI provider (API key read from
//! `%APPDATA%\texbutler\settings.json`) and exercise diagnose + the full
//! fix loop (diff → apply → recompile → audit).
//!
//! These tests require network + a configured API key, so they are
//! `#[ignore]`d by default. Run manually:
//!   cargo test --test e2e_ai -- --ignored --nocapture

use std::path::PathBuf;

use texbutler_lib::core::ai::{AiDiagnosis, diagnose, fix_loop};
use texbutler_lib::core::compiler::{CompileResult, CompilerScheduler};
use texbutler_lib::core::project::Project;
use texbutler_lib::core::settings::{EnginePreference, Settings};
use texbutler_lib::core::{FixReport, Issue, SourceContext};

fn ai_settings() -> texbutler_lib::core::ai::AiSettings {
    Settings::load().ai
}

fn e2e_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("assets")
        .join("e2e")
}

/// Copy a sample tex into a fresh temp project and compile it with the
/// bundled tectonic (offline cache already warm on dev machines).
fn make_project(sample: &str, tag: &str) -> (Project, CompileResult, Issue) {
    let root = std::env::temp_dir().join(format!("tb-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let src = std::fs::read_to_string(e2e_dir().join(sample)).unwrap();
    std::fs::write(root.join("main.tex"), src).unwrap();
    std::fs::create_dir_all(root.join(".texbutler")).unwrap();

    let proj = Project::open(&root).unwrap();
    let scheduler = CompilerScheduler::new(EnginePreference::Tectonic);
    let result = scheduler.compile(&proj, std::path::Path::new("main.tex"), &|| false);
    assert!(!result.ok, "{sample} 应当编译失败");
    let issue = result.issues.first().cloned().unwrap_or_else(|| {
        Issue::new(texbutler_lib::core::Severity::Error, texbutler_lib::core::IssueKind::CompileError, "无解析出的错误")
    });
    (proj, result, issue)
}

fn ctx_for(proj: &Project, issue: &Issue) -> SourceContext {
    let body = proj.read_file("main.tex").unwrap_or_default();
    SourceContext::around("main.tex", issue.line, &body, 20)
}

/// E2E: AI 诊断真实编译错误（未定义命令）。
#[tokio::test]
#[ignore = "requires real API key + network + tectonic"]
async fn e2e_diagnose_real_error() {
    let s = ai_settings();
    let (proj, _result, issue) = make_project("broken-undefined.tex", "diag");
    let ctx = ctx_for(&proj, &issue);
    let d: AiDiagnosis = diagnose(&issue, &ctx, &s).await;
    println!("diagnosis: {:?}", d.explanation);
    assert!(d.ok, "诊断失败: {:?}", d.error);
    assert!(!d.explanation.trim().is_empty(), "解释为空");
    assert!(!d.suggestion.trim().is_empty(), "建议为空");
    let _ = std::fs::remove_dir_all(proj.root.clone());
}

/// E2E: AI 修复闭环修复未定义命令并编译通过。
#[tokio::test]
#[ignore = "requires real API key + network + tectonic"]
async fn e2e_fix_loop_fixes_undefined_command() {
    let s = ai_settings();
    let (proj, _result, issue) = make_project("broken-undefined.tex", "fix");
    let report: FixReport = fix_loop(&issue, &proj, &s, 3).await;
    println!("fix report: ok={} rounds={} summary={}", report.ok, report.rounds, report.summary);
    assert!(report.ok, "修复应使编译通过: {}", report.summary);
    let _ = std::fs::remove_dir_all(proj.root.clone());
}

/// E2E: AI 修复引用不存在图片的文档——审核机制必须拒绝引入新缺失文件
/// 的 diff（例如把 .png 改成 .pdf），最终失败信息应明确"文件缺失"。
#[tokio::test]
#[ignore = "requires real API key + network + tectonic"]
async fn e2e_fix_loop_refuses_missing_image_extension_swap() {
    let s = ai_settings();
    let (proj, _result, issue) = make_project("missing-image.tex", "img");
    let report: FixReport = fix_loop(&issue, &proj, &s, 3).await;
    println!("fix report: ok={} summary={}", report.ok, report.summary);
    // 图片不存在 → 无法通过 AI 修复编译；最终错误必须明确缺失文件
    assert!(!report.ok, "缺图场景不应被 AI 修好（文件不存在）");
    let summary = report.summary.to_lowercase();
    assert!(
        summary.contains("缺失") || summary.contains("不存在") || summary.contains("missing"),
        "错误信息应指明文件缺失: {}",
        report.summary
    );
    let _ = std::fs::remove_dir_all(proj.root.clone());
}

/// E2E: 演示项目（assets/demo-project）——含预设错误，AI 修复闭环应
/// 能在 3 轮内让编译通过。
#[tokio::test]
#[ignore = "requires real API key + network + tectonic"]
async fn e2e_demo_project_fix_loop() {
    let s = ai_settings();
    let root = std::env::temp_dir().join(format!("tb-e2e-demo-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let src = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("assets").join("demo-project").join("main.tex"))
        .unwrap();
    std::fs::write(root.join("main.tex"), src).unwrap();
    std::fs::create_dir_all(root.join(".texbutler")).unwrap();

    let proj = Project::open(&root).unwrap();
    let scheduler = CompilerScheduler::new(EnginePreference::Tectonic);
    let result = scheduler.compile(&proj, std::path::Path::new("main.tex"), &|| false);
    assert!(!result.ok, "演示项目应编译失败");
    let issue = result.issues.first().cloned().unwrap();

    let report: FixReport = fix_loop(&issue, &proj, &s, 3).await;
    println!("demo fix: ok={} rounds={} summary={}", report.ok, report.rounds, report.summary);
    assert!(report.ok, "AI 修复应让演示项目编译通过: {}", report.summary);
    let _ = std::fs::remove_dir_all(root);
}

/// E2E: 系统引擎兜底路径（MiKTeX xelatex）编译同一份文档。
#[test]
#[ignore = "requires system TeX Live / MiKTeX"]
fn e2e_system_texlive_compile() {
    let root = std::env::temp_dir().join(format!("tb-e2e-xe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let src = std::fs::read_to_string(e2e_dir().join("broken-undefined.tex")).unwrap();
    std::fs::write(root.join("main.tex"), src).unwrap();
    std::fs::create_dir_all(root.join(".texbutler")).unwrap();
    let proj = Project::open(&root).unwrap();
    let scheduler = CompilerScheduler::new(EnginePreference::SystemTexlive);
    let result = scheduler.compile(&proj, std::path::Path::new("main.tex"), &|| false);
    assert!(!result.ok);
    assert_eq!(result.engine, texbutler_lib::core::compiler::EngineUsed::SystemTexlive);
    let _ = std::fs::remove_dir_all(root);
}
