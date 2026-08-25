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
