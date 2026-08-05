//! AI providers: OpenAI-compatible (OpenAI/DeepSeek/Qwen/Ollama), and
//! Anthropic (native Messages API). Ollama uses its OpenAI-compatible
//! endpoint (`/v1/chat/completions`) so one code path serves both.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderKind {
    OpenAiCompatible {
        /// e.g. https://api.openai.com/v1 or https://api.deepseek.com/v1
        base_url: String,
    },
    Anthropic {
        /// Optional override; defaults to https://api.anthropic.com
        base_url: Option<String>,
    },
    Ollama {
        /// e.g. http://localhost:11434/v1
        base_url: String,
    },
}

impl ProviderKind {
    pub fn label(&self) -> &'static str {
        match self {
            ProviderKind::OpenAiCompatible { .. } => "OpenAI 兼容",
            ProviderKind::Anthropic { .. } => "Anthropic",
            ProviderKind::Ollama { .. } => "Ollama (本地)",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettings {
    pub provider: ProviderKind,
    pub model: String,
    /// Never logged; only used in request headers.
    pub api_key: Option<String>,
    pub temperature: f32,
    pub max_tokens: u32,
    pub timeout_secs: u64,
    /// Send `thinking: {type: disabled}` (DeepSeek etc.). DeepSeek's default
    /// thinking mode can burn the whole token budget, leaving `content`
    /// empty — see the fix-loop max_tokens bump.
    #[serde(default)]
    pub disable_thinking: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        AiSettings {
            provider: ProviderKind::OpenAiCompatible {
                base_url: "https://api.openai.com/v1".to_string(),
            },
            // GPT-5.6 Luna: cost-effective flagship-line model (2026-08),
            // well suited for error diagnosis workloads.
            model: "gpt-5.6-luna".to_string(),
            api_key: None,
            temperature: 0.2,
            max_tokens: 1024,
            timeout_secs: 60,
            disable_thinking: false,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("AI 未配置: {0}")]
    NotConfigured(String),
    #[error("网络请求失败: {0}")]
    Transport(String),
    #[error("API 返回错误 ({status}): {body}")]
    Api { status: u16, body: String },
    #[error("响应解析失败: {0}")]
    Parse(String),
}

/// One chat message.
#[derive(Debug, Clone, Serialize)]
pub struct ChatMsg {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// Send a chat completion request and return the assistant text.
pub async fn chat(s: &AiSettings, messages: &[ChatMsg]) -> Result<String, AiError> {
    match &s.provider {
        // The `thinking` flag is only sent for plain OpenAI-compatible
        // endpoints (DeepSeek etc.); Ollama-compatible endpoints may reject
        // unknown fields, so the flag is suppressed there.
        ProviderKind::OpenAiCompatible { base_url } => {
            chat_openai_compatible(s, base_url, messages, true).await
        }
        ProviderKind::Ollama { base_url } => chat_openai_compatible(s, base_url, messages, false).await,
        ProviderKind::Anthropic { base_url } => {
            chat_anthropic(s, base_url.as_deref().unwrap_or("https://api.anthropic.com"), messages).await
        }
    }
}

/// Streaming variant of `chat` for OpenAI-compatible endpoints (DeepSeek,
/// Ollama, etc.): `on_delta` is invoked with each content chunk as it
/// arrives. Returns the full accumulated text.
pub async fn chat_stream(
    s: &AiSettings,
    messages: &[ChatMsg],
    mut on_delta: impl FnMut(&str),
) -> Result<String, AiError> {
    let base_url = match &s.provider {
        ProviderKind::OpenAiCompatible { base_url } => base_url.clone(),
        ProviderKind::Ollama { base_url } => base_url.clone(),
        ProviderKind::Anthropic { base_url: _ } => {
            // Anthropic has a different streaming format; fall back to the
            // non-streaming path (still correct, just not token-by-token).
            return chat(s, messages).await;
        }
    };
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut body = build_openai_body(s, messages, true);
    body["stream"] = serde_json::json!(true);
    let mut req = reqwest::Client::new()
        .post(&url)
        // The streaming path must not inherit reqwest's 30s default total
        // timeout (a long answer would be cut off mid-stream). A generous
        // 10-minute cap bounds a silent/hung endpoint; the [DONE] marker
        // and the 8 MiB caps finish well before that in normal operation.
        .timeout(Duration::from_secs(600))
        .json(&body);
    if let Some(key) = &s.api_key {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    let resp = req.send().await.map_err(|e| AiError::Transport(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AiError::Api { status: status.as_u16(), body: truncate(&text, 500) });
    }
    let mut full = String::new();
    let mut stream = resp.bytes_stream();
    use futures::StreamExt;
    let mut buffer: Vec<u8> = Vec::new();
    let mut done = false;
    const MAX_BUFFER: usize = 8 * 1024 * 1024; // guard against a broken endpoint
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AiError::Transport(e.to_string()))?;
        buffer.extend_from_slice(&chunk);
        if buffer.len() > MAX_BUFFER {
            return Err(AiError::Parse("流式响应过大".into()));
        }
        // split on `\n` keeping the remainder for the next chunk
        let mut idx = 0;
        while let Some(nl) = buffer[idx..].iter().position(|b| *b == b'\n') {
            let line_end = idx + nl;
            let line: String = String::from_utf8_lossy(&buffer[idx..line_end]).to_string();
            idx = line_end + 1;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // tolerate both `data: [DONE]` and `data:[DONE]`
            let Some(data) = line
                .strip_prefix("data:")
                .map(|s| s.trim_start().trim_start_matches(" "))
            else {
                continue;
            };
            if data == "[DONE]" {
                done = true;
                break;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                    full.push_str(delta);
                    if full.len() > MAX_BUFFER {
                        return Err(AiError::Parse("流式响应过大".into()));
                    }
                    on_delta(delta);
                }
            }
        }
        buffer.drain(..idx);
        if done {
            break; // [DONE] seen: stop reading immediately
        }
    }
    if full.trim().is_empty() {
        return Err(AiError::Parse("流式响应中没有内容".into()));
    }
    Ok(full)
}

/// Build the OpenAI-compatible request body (unit-testable).
fn build_openai_body(s: &AiSettings, messages: &[ChatMsg], allow_thinking_flag: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": s.model,
        "messages": messages,
        "temperature": s.temperature,
        "max_tokens": s.max_tokens,
    });
    if s.disable_thinking && allow_thinking_flag {
        // DeepSeek & friends: default thinking mode can consume the whole
        // token budget and return an empty `content` (user-visible bug).
        body["thinking"] = serde_json::json!({ "type": "disabled" });
    }
    body
}

