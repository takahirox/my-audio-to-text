# Architecture Direction

## Goal

Build a local-first system that turns speech into trustworthy, reusable text and supports long-form solo thinking sessions. The architecture should eventually support desktop, mobile, and web surfaces without making the first macOS implementation unnecessarily complex.

## Information levels

1. **Raw Transcript** — ASR output retained as source evidence.
2. **Clean Transcript** — fillers, speech-only noise, and obvious recognition repetition removed conservatively; no semantic rewrite.
3. **Polished Text** — optional intent-preserving rewrite for a destination or writing profile.
4. **Synthesis** — structured understanding of a complete thinking session.

Derived representations never overwrite their source.

## V1 modes

### Quick Dictation

Global push-to-talk → realtime ASR → final transcript segments → Clean Transcript → insert/copy, with optional polishing.

### Thinking Session

Long-running microphone capture → realtime ASR → durable transcript → stop → complete Clean Transcript → FULL synthesis → structured Session Model → reusable outputs.

## Preferred component boundary

```text
macOS native application
  ├─ microphone capture
  ├─ global hotkey / overlay
  ├─ focused-app text output
  └─ Thinking Session UI
            │
            ▼
Portable Core
  ├─ session state
  ├─ transcript model
  ├─ conservative cleaning
  ├─ durable storage
  ├─ ASR backend abstraction
  ├─ LLM backend abstraction
  └─ synthesis orchestration
```

The current preferred implementation direction is Swift/SwiftUI for macOS-specific UI and OS integration, Rust for the portable core, whisper.cpp-class local ASR, llama.cpp-class local LLM inference, and SQLite for durable metadata. These are design defaults rather than immutable requirements; a materially better implementation may change them with an explicit rationale.

## Source of truth

When audio retention is enabled:

`Audio → Raw Transcript → Clean Transcript → Derived Outputs`

Raw Transcript is the authoritative textual record. Final transcript segments should be persisted continuously. A long recording must not depend on successful LLM processing or orderly application shutdown.

## Realtime transcript model

ASR output must distinguish unstable partial recognition from committed final transcript. Revisions to a partial result must not create duplicate final segments.

Final segments should retain at least:

- stable segment ID
- session ID
- start/end timestamp
- speaker (`USER`, with future `AI` / `OTHER` support)
- raw text
- clean text
- recognition confidence when available
- final/partial status

## Cleaning boundary

Clean Transcript is deliberately not a rewrite. It may remove fillers, meaningless false starts, and obvious ASR duplication, but must preserve claims, uncertainty, ordering, and meaning. Context-sensitive words must not be removed merely because they can sometimes be fillers.

## Synthesis strategy

V1 uses `FULL`: send the complete Clean Transcript to the selected local LLM when it fits comfortably in context.

Do not prematurely implement semantic chunking. Keep a strategy boundary open for future:

- `FULL` — V1 default
- `CHUNKED` — fallback for context/resource limits
- `INCREMENTAL` — future live session memory

The model should first produce a structured `SessionModel` rather than immediately producing a prose artifact. Important extracted claims carry source transcript segment IDs as evidence.

## Structured Session Model

At minimum:

- title
- summary
- topics
- ideas
- decisions and rationale
- open questions
- action items
- revisions (`before → after`, with reason when stated)
- examples
- other notable points

Ideas, decisions, revisions, questions, and actions should remain semantically distinct. A later change of mind should not silently erase the earlier position.

## Future AI dialogue

AI voice dialogue is not a V1 requirement, but the transcript model should support multiple speakers from the beginning. Future synthesis should distinguish user-originated ideas from AI suggestions, adopted AI suggestions, rejected suggestions, and ideas produced by the user in response to AI questioning.

## Failure and scheduling priority

`Audio capture > audio persistence > ASR > transcript persistence > cleaning > rewrite > synthesis`

LLM latency or failure must never stop or corrupt recording. Long sessions should be recoverable after a crash with at most a small recent loss window.

## V1 non-goals

- Windows / iOS / Android / Web clients
- system-audio capture
- AI voice dialogue
- live incremental semantic memory
- cloud sync
- collaboration
- account system

These should remain architecturally possible without being implemented prematurely.

## Engineering priority

`Correctness > Data preservation > User trust > Simplicity > Performance > Feature count`
