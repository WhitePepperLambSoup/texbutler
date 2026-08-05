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
    vec![
        ChatMsg { role: "system".into(), content: SYSTEM_PROMPT.to_string() },
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
