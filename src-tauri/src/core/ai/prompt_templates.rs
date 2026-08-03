//! Chinese-language prompt templates for the AI layer.
//! The AI must answer concisely (<=150 chars), give concrete fixes and
//! admit uncertainty — never fabricate.

pub const SYSTEM_PROMPT: &str = "你是 TeXButler 内置的 LaTeX 编译错误诊断助手，面向中文用户。\
规则：1) 解释必须简体中文、简洁（核心解释不超过 150 字）；\
2) 必须给出具体的修改方向（改哪个文件哪一行附近、加什么宏包、替换成什么）；\
3) 不确定时明确说“不确定”，不要编造；\
4) 回复优先输出一个 JSON 对象：{\"explanation\": \"人话解释\", \"suggestion\": \"具体修复建议\", \"confidence\": \"high|medium|low\"}，\
不要输出 JSON 以外的解释（除非确实无法用 JSON 表达）。";

/// Build the user prompt for a diagnosis request.
pub fn diagnose_prompt(issue: &crate::core::Issue, ctx: &crate::core::SourceContext) -> String {
    format!(
        "请诊断下面的 LaTeX 编译错误。\n\n\
【错误信息（原文）】\n{}\n\n\
【出错文件】{}（第 {} 行）\n\
【局部源码上下文（前后各最多 20 行）】\n```\n{}\n```\n\n\
要求：解释错误原因，并给出具体、可验证的修复建议（指出修改位置与替换内容）。",
        issue.raw.as_deref().unwrap_or(&issue.message),
        ctx.file,
        ctx.line.map(|l| l.to_string()).unwrap_or_else(|| "未知".into()),
        ctx.render(),
    )
}

/// Build the user prompt for the fix loop: ask for a unified diff.
/// `project_files` is a listing of files present in the project root (the AI
/// must NOT reference files that do not exist — e.g. it once suggested
/// switching an image to `.pdf` although no such file existed).
/// `full_source` (round ≥ 2, small files) gives the AI the complete current
/// file so it stops hallucinating line numbers/context (observed with
/// DeepSeek on multi-error documents).
pub fn fix_prompt(
    issue: &crate::core::Issue,
    ctx: &crate::core::SourceContext,
    round: u32,
    previous_attempt: Option<&str>,
    project_files: &[String],
    full_source: Option<&str>,
) -> String {
    let mut p = format!(
        "请修复下面的 LaTeX 编译错误。只输出一个统一 diff（unified diff 文本，含 `---`/`+++`/`@@` 头），\
不要输出任何解释或 Markdown 代码围栏。diff 的文件路径必须是 `{}`。\n\
要求：只做能消除该错误的最小改动，不要改动不相关的行，不要引入新的结构。\n\n\
【错误信息（原文）】\n{}\n\n\
【局部源码上下文】\n```\n{}\n```\n",
        ctx.file,
        issue.raw.as_deref().unwrap_or(&issue.message),
        ctx.render(),
    );
    if round > 1 {
        p.push_str(&format!(
            "\n这是第 {round} 轮尝试。之前的修改没有解决问题，这是上一轮的错误状态（如果与原始错误相同则忽略）：\n{prev}\n",
            prev = previous_attempt.unwrap_or("（无）"),
        ));
        // Full file helps the AI align line numbers exactly.
        if let Some(src) = full_source {
            p.push_str(&format!(
                "\n【文件当前完整内容（含行号，diff 的行号必须与之一致）】\n```\n{}\n```\n",
                numbered(src)
            ));
        }
    }
    // Project file inventory: the AI must only reference files that exist.
    if !project_files.is_empty() {
        p.push_str(&format!(
            "\n【项目根目录下的文件清单（严禁引用不存在的文件；`\\includegraphics`/`\\input`/`\\include` 只能使用清单中的文件）】\n{}\n",
            project_files.join("\n")
        ));
    } else {
        p.push_str("\n【注意】项目中没有可引用的图片/子文件。如果错误与图片有关（如 `File not found` / `Unable to load picture`），不要试图改成其他扩展名或文件名——请直接输出一个空 diff 或说明“文件缺失，无法修复”。");
    }
    p.push_str("\n记住：\n1. 只输出 unified diff 文本；\n2. 保持文件其余部分不变；\n3. 修改必须能真正消除该错误（注意中文 LaTeX 的坑：`%` 要转义、中文字体无斜体、表格单元格内不要用 `\\textbf{...&...}`）。");
    p.push_str("\n针对特定错误类型的处理约定：\n- `Undefined control sequence`（未定义命令）：删除该命令所在行，或把该命令替换为已定义的等价命令；**不允许把该行原样保留（删除行与新增行内容相同等于没有修改）**。\n- 缺少宏包（如 xcolor）：在导言区添加 `\\usepackage{...}` 一行。\n- 文件缺失/图片无法读取：不要修改引用，直接输出说明。");
    p
}

/// Render source lines with 1-based line numbers.
fn numbered(src: &str) -> String {
    src.lines()
        .enumerate()
        .map(|(i, l)| format!("{:4} | {}", i + 1, l))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{Issue, IssueKind, Severity};

    #[test]
    fn diagnose_prompt_contains_context() {
        let issue = Issue::new(Severity::Error, IssueKind::CompileError, "测试错误").with_raw("! Undefined control sequence");
        let ctx = crate::core::SourceContext::around("main.tex", Some(3), "a\nb\n\\foo\nc", 2);
        let p = diagnose_prompt(&issue, &ctx);
        assert!(p.contains("main.tex"));
        assert!(p.contains("Undefined control sequence"));
        assert!(p.contains("\\foo"));
    }

    #[test]
    fn fix_prompt_asks_for_diff_only() {
        let issue = Issue::new(Severity::Error, IssueKind::CompileError, "x");
        let ctx = crate::core::SourceContext::around("main.tex", Some(1), "\\foo", 2);
        let p = fix_prompt(&issue, &ctx, 1, None, &["main.tex".to_string()], None);
        assert!(p.contains("unified diff"));
        assert!(p.contains("---"));
        assert!(p.contains("文件清单"));
    }

    #[test]
    fn fix_prompt_includes_full_source_on_later_rounds() {
        let issue = Issue::new(Severity::Error, IssueKind::CompileError, "x");
        let ctx = crate::core::SourceContext::around("main.tex", Some(1), "\\foo", 2);
        let p = fix_prompt(&issue, &ctx, 2, Some("上一轮失败"), &[], Some("\\documentclass{article}\n正文\n"));
        assert!(p.contains("文件当前完整内容"));
        assert!(p.contains("1 | \\documentclass{article}"));
        assert!(p.contains("2 | 正文"));
    }

    #[test]
    fn fix_prompt_warns_when_no_files() {
        let issue = Issue::new(Severity::Error, IssueKind::CompileError, "x");
        let ctx = crate::core::SourceContext::around("main.tex", Some(1), "\\foo", 2);
        let p = fix_prompt(&issue, &ctx, 1, None, &[], None);
        assert!(p.contains("文件缺失，无法修复"));
    }
}
