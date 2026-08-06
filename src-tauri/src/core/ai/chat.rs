//! Free-form conversation with the AI about the current source file.
//! The AI acts as a LaTeX assistant: it can answer questions about the
//! code, point out pitfalls, or explain errors — without touching files.

use super::provider::{AiSettings, ChatMsg, chat};
use crate::core::project::Project;

const SYSTEM_PROMPT: &str = "你是一位经验丰富的 LaTeX 排版助手，正坐在一位作者旁边。\
作者会向你提问（关于代码、错误、排版建议等）。要求：\
1. 回答简洁、直接、可操作，中文回答（除非作者用英文提问）；\
2. 如果涉及修改代码，给出具体的 LaTeX 代码片段，但不要输出 unified diff；\
3. 涉及中文排版时注意：`%` 需转义、中文字体没有真斜体、浮动体用 `[H]` 防漂移；\
4. 不确定时明确说明，不要编造宏包或命令；\
5. 作者可能引用编辑器中的选区（【选区】段），优先针对选区回答。";

/// Ask the AI a free-form question with optional file context and the
/// editor's current selection. The file content (capped) is included when
/// it is a `.tex` file so the answer is grounded in the real source.
pub async fn ask_about_source(
    s: &AiSettings,
    project: &Project,
    file: Option<&str>,
    selection: Option<&str>,
    question: &str,
) -> Result<String, String> {
    let messages = build_messages(project, file, selection, question);
    let reply = chat(s, &messages).await.map_err(|e| e.to_string())?;
    Ok(reply.trim().to_string())
}

/// Streaming variant: each content chunk is handed to `on_delta` as it
/// arrives; returns the full accumulated answer.
pub async fn ask_about_source_stream(
    s: &AiSettings,
    project: &Project,
    file: Option<&str>,
    selection: Option<&str>,
    question: &str,
    on_delta: impl FnMut(&str),
) -> Result<String, String> {
    let messages = build_messages(project, file, selection, question);
    let reply = super::provider::chat_stream(s, &messages, on_delta)
        .await
        .map_err(|e| e.to_string())?;
    Ok(reply.trim().to_string())
}

/// Streaming variant with collaborative editing: the AI answers in plain
/// text, but if its reply contains a unified diff (`--- a/` + `@@`), the
/// diff is applied to the project automatically (snapshot first) and the
/// caller is told about it via `on_edit`. The user compiles, checks, and
/// can roll back with the returned snapshot.
pub async fn ask_about_source_edit_stream(
    s: &AiSettings,
    project: &Project,
    file: Option<&str>,
    selection: Option<&str>,
    question: &str,
    on_delta: impl FnMut(&str),
    mut on_edit: impl FnMut(&str, &str),
) -> Result<String, String> {
    let mut messages = build_messages(project, file, selection, question);
    // project style guide (AI_GUIDE.md) injected into the system prompt
    let guide = super::guide::guide_system_fragment(project);
    // tell the AI it may edit files by emitting a unified diff
    messages.push(ChatMsg {
        role: "system".into(),
        content: format!(
            "\n【协作编辑约定】你可以直接修改代码来帮助作者：\
如果作者的要求涉及改动代码，请在你的回答末尾输出一个 unified diff（格式：`--- a/<file>`、`+++ b/<file>`、`@@` 头、`-`/`+`/空格 前缀行），\
diff 会被自动应用到项目文件（应用前会快照，作者不满意可一键回滚）。\
只输出一个 diff，路径必须是项目内的相对路径；不要输出多个 diff；不需要修改时不要输出 diff。\
**必须只做最小修改**：只 diff 被要求改动的行，其余内容（文档类、宏定义、其他段落）一字不改地保留在上下文中；绝不要重写整个文件。\
diff 输出完后可另起一行以 `解释：` 开头附一段修改说明。{guide}"
        ),
    });
    let reply = super::provider::chat_stream(s, &messages, on_delta)
        .await
        .map_err(|e| e.to_string())?;
    // detect a unified diff in the reply and apply it
    if let Some((diff, summary)) = extract_diff(&reply) {
        let rel = diff_file(&diff).unwrap_or_else(|| file.unwrap_or("main.tex").to_string());
        let rel = project.relative_path(&rel);
        if let Ok(src) = project.read_file(&rel) {
            if let Ok(new_content) = super::fix_loop::apply_unified_diff(&src, &diff) {
                if new_content != src {
                    if let Ok(snap) = super::fix_loop::snapshot(project, &rel, &src) {
                        let snap_s = snap.to_string_lossy().to_string();
                        // write FIRST, then notify: the frontend shows
                        // "applied / roll back" only when the file really changed
                        match project.write_file(&rel, &new_content) {
                            Ok(()) => {
                                on_edit(&rel, &snap_s);
                                return Ok(format!(
                                    "{reply}\n\n✅ 已自动应用修改（{rel}）。编译检查后不满意可在 AI 面板点击“回滚此修改”。\n{summary}"
                                ));
                            }
                            Err(e) => return Err(format!("应用修改失败：{e}")),
                        }
                    }
                }
            }
        }
    }
    Ok(reply.trim().to_string())
}

