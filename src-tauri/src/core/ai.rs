use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 默认模型名（glm 前缀对智谱系端点有效；直连其他家时在偏好里覆盖）
const DEFAULT_MODEL: &str = "glm-5.2";

/// 单次回复上限默认值（桌宠气泡场景，短回复足够）；记忆压缩/做梦日记可传更小的 max_tokens
const DEFAULT_MAX_TOKENS: u32 = 300;

/// Anthropic Messages 响应（只取用到的字段；content 可能含 text / tool_use 块）
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

    #[serde(default)]
    id: Option<String>,

    #[serde(default)]
    name: Option<String>,

    #[serde(default)]
    input: Option<Value>,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,

    #[serde(rename = "max_tokens")]
    max_tokens: u32,

    system: String,

    messages: Vec<Value>,

    /// Anthropic tools 定义；None 时不序列化（记忆压缩等纯文本调用不感知工具）
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Value>>,
}

/// 返回给前端的对话结果：正文 + 模型自主发起的工具调用
#[derive(Serialize)]
pub struct ChatOutcome {
    pub text: String,

    #[serde(rename = "toolUses")]
    pub tool_uses: Vec<ToolUse>,
}

#[derive(Serialize)]
pub struct ToolUse {
    pub name: String,

    pub input: Value,

    #[serde(skip)]
    id: String,
}

fn parse_content(content: Vec<ContentBlock>) -> (String, Vec<ToolUse>) {
    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_uses: Vec<ToolUse> = Vec::new();

    for block in content {
        match block.kind.as_str() {
            "text" => text_parts.push(block.text),
            "tool_use" => {
                if let Some(name) = block.name {
                    tool_uses.push(ToolUse {
                        name,
                        input: block.input.unwrap_or(Value::Null),
                        id: block.id.unwrap_or_default(),
                    });
                }
            }
            _ => {}
        }
    }

    (text_parts.join("\n").trim().to_string(), tool_uses)
}

/// 调用 Anthropic Messages 协议端点（非流式）完成一次对话，支持工具调用。
/// apiUrl 指向本地中转时 key 任意；直连官方端点（如智谱 /api/anthropic、DeepSeek /anthropic）填真实 key。
/// 历史消息只存纯文本（不带 tool_use），因此无需回传 tool_result，每轮都是干净的 messages。
#[tauri::command]
pub async fn ai_chat(api_url: String, api_key: Option<String>, model: Option<String>, system: String, messages: Vec<Value>, tools: Option<Vec<Value>>, max_tokens: Option<u32>) -> Result<ChatOutcome, String> {
    let base = api_url.trim_end_matches('/');

    let url = format!("{base}/v1/messages");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;

    // 空 key 视为走本地中转（不校验，占位 relay）；直连官方端点必须填真实 key
    let key = api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).unwrap_or_else(|| "relay".to_string());

    let model_name = model.as_deref().map(str::trim).filter(|m| !m.is_empty()).unwrap_or(DEFAULT_MODEL);

    async fn request(client: &reqwest::Client, url: &str, key: &str, model: &str, max_tokens: u32, system: &str, messages: Vec<Value>, tools: Option<Vec<Value>>) -> Result<MessagesResponse, String> {
        let response = client
            .post(url)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&ChatRequest {
                model,
                max_tokens,
                system: system.to_string(),
                messages,
                tools,
            })
            .send()
            .await
            .map_err(|error| error.to_string())?;

        let status = response.status();

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();

            return Err(format!("HTTP {status}: {body}"));
        }

        response.json().await.map_err(|error| error.to_string())
    }

    let limit = max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);

    let parsed = request(&client, &url, &key, model_name, limit, &system, messages.clone(), tools).await?;

    let (mut text, tool_uses) = parse_content(parsed.content);

    // GLM 调工具时常只回 tool_use 不说话（stop_reason=tool_use）：
    // 按协议回传 tool_result 再补一轮要正文（第二轮不带 tools，防止连环调用）
    if text.is_empty() && !tool_uses.is_empty() {
        let assistant_turn: Vec<Value> = tool_uses
            .iter()
            .map(|call| {
                serde_json::json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": call.input,
                })
            })
            .collect();

        let tool_results: Vec<Value> = tool_uses
            .iter()
            .map(|call| {
                serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": call.id,
                    "content": "done",
                })
            })
            .collect();

        let mut followup = messages.clone();

        followup.push(serde_json::json!({ "role": "assistant", "content": assistant_turn }));
        followup.push(serde_json::json!({ "role": "user", "content": tool_results }));

        let second = request(&client, &url, &key, model_name, limit, &system, followup, None).await?;

        text = parse_content(second.content).0;
    }

    Ok(ChatOutcome { text, tool_uses })
}
