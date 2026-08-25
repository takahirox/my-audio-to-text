# V1 Architecture

## Goal

A local-first macOS application that turns speech into trustworthy, reusable text and supports long-form solo thinking sessions.

## Information levels

1. **Raw Transcript** — ASR output, retained as source evidence.
2. **Clean Transcript** — fillers and obvious recognition repetition only; no semantic rewrite.
3. **Polished Text** — optional intent-preserving rewrite for a destination/profile.
4. **Synthesis** — structured understanding of a complete thinking session.

Derived representations never overwrite their source.

## V1 modes

### Quick Dictation
Global push-to-talk → streaming ASR → final segments → clean → insert/copy, with optional rewrite.

### Thinking Session
Long-running microphone capture → streaming ASR → durable transcript → stop → clean full transcript → FULL synthesis → structured session model → reusable outputs.

## Components

```text
Swift/SwiftUI macOS shell
  ├─ microphone / AVAudioEngine
  ├─ global hotkey + overlay
  ├─ Accessibility / paste / clipboard output
  └─ Thinking Session UI
            │
            ▼ FFI
Rust Core
  ├─ session state machine
  ├─ transcript model
  ├─ conservative cleaner
  ├─ SQLite storage
  ├─ ASR abstraction (whisper.cpp adapter planned)
  ├─ LLM abstraction (llama.cpp adapter planned)
  └─ synthesis orchestration
```

## Source of truth

Audio (when retained) → Raw Transcript → Clean Transcript → derived outputs.

Final transcript segments are committed continuously. A long recording must not depend on successful LLM processing or orderly application shutdown.

## Synthesis strategy

V1 uses `FULL`: send the complete clean transcript to the selected local LLM when it fits comfortably in context. Do not prematurely implement semantic chunking. Keep the strategy boundary open for future `CHUNKED` and `INCREMENTAL` implementations.

The model first produces a structured `SessionModel` rather than a prose artifact. Important extracted claims carry transcript segment IDs as evidence.

## V1 non-goals

Windows/iOS/Android/Web, system-audio capture, AI voice dialogue, live incremental semantic memory, cloud sync, collaboration and accounts.

## Priority

Correctness > data preservation > user trust > simplicity > performance > feature count.
