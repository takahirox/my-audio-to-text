use audio_text_core::{asr::{AsrBackend, WhisperCliBackend}, cleaner::clean_japanese_fillers, llm::OpenAiCompatibleBackend, synthesis::synthesize_full, transcript::{clean_full_text, TranscriptSegment}};
use clap::{Parser, Subcommand};
use std::{collections::HashSet, path::PathBuf};
use uuid::Uuid;

#[derive(Parser)] struct Cli { #[command(subcommand)] command: Commands }
#[derive(Subcommand)] enum Commands {
    Transcribe { audio: PathBuf, #[arg(long)] whisper: PathBuf, #[arg(long)] model: PathBuf, #[arg(long, default_value="ja")] language: String },
    Synthesize { transcript_json: PathBuf, #[arg(long, default_value="http://127.0.0.1:8080")] server: String, #[arg(long, default_value="local")] model: String },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Commands::Transcribe { audio, whisper, model, language } => {
            let backend = WhisperCliBackend::new(whisper, model);
            let asr = backend.transcribe_file(&audio, &language).await?;
            let session_id = Uuid::new_v4();
            let segments: Vec<_> = asr.into_iter().map(|x| { let mut s=TranscriptSegment::new_final(session_id,x.start_ms,x.end_ms,x.text); s.confidence=x.confidence; s.clean_text=Some(clean_japanese_fillers(&s.raw_text)); s }).collect();
            println!("{}", serde_json::to_string_pretty(&segments)?);
        }
        Commands::Synthesize { transcript_json, server, model } => {
            let bytes = std::fs::read(transcript_json)?;
            let segments: Vec<TranscriptSegment> = serde_json::from_slice(&bytes)?;
            let transcript = clean_full_text(&segments);
            let valid: HashSet<String> = segments.iter().map(|s| s.evidence_id()).collect();
            let backend = OpenAiCompatibleBackend::new(server, model);
            let result = synthesize_full(&backend, &transcript, &valid).await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
    }
    Ok(())
}
