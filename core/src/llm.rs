use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationRequest {
    pub system: String,
    pub prompt: String,
    pub json_schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationResponse { pub text: String }

#[async_trait]
pub trait LanguageModelBackend: Send + Sync {
    async fn generate(&self, request: GenerationRequest) -> anyhow::Result<GenerationResponse>;
}

/// Backend for llama.cpp's local OpenAI-compatible `llama-server`.
#[derive(Debug, Clone)]
pub struct OpenAiCompatibleBackend {
    pub base_url: String,
    pub model: String,
    client: reqwest::Client,
}

impl OpenAiCompatibleBackend {
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self { base_url: base_url.into().trim_end_matches('/').to_string(), model: model.into(), client: reqwest::Client::new() }
    }
}

#[async_trait]
impl LanguageModelBackend for OpenAiCompatibleBackend {
    async fn generate(&self, request: GenerationRequest) -> anyhow::Result<GenerationResponse> {
        let mut body = serde_json::json!({
            "model": self.model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.prompt}
            ]
        });
        if let Some(schema) = request.json_schema {
            body["response_format"] = serde_json::json!({"type":"json_schema","json_schema":{"name":"session_model","strict":true,"schema":schema}});
        }
        let response = self.client.post(format!("{}/v1/chat/completions", self.base_url)).json(&body).send().await?.error_for_status()?;
        let value: serde_json::Value = response.json().await?;
        let text = value.pointer("/choices/0/message/content").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("LLM response missing choices[0].message.content"))?;
        Ok(GenerationResponse { text: text.to_string() })
    }
}