async fn chat_openai_compatible(
    s: &AiSettings,
    base_url: &str,
    messages: &[ChatMsg],
    allow_thinking_flag: bool,
) -> Result<String, AiError> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let body = build_openai_body(s, messages, allow_thinking_flag);
    let mut req = reqwest::Client::new()
        .post(&url)
        .timeout(Duration::from_secs(s.timeout_secs))
        .json(&body);
    if let Some(key) = &s.api_key {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    let resp = req.send().await.map_err(|e| AiError::Transport(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| AiError::Transport(e.to_string()))?;
    if !status.is_success() {
        return Err(AiError::Api { status: status.as_u16(), body: truncate(&text, 500) });
    }
    let parsed: OpenAiResponse =
        serde_json::from_str(&text).map_err(|e| AiError::Parse(format!("{e}: {}", truncate(&text, 300))))?;
    let choice = parsed
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| AiError::Parse("响应中没有 choices".into()))?;
    match choice.message.content {
        Some(content) if !content.trim().is_empty() => Ok(content),
        _ => {
            // Empty content: DeepSeek's thinking mode commonly exhausts
            // max_tokens before producing any visible output.
            let why = match choice.finish_reason.as_deref() {
                Some("length") => format!(
                    "模型在思考阶段就耗尽了 max_tokens（当前 {}），未产生可见输出。请调大 max_tokens（AI 修复会自动使用 ≥4096）或开启“关闭思考模式”。",
                    s.max_tokens
                ),
                _ => "模型返回了空内容。请检查模型名与 API Key 是否有效。".to_string(),
            };
            Err(AiError::Parse(why))
        }
    }
}

