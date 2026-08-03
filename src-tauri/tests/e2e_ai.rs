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
/// 能在 3 轮内让编译通过。前置断言保护源文件不被误改成"已修复"状态。
#[tokio::test]
#[ignore = "requires real API key + network + tectonic"]
async fn e2e_demo_project_fix_loop() {
    let demo_src = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("assets").join("demo-project").join("main.tex"),
    )
    .unwrap();
    assert!(demo_src.contains("\\undefinedcommand"), "demo 源文件必须含未定义命令（防止被误改）");
    assert!(!demo_src.contains("\\usepackage{xcolor}"), "demo 源文件必须缺 xcolor（防止被误改）");

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

/// E2E: AI 生成大段 LaTeX 代码（真实 API）。
#[tokio::test]
#[ignore = "requires real API key + network"]
async fn e2e_ai_generate_code() {
    let s = ai_settings();
    let code = texbutler_lib::core::ai::chat(
        &s,
        &[
            texbutler_lib::core::ai::ChatMsg { role: "system".into(), content: "你是 TeXButler 代码生成助手。只输出可直接编译的 LaTeX 代码（含 documentclass 到 end），不要解释与围栏。".into() },
            texbutler_lib::core::ai::ChatMsg { role: "user".into(), content: "生成一个含三线表的中文 LaTeX 文档，表格两列三行。".into() },
        ],
    )
    .await
    .expect("AI 调用失败");
    assert!(code.contains("\\documentclass"), "应含 documentclass: {code}");
    assert!(code.contains("tabular") || code.contains("table"), "应含表格: {code}");
    println!("generated {} chars", code.len());
}

/// E2E: Word (.docx) 导入 → 解析 → AI 生成完整 LaTeX（真实 API）。
#[tokio::test]
#[ignore = "requires real API key + network + tectonic"]
async fn e2e_docx_import_generates_latex() {
    let s = ai_settings();
    // build a minimal docx in a temp project
    let root = std::env::temp_dir().join(format!("tb-e2e-docx-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let proj = Project::open(&root).unwrap();
    let docx_path = root.join("input.docx");
    let xml = r#"<w:document><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 简介</w:t></w:r></w:p>
<w:p><w:r><w:t>这是从 Word 导入的段落内容，用于端到端测试。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>准确率</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>95%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>"#;
    let file = std::fs::File::create(&docx_path).unwrap();
    let mut zw = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    zw.start_file("word/document.xml", opts).unwrap();
    use std::io::Write;
    zw.write_all(xml.as_bytes()).unwrap();
    zw.finish().unwrap();

    // parse + AI convert
    let blocks = texbutler_lib::core::docx::parse_docx(&docx_path).expect("parse docx");
    let md = texbutler_lib::core::docx::render_markdown(&blocks);
    assert!(md.contains("第一章 简介"), "markdown: {md}");
    let system = "你是 TeXButler 的 Word 转 LaTeX 助手。把用户提供的文档内容转换成一份完整、可直接编译的中文 LaTeX 文档（ctexart）。只输出 LaTeX 代码（含 documentclass 到 end{document}），不要 Markdown 围栏与解释。标题用 \\section；段落用空行分隔；表格转成 booktabs 风格。";
    let latex = texbutler_lib::core::ai::chat(
        &s,
        &[
            texbutler_lib::core::ai::ChatMsg { role: "system".into(), content: system.into() },
            texbutler_lib::core::ai::ChatMsg { role: "user".into(), content: format!("请把下面从 Word 提取的内容转换为完整 LaTeX 文档：\n\n{md}") },
        ],
    )
    .await
    .expect("AI 调用失败");
    assert!(latex.contains("\\documentclass"), "应含 documentclass: {latex}");
    assert!(latex.contains("\\section") || latex.contains("\\section*"), "应含标题: {latex}");
    // write into project and compile to prove the generated doc works
    proj.write_file("imported.tex", &latex).unwrap();
    let scheduler = CompilerScheduler::new(EnginePreference::SystemTexlive);
    let result = scheduler.compile(&proj, std::path::Path::new("imported.tex"), &|| false);
    assert!(result.ok, "AI 生成的 LaTeX 应可编译: {:?}", result.issues.first().map(|i| i.message.clone()));
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
