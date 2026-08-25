use crate::llm::{GenerationRequest, LanguageModelBackend};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

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
    format!("Analyze the COMPLETE transcript. Preserve uncertainty. Distinguish tentative ideas from decisions, open questions, action items, examples, and explicit revisions. Later statements may revise earlier ones: record that as a revision instead of silently replacing history. Do not invent facts, reasons, decisions, or certainty. Every substantive item must cite one or more segment IDs exactly as provided. Return JSON only.\n\nTRANSCRIPT:\n{}", transcript)
}

pub fn session_model_schema() -> serde_json::Value {
    let evidence = serde_json::json!({"type":"object","properties":{"text":{"type":"string"},"evidence_segment_ids":{"type":"array","items":{"type":"string"}}},"required":["text","evidence_segment_ids"],"additionalProperties":false});
    serde_json::json!({
      "type":"object",
      "properties":{
        "title":{"type":"string"}, "summary":{"type":"string"}, "topics":{"type":"array","items":{"type":"string"}},
        "ideas":{"type":"array","items":evidence.clone()},
        "decisions":{"type":"array","items":{"type":"object","properties":{"text":{"type":"string"},"rationale":{"type":["string","null"]},"evidence_segment_ids":{"type":"array","items":{"type":"string"}}},"required":["text","rationale","evidence_segment_ids"],"additionalProperties":false}},
        "open_questions":{"type":"array","items":evidence.clone()}, "action_items":{"type":"array","items":evidence.clone()},
        "revisions":{"type":"array","items":{"type":"object","properties":{"before":{"type":"string"},"after":{"type":"string"},"reason":{"type":["string","null"]},"evidence_segment_ids":{"type":"array","items":{"type":"string"}}},"required":["before","after","reason","evidence_segment_ids"],"additionalProperties":false}},
        "examples":{"type":"array","items":evidence.clone()}, "other_notable_points":{"type":"array","items":evidence}
      },
      "required":["title","summary","topics","ideas","decisions","open_questions","action_items","revisions","examples","other_notable_points"], "additionalProperties":false
    })
}

pub async fn synthesize_full(backend: &dyn LanguageModelBackend, transcript: &str, valid_segment_ids: &HashSet<String>) -> anyhow::Result<SessionModel> {
    let response = backend.generate(GenerationRequest { system: "You are a faithful thought-structure extractor. Evidence fidelity is more important than elegance.".into(), prompt: full_synthesis_prompt(transcript), json_schema: Some(session_model_schema()) }).await?;
    let model: SessionModel = serde_json::from_str(&response.text)?;
    validate_evidence(&model, valid_segment_ids)?;
    Ok(model)
}

pub fn validate_evidence(model: &SessionModel, valid: &HashSet<String>) -> anyhow::Result<()> {
    let mut ids: Vec<&String> = Vec::new();
    for x in model.ideas.iter().chain(&model.open_questions).chain(&model.action_items).chain(&model.examples).chain(&model.other_notable_points) { ids.extend(&x.evidence_segment_ids); }
    for x in &model.decisions { ids.extend(&x.evidence_segment_ids); }
    for x in &model.revisions { ids.extend(&x.evidence_segment_ids); }
    for id in ids { anyhow::ensure!(valid.contains(id), "synthesis cited unknown segment id: {id}"); }
    Ok(())
}