async fn chat_anthropic(
    s: &AiSettings,
    base_url: &str,
    messages: &[ChatMsg],
) -> Result<String, AiError> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let system: Vec<&str> = messages.iter().filter(|m| m.role == "system").map(|m| m.content.as_str()).collect();
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let body = serde_json::json!({
        "model": s.model,
        "system": system.join("\n"),
        "messages": msgs,
        "max_tokens": s.max_tokens,
        "temperature": s.temperature,
    });
    let key = s.api_key.clone().ok_or_else(|| AiError::NotConfigured("Anthropic 需要 api_key".into()))?;
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(Duration::from_secs(s.timeout_secs))
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| AiError::Transport(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| AiError::Transport(e.to_string()))?;
    if !status.is_success() {
        return Err(AiError::Api { status: status.as_u16(), body: truncate(&text, 500) });
    }
    let parsed: AnthropicResponse =
        serde_json::from_str(&text).map_err(|e| AiError::Parse(e.to_string()))?;
    let content = parsed
        .content
        .into_iter()
        .find(|b| b.type_ == "text")
        .map(|b| b.text)
        .ok_or_else(|| AiError::Parse("响应中没有 text 块".into()))?;
    Ok(content)
}

fn truncate(s: &str, max: usize) -> String {
    // truncate at a char boundary (byte slicing into a multi-byte UTF-8
    // sequence would panic; API response bodies are untrusted input)
    match s.char_indices().nth(max) {
        Some((idx, _)) => format!("{}…(截断)", &s[..idx]),
        None => s.to_string(),
    }
}

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicBlock>,
}

#[derive(Debug, Deserialize)]
struct AnthropicBlock {
    #[serde(rename = "type")]
    type_: String,
    text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_response_parses() {
        let json = r#"{"choices":[{"message":{"content":"你好"}}]}"#;
        let parsed: OpenAiResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.choices[0].message.content.as_deref(), Some("你好"));
        assert_eq!(parsed.choices[0].finish_reason, None);
    }

    #[test]
    fn openai_response_parses_finish_reason() {
        // DeepSeek thinking-mode truncation: empty content + length reason
        let json = r#"{"choices":[{"message":{"content":""},"finish_reason":"length"}]}"#;
        let parsed: OpenAiResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.choices[0].message.content.as_deref(), Some(""));
        assert_eq!(parsed.choices[0].finish_reason.as_deref(), Some("length"));
    }

    fn test_settings(disable_thinking: bool) -> AiSettings {
        AiSettings {
            disable_thinking,
            ..Default::default()
        }
    }

    #[test]
    fn thinking_flag_only_injected_when_enabled_and_allowed() {
        let msgs = [ChatMsg { role: "user".into(), content: "hi".into() }];
        // enabled + allowed → injected
        let body = build_openai_body(&test_settings(true), &msgs, true);
        assert_eq!(body["thinking"], serde_json::json!({ "type": "disabled" }));
        // enabled but not allowed (Ollama) → NOT injected
        let body = build_openai_body(&test_settings(true), &msgs, false);
        assert!(body.get("thinking").is_none());
        // disabled → NOT injected
        let body = build_openai_body(&test_settings(false), &msgs, true);
        assert!(body.get("thinking").is_none());
        // base fields still present
        assert_eq!(body["model"], "gpt-5.6-luna");
    }

    #[test]
    fn anthropic_response_parses() {
        let json = r#"{"content":[{"type":"text","text":"解释"}]}"#;
        let parsed: AnthropicResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.content[0].text, "解释");
    }
}
