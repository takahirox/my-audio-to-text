use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EvidenceItem { pub text: String, pub evidence_segment_ids: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Decision { pub text: String, pub rationale: Option<String>, pub evidence_segment_ids: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Revision { pub before: String, pub after: String, pub reason: Option<String>, pub evidence_segment_ids: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionModel {
    pub title: String,
    pub summary: String,
    pub topics: Vec<String>,
    pub ideas: Vec<EvidenceItem>,
    pub decisions: Vec<Decision>,
    pub open_questions: Vec<EvidenceItem>,
    pub action_items: Vec<EvidenceItem>,
    pub revisions: Vec<Revision>,
    pub examples: Vec<EvidenceItem>,
    pub other_notable_points: Vec<EvidenceItem>,
}

pub fn full_synthesis_prompt(transcript: &str) -> String {
    format!("Analyze the complete transcript below. Preserve uncertainty and distinguish ideas, decisions, questions, and revisions. Never add facts absent from the transcript. Every substantive extracted item must cite supporting segment IDs. Return only JSON matching the requested schema.\n\nTRANSCRIPT:\n{}", transcript)
}
