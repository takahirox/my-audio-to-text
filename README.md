# my-audio-to-text

A local-first speech input system that turns natural speech into useful text and learns to recognize each individual user better over time.

## Motivation and current status

Speech input should work well for the person using it, including their language, vocabulary, pronunciation, and speaking conditions. Corrections should help improve future recognition while keeping the original speech and transcript available.

This repository is a minimal product and vision baseline, ready for a new design from first principles. The previous macOS prototype, experiments, evaluation harnesses, and implementation documents have been removed from the active tree. All previous work remains recoverable from Git history.

There is no production application implementation in this baseline. The disposable [browser Speech-to-Text playground](docs/asr-manual-testing.md) compares Moonshine Voice, sherpa-onnx/ReazonSpeech, and Whisper for Japanese manual testing. No production backend is selected. Backward compatibility with the prototype's APIs, storage, configuration, architecture, or platform behavior is not a requirement.

## Web playground

Target public URL: [https://takahirox.github.io/my-audio-to-text/](https://takahirox.github.io/my-audio-to-text/).

The playground replaces the static placeholder from [#15](https://github.com/takahirox/my-audio-to-text/issues/15)
with three disposable ASR PoCs for [#18](https://github.com/takahirox/my-audio-to-text/issues/18).
Publication and real-device validation remain pending in
[#17](https://github.com/takahirox/my-audio-to-text/issues/17).
See the [manual-testing instructions](docs/asr-manual-testing.md) for local setup,
model limitations, and the manual-results template.

The [Pages workflow](.github/workflows/pages.yml) prepares pinned runtime assets
and deploys the contents of `web/`
after every push or merge to `main`. It can also be run manually from the Actions
tab with `main` selected. Inference runs in the browser; no ASR server is required.

For repository setup, select **Settings → Pages → Build and deployment → Source →
GitHub Actions**. Deployment uses the `github-pages` environment and the built-in
`GITHUB_TOKEN`; no additional secret is needed. The deployment's environment URL
in Actions reports the canonical Pages URL.

Outstanding live validation tracked in Issue #17:

- [ ] Confirm the Pages workflow succeeds on `main`.
- [ ] Confirm the public URL is reachable over HTTPS.
- [ ] Confirm the published playground renders in a desktop browser.
- [ ] Open the same published URL from a mobile browser; local mobile viewport
  emulation does not verify live mobile access.
- [ ] After a subsequent change to `web/index.html` reaches `main`, confirm the
  next deployment succeeds and the updated content appears at the same URL.

Record both deployment run URLs and commit SHAs, the HTTPS result, desktop and
mobile browser/device details, and the updated content seen after redeployment
in Issue #17 before closing that follow-up. Local rendering and mobile viewport
emulation do not complete these live checks.

## Vision

Build a speech input system that:

1. Turns natural speech into useful text.
2. Becomes better at recognizing the individual user over time.
3. Preserves source audio and original transcripts separately from derived or corrected output; derived output never overwrites its source.
4. Can eventually work across Web, desktop, and mobile, without being tied to macOS.

## Near-term priorities

### 1. Speech-to-Text

- Realtime, low-latency recognition.
- Good Japanese recognition.
- Usable from mobile and desktop browsers.

### 2. Personalized ASR

Personalized automatic speech recognition (ASR) should:

- Learn from user corrections.
- Improve recognition of personal vocabulary, pronunciation, recurring mistakes, and quiet speech, eventually extending to whisper speech.
- Demonstrate improvement on held-out real audio that was not used for personalization.

## Deferred priority

**Speech → Thought / synthesis** remains part of the broader vision. It comes after robust Web Speech-to-Text and Personalized ASR, rather than being the next implementation priority.

## Design principles

- Local-first where practical.
- Web-first for the next development cycle, with a path to desktop and mobile beyond the Web.
- Keep models and runtimes replaceable; the vision does not depend on Whisper, llama.cpp, Swift, or any specific model or runtime.
- Measure accuracy, latency, memory, CPU/GPU usage, battery impact, and personalization learning curves.
- Prefer a small, understandable baseline over historical implementation complexity.

## Follow-up work

Separate issues should define and implement:

- Web/PWA foundation.
- Browser microphone and audio pipeline.
- Web ASR technology evaluation, including sherpa-onnx/WASM and alternatives.
- Personalized ASR data and feedback loop.
- Cross-platform product contracts.

## Contributing

See the [development flow](docs/development-flow.md) for workflow and language policy, and the [review guidelines](docs/review-guidelines.md) for review and merge criteria.
