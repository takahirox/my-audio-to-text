# my-audio-to-text

Local-first speech-to-text and thought-synthesis application for macOS.

## Product pipeline

`Audio -> Raw transcript -> Clean transcript -> Polished text / Full-session synthesis`

The source transcript is never overwritten by derived AI output. Thinking Sessions are designed for long-form ideation (for example, speaking freely for 30 minutes and turning the result into ideas, decisions, revisions, questions and actions with evidence links back to transcript segments).

## Repository

- `core/` Rust domain core, persistence, whisper CLI adapter, llama-server client and synthesis validation.
- `native/macos/` SwiftUI menu-bar / Thinking Session shell and durable microphone recording.
- `docs/` architecture and V1 acceptance criteria.
- `scripts/bootstrap-local-models.sh` builds whisper.cpp and llama.cpp locally with Metal enabled.

## Build

```bash
cargo test --workspace
swift build --package-path native/macos
```

To build local inference engines:

```bash
bash scripts/bootstrap-local-models.sh
```

Model weights are intentionally not committed. Supply a whisper GGML model to the CLI and a GGUF model to `llama-server`.

## Core CLI

Transcribe an audio file using a local whisper.cpp CLI:

```bash
cargo run -p audio_text_core -- transcribe session.wav \
  --whisper .deps/whisper.cpp/build/bin/whisper-cli \
  --model /path/to/whisper-model.bin > transcript.json
```

Start llama.cpp locally (example):

```bash
.deps/llama.cpp/build/bin/llama-server -m /path/to/model.gguf --port 8080
```

Then synthesize the complete clean transcript:

```bash
cargo run -p audio_text_core -- synthesize transcript.json \
  --server http://127.0.0.1:8080 \
  --model local > session-model.json
```

## V1 principle

For long Thinking Sessions, FULL synthesis is deliberately the default: the complete clean transcript is sent to the selected local LLM when it fits comfortably in context. Chunked/incremental memory should only be introduced after real measurements show it is necessary.

## Current integration status

The Rust inference path and macOS recording shell are present. The remaining integration work is to stream microphone buffers into whisper during recording, wire the Rust runtime directly into the Swift app (instead of the CLI boundary), implement Accessibility-based focused-field insertion, package model management, and validate 30+ minute Japanese sessions on real Apple Silicon hardware. CI builds/tests the Rust and Swift components so these slices can be completed without changing the product model.
