use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub confidence: Option<f32>,
}

#[async_trait]
pub trait AsrBackend: Send + Sync {
    async fn transcribe_file(&self, audio_path: &Path, language: &str) -> Result<Vec<AsrSegment>>;
}

#[derive(Debug, Clone)]
pub struct WhisperCliBackend {
    pub binary: PathBuf,
    pub model: PathBuf,
}

impl WhisperCliBackend {
    pub fn new(binary: impl Into<PathBuf>, model: impl Into<PathBuf>) -> Self {
        Self { binary: binary.into(), model: model.into() }
    }
}

#[async_trait]
impl AsrBackend for WhisperCliBackend {
    async fn transcribe_file(&self, audio_path: &Path, language: &str) -> Result<Vec<AsrSegment>> {
        let output = Command::new(&self.binary)
            .arg("-m").arg(&self.model)
            .arg("-f").arg(audio_path)
            .arg("-l").arg(language)
            .arg("-oj")
            .output().await
            .with_context(|| format!("failed to launch whisper CLI: {}", self.binary.display()))?;
        anyhow::ensure!(output.status.success(), "whisper CLI failed: {}", String::from_utf8_lossy(&output.stderr));
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).context("invalid whisper JSON")?;
        let mut segments = Vec::new();
        if let Some(items) = value.get("transcription").and_then(|v| v.as_array()) {
            for item in items {
                let offsets = item.get("offsets").cloned().unwrap_or_default();
                let start_ms = offsets.get("from").and_then(|v| v.as_i64()).unwrap_or(0);
                let end_ms = offsets.get("to").and_then(|v| v.as_i64()).unwrap_or(start_ms);
                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                if !text.is_empty() { segments.push(AsrSegment { start_ms, end_ms, text, confidence: None }); }
            }
        }
        if segments.is_empty() {
            let text = value.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if !text.is_empty() { segments.push(AsrSegment { start_ms: 0, end_ms: 0, text, confidence: None }); }
        }
        Ok(segments)
    }
}
