//! AI diagnosis: turn an opaque LaTeX error into plain Chinese with a
//! verifiable fix suggestion. Sends only the error block + a local source
//! window (never the whole file) — security rule from the design doc.

use super::prompt_templates;
use super::provider::{AiSettings, ChatMsg, chat};
use crate::core::{Issue, SourceContext};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDiagnosis {
    pub ok: bool,
    /// Plain-Chinese explanation (<=150 chars as prompted).
    pub explanation: String,
    /// Concrete fix direction (may be empty when the AI is unsure).
    pub suggestion: String,
    /// Confidence: "high" | "medium" | "low".
    pub confidence: String,
    /// Raw assistant reply (debugging / UI "查看原文").
    pub raw: Option<String>,
    /// Error message when ok=false.
    pub error: Option<String>,
}

/// Diagnose one compile issue with local context.
pub async fn diagnose(
    issue: &Issue,
    ctx: &SourceContext,
    s: &AiSettings,
    guide: &str,
) -> AiDiagnosis {
    let system = prompt_templates::diagnose_system_prompt(guide);
    let user = prompt_templates::diagnose_prompt(issue, ctx);
    let messages = vec![
        ChatMsg { role: "system".into(), content: system.to_string() },
        ChatMsg { role: "user".into(), content: user },
    ];
    match chat(s, &messages).await {
        Ok(text) => {
            let cleaned = text.trim().to_string();
            match parse_json_diagnosis(&cleaned) {
                Some(d) => AiDiagnosis {
                    ok: true,
                    explanation: d.explanation.unwrap_or_default(),
                    suggestion: d.suggestion.unwrap_or_default(),
                    confidence: d.confidence.unwrap_or_else(|| "medium".into()),
                    raw: Some(cleaned.clone()),
                    error: None,
                },
                None => AiDiagnosis {
                    ok: true,
                    explanation: cleaned.clone(),
                    suggestion: String::new(),
                    confidence: "medium".into(),
                    raw: Some(cleaned),
                    error: None,
                },
            }
        }
        Err(e) => AiDiagnosis {
            ok: false,
            explanation: String::new(),
            suggestion: String::new(),
            confidence: "low".into(),
            raw: None,
            error: Some(e.to_string()),
        },
    }
}

#[derive(Debug, Deserialize)]
struct JsonDiagnosis {
    explanation: Option<String>,
    suggestion: Option<String>,
    confidence: Option<String>,
}

/// Try to extract the JSON object the prompt asks the model to return.
fn parse_json_diagnosis(text: &str) -> Option<JsonDiagnosis> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    let candidate = &text[start..=end];
    serde_json::from_str::<JsonDiagnosis>(candidate).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_wrapped_in_markdown() {
        let text = "好的，分析如下：\n```json\n{\"explanation\":\"缺少右花括号\",\"suggestion\":\"补上 }\"}\n```";
        let d = parse_json_diagnosis(text).unwrap();
        assert_eq!(d.explanation.as_deref(), Some("缺少右花括号"));
        assert_eq!(d.suggestion.as_deref(), Some("补上 }"));
    }

    #[test]
    fn context_window_bounds() {
        let body = (1..=100).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let ctx = SourceContext::around("main.tex", Some(50), &body, 20);
        assert_eq!(ctx.before.len(), 20);
        assert_eq!(ctx.focus.as_deref(), Some("line 50"));
        assert_eq!(ctx.after.len(), 20);
        assert!(ctx.render().contains("line 50"));
    }
}
