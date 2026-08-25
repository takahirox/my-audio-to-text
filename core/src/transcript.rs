use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Speaker { User, Ai, Other }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TranscriptStatus { Partial, Final }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: Uuid, pub session_id: Uuid, pub start_ms: i64, pub end_ms: i64, pub speaker: Speaker,
    pub raw_text: String, pub clean_text: Option<String>, pub confidence: Option<f32>, pub status: TranscriptStatus,
}
impl TranscriptSegment {
    pub fn new_final(session_id: Uuid, start_ms: i64, end_ms: i64, raw_text: impl Into<String>) -> Self {
        Self { id: Uuid::new_v4(), session_id, start_ms, end_ms, speaker: Speaker::User, raw_text: raw_text.into(), clean_text: None, confidence: None, status: TranscriptStatus::Final }
    }
    pub fn evidence_id(&self) -> String { format!("seg_{}", self.id.simple()) }
}

pub fn clean_full_text(segments: &[TranscriptSegment]) -> String {
    segments.iter().filter(|s| s.status == TranscriptStatus::Final).map(|s| format!("[{}] {}", s.evidence_id(), s.clean_text.as_deref().unwrap_or(&s.raw_text))).collect::<Vec<_>>().join("\n")
}
