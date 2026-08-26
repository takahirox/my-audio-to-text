# my-audio-to-text

Local-first speech-to-text and thought-synthesis for Apple Silicon macOS.

The application implements two workflows:

- **Quick Dictation** — press `⌥Space`, speak, stop, and receive conservatively cleaned text in the focused app or clipboard.
- **Thinking Session** — record a long session, preserve committed transcript segments continuously, then run whole-session FULL synthesis into topics, ideas, decisions, questions, actions, revisions, examples, and detailed notes.

Raw Transcript, Clean Transcript, Polished Text, and Synthesis are stored as separate information levels. Derived output never overwrites its source, and every substantive synthesis item must reference valid source segment IDs.

## Requirements

- Apple Silicon Mac running macOS 14 or newer
- Xcode 16+ command-line tools / Swift 6
- a local [`whisper.cpp`](https://github.com/ggml-org/whisper.cpp) `whisper-cli` executable and multilingual GGML model
- optionally, a local [`llama.cpp`](https://github.com/ggml-org/llama.cpp) `llama-cli` executable and instruct GGUF model for polishing and synthesis

Models are intentionally not bundled. Once the executables and models are installed, the primary workflow does not require a network connection.

## Build and run

```bash
swift test
./scripts/build-app.sh
open "dist/My Audio to Text.app"
```

On first launch:

1. Allow microphone access.
2. Open Settings and select the `whisper-cli` executable and GGML model.
3. Select `llama-cli` and a GGUF instruct model to enable polishing and synthesis.
4. If focused-app paste automation is wanted, allow Accessibility access. Without it, completed text remains safely on the clipboard.

The app stores configuration, SQLite data, and retained recordings under:

```text
~/Library/Application Support/MyAudioToText/
```

## Verification

```bash
./scripts/verify.sh
```

The offline suite covers conservative cleaning, unstable partial replacement, final-segment durability, crash recovery, whisper.cpp JSON parsing, evidence validation, context refusal for oversized FULL synthesis, and regenerating multiple output formats.

See [the implementation design](docs/IMPLEMENTATION.md), [product specification](docs/PRODUCT_SPEC.md), and [acceptance guide](docs/ACCEPTANCE.md).
