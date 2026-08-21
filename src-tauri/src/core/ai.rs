use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 默认模型名（glm 前缀对智谱系端点有效；直连其他家时在偏好里覆盖）
const DEFAULT_MODEL: &str = "glm-5.2";

/// 单次回复上限默认值（桌宠气泡场景，短回复足够）；记忆压缩/做梦日记可传更小的 max_tokens
const DEFAULT_MAX_TOKENS: u32 = 300;

/// 中转返回的 Anthropic Messages 响应（只取用到的字段）
#[derive(Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: String,

    #[serde(default)]
    text: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,

    #[serde(rename = "max_tokens")]
    max_tokens: u32,

    system: String,

    messages: Vec<Value>,
}

/// 调用 Anthropic Messages 协议端点（非流式）完成一次对话。
/// apiUrl 指向本地中转时 key 任意；直连官方端点（如智谱 /api/anthropic、DeepSeek /anthropic）填真实 key。
#[tauri::command]
pub async fn ai_chat(api_url: String, api_key: Option<String>, model: Option<String>, system: String, messages: Vec<Value>, max_tokens: Option<u32>) -> Result<String, String> {
    let base = api_url.trim_end_matches('/');

    let url = format!("{base}/v1/messages");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;

    // 空 key 视为走本地中转（不校验，占位 relay）；直连官方端点必须填真实 key
    let key = api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).unwrap_or_else(|| "relay".to_string());

    let response = client
        .post(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&ChatRequest {
            model: model.as_deref().map(str::trim).filter(|m| !m.is_empty()).unwrap_or(DEFAULT_MODEL),
            max_tokens: max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            system,
            messages,
        })
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        return Err(format!("HTTP {status}: {body}"));
    }

    let parsed: MessagesResponse = response.json().await.map_err(|error| error.to_string())?;

    let text = parsed
        .content
        .into_iter()
        .filter(|block| block.kind == "text")
        .map(|block| block.text)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("empty response".to_string());
    }

    Ok(text)
}
