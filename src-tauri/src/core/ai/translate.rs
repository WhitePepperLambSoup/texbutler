//! AI translation that preserves the LaTeX structure: the model is asked to
//! keep every command/environment/label/reference intact and translate only
//! the prose. The selection-level UX lives in the editor (Monaco undo makes
//! a separate rollback step unnecessary).

use super::provider::{chat, AiSettings, ChatMsg};

const SYSTEM_PROMPT: &str = "你是 LaTeX 文档翻译助手。把用户给出的 LaTeX 片段翻译成指定目标语言。硬性要求：
1. 保留全部 LaTeX 结构不变：命令名、环境、\\label{...}、\\ref{...}、\\cite{...}、$...$ 与 \\[...\\] 内的公式代码一律不译；
2. 只翻译正文文字（章节标题、句子、表格单元格）；
3. 直接输出译文 LaTeX，不要任何解释、前言或代码块围栏。";

/// Translate a LaTeX snippet to `target` (e.g. "中文", "English").
pub async fn translate(text: &str, target: &str, s: &AiSettings) -> Result<String, String> {
    let user = format!("目标语言：{target}\n\n待翻译的 LaTeX：\n{text}");
    let messages = vec![
        ChatMsg { role: "system".into(), content: SYSTEM_PROMPT.to_string() },
        ChatMsg { role: "user".into(), content: user },
    ];
    match chat(s, &messages).await {
        Ok(text) => Ok(text.trim().to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_demands_structure_preservation() {
        assert!(SYSTEM_PROMPT.contains("\\ref"));
        assert!(SYSTEM_PROMPT.contains("\\cite"));
        assert!(SYSTEM_PROMPT.contains("公式"));
    }
}
