use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 中转侧模型名（glm 前缀走智谱，实测 1s 出稿、人设质量最佳）
const MODEL: &str = "glm-5.2";

/// 单次回复上限（桌宠气泡场景，短回复足够）
const MAX_TOKENS: u32 = 300;

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
struct ChatRequest {
    model: &'static str,

    #[serde(rename = "max_tokens")]
    max_tokens: u32,

    system: String,

    messages: Vec<Value>,
}

/// 调用本地 API 中转（Anthropic Messages 协议，非流式）完成一次对话。
/// 中转自带上游鉴权，任意 x-api-key 即可通过。
#[tauri::command]
pub async fn ai_chat(api_url: String, system: String, messages: Vec<Value>) -> Result<String, String> {
    let base = api_url.trim_end_matches('/');

    let url = format!("{base}/v1/messages");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;

    let response = client
        .post(&url)
        .header("x-api-key", "relay")
        .header("anthropic-version", "2023-06-01")
        .json(&ChatRequest {
            model: MODEL,
            max_tokens: MAX_TOKENS,
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
