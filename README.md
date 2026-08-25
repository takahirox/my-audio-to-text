# my-audio-to-text

Local-first speech-to-text and thought-synthesis system.

The goal is not merely to transcribe speech. The system should let a person speak naturally, preserve what was actually said, remove speech-only noise without changing meaning, and optionally transform the result into polished text or a structured representation of a longer thinking session.

## Product goals

1. **Quick Dictation** — speak for seconds or minutes, get trustworthy text, optionally polish it, and use it in any app.
2. **Thinking Session** — speak freely for tens of minutes or longer, keep the complete transcript, then turn the whole session into a structured model of topics, ideas, decisions, open questions, revisions, and action items.
3. **Local first** — audio, transcription, storage, cleaning, rewriting, and synthesis should work locally by default after models are installed.
4. **Trustworthy transformations** — Raw Transcript, Clean Transcript, Polished Text, and Synthesis are separate layers. Derived output never overwrites source data.
5. **Evidence and reversibility** — important synthesized items should be traceable back to source transcript segments and, when audio is retained, to timestamps.

## V1 direction

V1 targets Apple Silicon macOS first. The preferred initial architecture is a macOS native shell with a portable core, local ASR, local LLM support, durable session storage, global dictation, and a dedicated long-form Thinking Session mode.

For long sessions, V1 deliberately starts with **FULL synthesis**: when the transcript comfortably fits the selected model's context, send the complete Clean Transcript to the LLM rather than prematurely introducing semantic chunking or incremental memory. Add CHUNKED or INCREMENTAL strategies only when measurements show they are needed.

See:

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product behavior, requirements, scope, and acceptance criteria.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architectural direction and design principles.

Implementation is intentionally kept out of `main` until the specification is established.
