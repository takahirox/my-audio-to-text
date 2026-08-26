# V1 Implementation Design

## Decision summary

V1 is implemented as a native Swift/SwiftUI menu-bar application with a UI-independent `AudioTextCore` Swift package, SQLite durability, and process adapters for local `whisper.cpp` and `llama.cpp` executables.

The architecture direction named Rust as a preferred portable-core default. V1 deliberately uses Swift for both shell and core because it removes an FFI boundary from microphone buffers, cancellation, packaging, and error propagation while the contracts are still evolving. The core contains no SwiftUI, AppKit, microphone, clipboard, or global-hotkey code, so a Rust replacement can later be introduced behind the same model/store/backend boundaries. This choice serves the documented priority order: correctness, preservation, trust, simplicity, then performance.

## Component boundaries

```text
MyAudioToTextApp (macOS-only)
  ├─ SwiftUI menu bar, history, settings, Thinking Session window
  ├─ AVAudioEngine capture → 16 kHz mono durable WAV + rolling chunks
  ├─ Option-Space global shortcut
  └─ accessibility paste automation → clipboard fallback
                    │
                    ▼
AudioTextCore (UI-independent)
  ├─ versionable session/transcript/output models
  ├─ partial-tail reducer and conservative cleaner
  ├─ SQLite SessionStore (WAL, synchronous FULL, per-final transaction)
  ├─ whisper.cpp CLI adapter
  ├─ llama.cpp CLI adapter with constrained JSON output
  ├─ FULL synthesis context gate and evidence validator
  └─ deterministic output renderers
```

No shell evaluates model or transcript content. Executables receive fixed argument arrays through `Foundation.Process`; stdout and stderr are drained concurrently and bounded. The child environment is reduced to `PATH`, `HOME`, and `LANG`.

## Recording and transcription

Microphone buffers are converted to 16 kHz mono PCM. Each converted buffer is written first to the continuous session WAV and then to the current rolling chunk. A partial snapshot is transcribed periodically and only replaces the unstable UI tail. A closed chunk is transcribed as final; each non-empty final segment gets a stable UUID, timestamps, speaker, raw text, conservative clean text, optional confidence, and a contiguous ordinal.

The serial ASR pipeline prevents partial and final model invocations from racing. Exact adjacent clean-segment duplicates are suppressed. Partial output is never written to SQLite.

On stop, the recorder closes the current chunk before the pipeline completion fence is installed. Quick Dictation publishes Clean Transcript and performs paste automation only after all final chunks are committed. Thinking Session keeps the transcript usable even when its later LLM step fails.

## Durability and recovery

SQLite uses WAL, foreign keys, a five-second busy timeout, and `synchronous=FULL`. Every final segment is inserted in its own `BEGIN IMMEDIATE` transaction. The database owns four append-oriented record groups:

- sessions;
- final transcript segments;
- structured synthesis revisions;
- independently regenerable derived outputs.

At startup, sessions left in `RECORDING` or `PROCESSING` become `INTERRUPTED`; already committed segments remain available in History. With retention enabled, continuous audio and chunks remain in the session recording directory. With retention disabled, audio exists during processing for resilience and is removed only after the terminal session record is durable.

## Information levels

1. Raw Transcript is the persisted ASR text and authoritative textual evidence.
2. Clean Transcript is stored alongside each segment and may only remove an explicit narrow filler set and exact adjacent repetition.
3. Polished Text is an append-only derived output generated on request.
4. Synthesis is a structured model plus independently rendered JSON, detailed Markdown, and action-list views.

Clean and derived representations never update `raw_text`.

## FULL synthesis and fidelity

The full Clean Transcript is labeled with exact segment UUIDs and sent in a single request. A conservative UTF-8 token estimate must fit within 80% of the configured model context after reserving output tokens. If it does not, V1 returns `contextLimitExceeded`; it never silently chunks, truncates, or drops early speech.

llama.cpp is constrained with a JSON Schema. Decoding then validates that every topic, idea, decision, question, action, revision, example, and notable point cites at least one segment and that every cited UUID exists. Invalid references reject the entire synthesis. Decisions support only optional stated rationale. Revisions preserve `before`, `after`, and an optional stated reason.

## Failure behavior

Priority remains:

```text
audio capture > audio persistence > ASR > transcript persistence > cleaning > rewrite > synthesis
```

- A partial ASR failure is a warning and cannot mutate committed text.
- A final ASR failure marks processing failed while retaining audio (when configured) and all earlier final segments.
- A local LLM failure leaves Raw and Clean Transcript unchanged and usable.
- Invalid synthesis JSON, missing evidence, unknown evidence IDs, empty input, and context overflow fail closed.
- Accessibility denial degrades to clipboard-only output; the text is not lost.

## Future replacement seams

`TranscriptionBackend` and `LocalTextModel` are explicit backend protocols. `FullSynthesisService` is a standalone strategy rather than logic embedded in the UI. Speaker is already `USER`, `AI`, or `OTHER`. These boundaries allow a future Rust core, in-process whisper/llama bindings, CHUNKED strategy, mobile shell, and AI dialogue without changing source provenance semantics.