/// Extract the first unified diff (`--- a/...` ... `@@ ...`) from a reply.
/// Returns (diff_text, explanation_summary). The diff ends at the `解释：`
/// marker or at the first line that is neither a diff line (` `, `+`, `-`,
/// `@@`, `---`, `+++`) nor empty — so trailing markdown prose never bleeds
/// into the diff and gets misapplied.
fn extract_diff(reply: &str) -> Option<(String, String)> {
    let lines: Vec<&str> = reply.lines().collect();
    let start = lines.iter().position(|l| l.starts_with("--- a/"))?;
    let mut end = lines.len();
    let mut summary = String::new();
    for (i, l) in lines.iter().enumerate().skip(start + 1) {
        let t = l.trim();
        if t == "解释：" || t == "Explanation:" || t == "解释:" {
            end = i;
            // collect the explanation lines that follow
            let mut want = false;
            for l2 in lines.iter().skip(i + 1) {
                let t2 = l2.trim();
                if t2.is_empty() {
                    continue;
                }
                if t2.starts_with("- ") {
                    want = true;
                    summary.push_str(t2);
                    summary.push('\n');
                } else if want {
                    break;
                }
            }
            break;
        }
        // a line that is not part of a unified diff ends the diff
        if !l.starts_with(' ') && !l.starts_with('+') && !l.starts_with('-')
            && !l.starts_with("@@") && !l.starts_with("+++") && !t.is_empty()
        {
            end = i;
            break;
        }
    }
    let diff = lines[start..end].join("\n");
    Some((diff, summary))
}

/// The file path from the `+++ b/<file>` header of a diff.
fn diff_file(diff: &str) -> Option<String> {
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("+++ b/") {
            return Some(rest.trim().to_string());
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

fn build_messages(
    project: &Project,
    file: Option<&str>,
    selection: Option<&str>,
    question: &str,
) -> Vec<ChatMsg> {
    let mut user = String::new();
    if let Some(sel) = selection {
        let sel = sel.trim();
        if !sel.is_empty() {
            user.push_str(&format!("【编辑器选区】\n```latex\n{}\n```\n\n", truncate(sel, 4000)));
        }
    }
    if let Some(f) = file {
        if f.ends_with(".tex") {
            if let Ok(content) = project.read_file(&f) {
                user.push_str(&format!(
                    "【当前文件 `{f}` 的内容（前 {} 字符）】\n```latex\n{}\n```\n\n",
                    8000,
                    truncate(&content, 8000)
                ));
            }
        }
    }
    user.push_str(&format!("【问题】\n{question}"));
    let guide = super::guide::guide_system_fragment(project);
    vec![
        ChatMsg {
            role: "system".into(),
            content: format!("{SYSTEM_PROMPT}{guide}"),
        },
        ChatMsg { role: "user".into(), content: user },
    ]
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}\n…（内容过长已截断）")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_caps_long_input() {
        let long = "a".repeat(5000);
        let t = truncate(&long, 100);
        assert!(t.contains("截断"));
        assert!(t.chars().count() < 200);
    }
}
